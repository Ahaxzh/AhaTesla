// push-p1-wiring.test.mjs — P1 b/c/d 生产端接线回归:
// trip_end FIFO 批次明细 / charging_start 电量+预估 / charging_done 同站均价对比+提前中止。
import { test } from "node:test";
import assert from "node:assert/strict";
import { useMemoryStore } from "../src/core/state.mjs";
import { enrichTripEndEvent, enrichChargingStartEvent, enrichChargingDoneEvent } from "../src/core/event-enrichment.mjs";

function fakeDb(routes) {
  const match = (sql) => {
    const r = routes.find((r) => r.when(sql));
    if (!r) throw new Error(`no fake handler for: ${String(sql).slice(0, 60)}`);
    return typeof r.rows === "function" ? r.rows(sql) : r.rows;
  };
  return {
    query: async (sql) => match(sql),
    queryOne: async (sql) => match(sql)[0] ?? null
  };
}

const driveRow = {
  id: 1, start_date: "2026-10-18T09:00:00", distance_km: 30, duration_min: 40,
  temp_avg: 25, power_max_kw: 60,
  start_address_id: null, end_address_id: null, start_geofence_id: 1, end_geofence_id: 1,
  efficiency: 150, ideal_used_km: 40, rated_used_km: 40, // 150 Wh/km × 40km = 6 kWh
  start_ideal_range_km: null, end_ideal_range_km: null,
  start_rated_range_km: null, end_rated_range_km: null,
  start_lat: 24.6, start_lng: 118.04, end_lat: 24.61, end_lng: 118.05,
  avg_speed: 40, max_speed: 80, idle_ratio: 0.05, min_temp: 24,
  fl: 3.0, fr: 3.0, rl: 3.1, rr: 3.1
};

const sessionsForTrip = [
  { id: 9, charge_energy_added: 4.1, geofence_id: 1, geofence_name: "家庭充电桩", geofence_cost_per_unit: 0.3, geofence_session_fee: 0, start_date: "2026-10-17T20:00:00", end_date: "2026-10-17T23:30:00" },
  { id: 10, charge_energy_added: 2.0, geofence_id: 2, geofence_name: "超充", geofence_cost_per_unit: 0.92, geofence_session_fee: 0, start_date: "2026-10-17T10:00:00", end_date: "2026-10-17T11:00:00" }
];

// 回放账本所需的最小 fake 路由（水位查询走 catch → [] → 不缓存，每次现算）
const ledgerRoutes = [
  { when: (s) => s.includes("ideal_used_km"), rows: [driveRow] }, // 回放分页取行程（轻量列查询）
  { when: (s) => s.includes("FROM cars"), rows: [{ id: 1, efficiency: 150 }] }
];

const enrichState = { pricing: { defaultRateCnyPerKwh: 0.6, history: [] }, fuelBaseline: { literPer100km: 8, fuelPriceCnyPerL: 8.2 } };

test("P1-b enrichTripEndEvent:FIFO 批次聚合到地点粒度 + 能耗/电费/省钱数字;无计价参数则省略字段", async () => {
  useMemoryStore();
  const db = fakeDb([
    { when: (s) => s.includes("WHERE d.id = ANY"), rows: [driveRow] },
    { when: (s) => s.includes("FROM geofences"), rows: [{ id: 1, name: "HOME", lat: 24.6, lng: 118.04, radius: 192 }] },
    { when: (s) => s.includes("FROM addresses a") && s.includes("ANY"), rows: [] },
    { when: (s) => s.includes("FROM charging_processes cp"), rows: sessionsForTrip },
    ...ledgerRoutes,
    { when: () => true, rows: [] } // nearestAddr 等兜底
  ]);
  const ev = await enrichTripEndEvent(db, { segment_ids: [1] }, { state: enrichState });
  assert.ok(Array.isArray(ev.fifoBatches) && ev.fifoBatches.length === 2, `应聚合 2 批,实际 ${JSON.stringify(ev.fifoBatches)}`);
  const bySrc = Object.fromEntries(ev.fifoBatches.map((b) => [b.source, b]));
  // FIFO 按可用时间先扣超充批次(当日 11:00 结算),余下从家充批次扣:6 = 2.0 + 4.0
  assert.deepEqual(bySrc["超充"], { source: "超充", kwh: 2, price: 0.92 });
  assert.deepEqual(bySrc["家庭充电桩"], { source: "家庭充电桩", kwh: 4, price: 0.3 });
  // M9 修复：能耗/电费/省钱此前从未被填充（模板有字段、富化层不产出）
  assert.equal(ev.energyKwh, 6);
  assert.equal(ev.costCny, 2 * 0.92 + 4 * 0.3); // 3.04
  assert.equal(ev.savedCny, 16.64); // 油车 30×0.656=19.68 - 3.04
  assert.equal(ev.kwhPer100km, 20); // 6 / 30 × 100

  // 不传计价参数(兼容旧调用)→ 不带字段
  const ev2 = await enrichTripEndEvent(db, { segment_ids: [1] });
  assert.equal(ev2.fifoBatches, undefined);
});

test("P1-b 富化失败不抛:批次查询炸 → 事件照常返回(无 fifoBatches)", async () => {
  useMemoryStore();
  const db = fakeDb([
    { when: (s) => s.includes("WHERE d.id = ANY"), rows: [driveRow] },
    { when: (s) => s.includes("FROM geofences"), rows: [] },
    { when: (s) => s.includes("FROM addresses a") && s.includes("ANY"), rows: [] },
    { when: (s) => s.includes("FROM charging_processes cp"), rows: null, whenNot: true, throw: true },
    { when: () => true, rows: [] }
  ]);
  // 直接把该路由改为抛错
  db.query = async (sql) => {
    if (String(sql).includes("FROM charging_processes cp")) throw new Error("db down");
    for (const r of [
      { when: (s) => s.includes("WHERE d.id = ANY"), rows: [driveRow] },
      { when: () => true, rows: [] }
    ]) { if (r.when(sql)) return r.rows; }
    throw new Error("no handler");
  };
  const ev = await enrichTripEndEvent(db, { segment_ids: [1] }, { state: enrichState });
  assert.equal(ev.fifoBatches, undefined);
  assert.equal(ev.distanceKm, 30);
});

test("P1-c enrichChargingStartEvent:电量+同站外推预估;历史<2 次省略预估", async () => {
  useMemoryStore();
  const mk = (pastRows) => fakeDb([
    { when: (s) => s.includes("cp.geofence_id, cp.car_id, g.name AS location_name"), rows: [{ geofence_id: 1, location_name: "超充站", cost_per_unit: 1.8 }] },
    { when: (s) => s.includes("p.battery_level"), rows: [{ bl: 23.4 }] },
    { when: (s) => s.includes("cp.id <> $2"), rows: pastRows },
    { when: () => true, rows: [] }
  ]);
  const ev = await enrichChargingStartEvent(mk([
    { kwh: 30, dur: 40 }, { kwh: 40, dur: 40 }, { kwh: 50, dur: 40 }
  ]), { charging_process_id: 20 });
  assert.equal(ev.locationName, "超充站");
  assert.equal(ev.batteryPct, 23);
  assert.equal(ev.estimate, "预计 40 分钟 · ¥72");

  const thin = await enrichChargingStartEvent(mk([{ kwh: 30, dur: 40 }]), { charging_process_id: 21 });
  assert.equal(thin.estimate, undefined, "历史不足 2 次不硬造预估");
});

test("P1-d enrichChargingDoneEvent:同站均价对比 + end<80 置提前中止 + 能耗费用", async () => {
  useMemoryStore();
  const doneRow = {
    end_battery_level: 72, added: 20, geofence_id: 1,
    start_date: "2026-10-18T10:00:00", end_date: "2026-10-18T10:40:00", cost: null,
    geofence_name: "超充站", geofence_cost_per_unit: 1.8, geofence_session_fee: 0, temp_c: 30
  };
  const db = fakeDb([
    { when: (s) => s.includes("AS added"), rows: [doneRow] },
    { when: (s) => s.includes("FROM charging_processes cp"), rows: [
      // 历史同站(不同期单价 1.5)+一次他站会话(应排除)+本次(id 20,过滤)
      { id: 11, geofence_id: 1, charge_energy_added: 10, geofence_cost_per_unit: 1.5, geofence_session_fee: 0, end_date: "2026-10-01T10:00:00" },
      { id: 12, geofence_id: 1, charge_energy_added: 12, geofence_cost_per_unit: 1.5, geofence_session_fee: 0, end_date: "2026-10-05T10:00:00" },
      { id: 13, geofence_id: 9, charge_energy_added: 30, geofence_cost_per_unit: 0.4, geofence_session_fee: 0, end_date: "2026-10-06T10:00:00" },
      { id: 20, geofence_id: 1, charge_energy_added: 20, geofence_cost_per_unit: 1.8, geofence_session_fee: 0, end_date: "2026-10-18T10:40:00" }
    ] },
    { when: () => true, rows: [] }
  ]);
  const ev = await enrichChargingDoneEvent(db, { charging_process_id: 20 }, { state: enrichState });
  assert.equal(ev.endedEarly, true, "止于 72% < 80");
  assert.equal(ev.endBattery, 72);
  assert.equal(ev.priceCmpPct, 20, "本次 1.8 vs 近 5 次同站均价 1.5 → +20%");
  // M9 修复：充入/费用数字此前从未被填充
  assert.equal(ev.energyKwh, 20);
  assert.equal(ev.costCny, 36); // 20 kWh × 围栏价 1.8

  // 充满场景:≥80 不标中止
  const db2 = fakeDb([
    { when: (s) => s.includes("cp.end_battery_level"), rows: [{ ...doneRow, end_battery_level: 90 }] },
    { when: () => true, rows: [] }
  ]);
  const ev2 = await enrichChargingDoneEvent(db2, { charging_process_id: 20 }, { state: enrichState });
  assert.equal(ev2.endedEarly, undefined);
});
