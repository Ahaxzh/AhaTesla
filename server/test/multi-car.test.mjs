// multi-car.test.mjs — m4e 多车数据层贯通回归：
// carId 过滤契约（SQL/参数形状）、FIFO 跨车不混池、报表按车聚合、demo 双车。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getCars, listDrivesSql, listCharging, listChargingForStats, getDriveByIdSql,
  getMonthStats,
} from "../src/core/teslamate-queries.mjs";
import { batchesFromChargingSessions, allocateDriveCosts } from "../src/core/pricing-ledger.mjs";
import { buildReport } from "../src/core/report-engine.mjs";
import { buildDemoDataset, createDemoDb } from "../src/core/demo-data.mjs";
import { TripMonitor } from "../src/core/trip-monitor.mjs";

function captureDb(reply = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) { calls.push({ sql: String(sql), params }); return reply.rows ?? []; },
    async queryOne(sql, params) { calls.push({ sql: String(sql), params }); return reply.row ?? null; },
  };
}

test("getCars：车辆清单（车切换器契约）", async () => {
  const db = captureDb({ rows: [{ id: 1, name: "M3" }, { id: 2, name: "MY" }] });
  const cars = await getCars(db);
  assert.equal(cars.length, 2);
  assert.ok(db.calls[0].sql.includes("FROM cars c"));
});

test("listDrivesSql：carId 过滤契约 — $1 占位 + LIMIT/OFFSET 顺延", () => {
  const noCar = listDrivesSql({});
  assert.deepEqual(noCar.params, [null]);
  assert.ok(noCar.sql.includes("($1::int IS NULL OR d.car_id = $1::int)"));
  assert.ok(noCar.sql.includes("LIMIT $2 OFFSET $3"));
  const withCar = listDrivesSql({ carId: 5 });
  assert.deepEqual(withCar.params, [5]);
});

test("充电查询：carId 参数随行 — list [limit,offset,carId] / stats [carId]", async () => {
  const dbList = captureDb({ rows: [] });
  await listCharging(dbList, { limit: 10, offset: 3, carId: 7 });
  assert.deepEqual(dbList.calls[0].params, [10, 3, 7]);
  assert.ok(dbList.calls[0].sql.includes("($3::int IS NULL OR cp.car_id = $3::int)"));

  const dbStats = captureDb({ rows: [] });
  await listChargingForStats(dbStats, { sinceIso: null, carId: 2 });
  assert.deepEqual(dbStats.calls[0].params, [2]);

  const dbNull = captureDb({ rows: [] });
  await listChargingForStats(dbNull, {});
  assert.deepEqual(dbNull.calls[0].params, [null]);
});

test("getMonthStats/getDriveByIdSql：可选 carId 过滤", async () => {
  const dbM = captureDb({ row: { distance_km: 1 } });
  await getMonthStats(dbM, "2026-10-01T00:00:00Z", 3);
  assert.deepEqual(dbM.calls[0].params, [3]);

  const dbD = captureDb({ rows: [] });
  await getDriveByIdSql(dbD, 42, 9);
  assert.deepEqual(dbD.calls[0].params, [42, 9]);
  assert.ok(dbD.calls[0].sql.includes("($2::int IS NULL OR d.car_id = $2::int)"));
});

const T0 = Date.parse("2026-10-10T00:00:00Z");
const session = (id, carId, kwh, rate, endOffsetH) => ({
  id, car_id: carId, charge_energy_added: kwh,
  geofence_cost_per_unit: rate, geofence_session_fee: 0,
  start_at: new Date(T0 - 7200_000 + endOffsetH * 3600_000).toISOString(),
  end_at: new Date(T0 - 3600_000 + endOffsetH * 3600_000).toISOString(),
});

test("FIFO 分池：A 车批次只抵 A 车行程，跨车不吃、池余不串", () => {
  const batches = batchesFromChargingSessions([
    session(101, 1, 10, 0.3, 0),  // A 车家充 10kWh@0.30
    session(102, 2, 10, 1.8, 0),  // B 车超充 10kWh@1.80
  ]);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((b) => b.car_id).sort(), [1, 2]);

  const { allocations, remaining_batches } = allocateDriveCosts({
    drives: [
      { id: 1, car_id: 1, start_at: new Date(T0).toISOString(), estimated_kwh: 8 },
      { id: 2, car_id: 2, start_at: new Date(T0 + 60_000).toISOString(), estimated_kwh: 8 },
    ],
    batches,
    defaultRate: 1.0,
  });
  const byDrive = Object.fromEntries(allocations.map((a) => [a.drive_id, a]));
  assert.equal(byDrive[1].batch_kwh, 8);           // A 车吃 A 池
  assert.equal(byDrive[1].cost_cny, 2.4);          // 8 × 0.30
  assert.equal(byDrive[2].batch_kwh, 8);           // B 车吃 B 池
  assert.equal(byDrive[2].cost_cny, 14.4);         // 8 × 1.80，绝不吃 A 的便宜电
  const rem = Object.fromEntries(remaining_batches.map((b) => [b.batch_id, b]));
  assert.equal(rem["cp-101"].remaining_kwh, 2);
  assert.equal(rem["cp-102"].remaining_kwh, 2);
});

test("FIFO 兼容：无 car_id 数据仍单池互通（存量行为零变化）", () => {
  const batches = batchesFromChargingSessions([session(1, undefined, 10, 0.3, 0)]);
  const { allocations } = allocateDriveCosts({
    drives: [{ id: 9, start_at: new Date(T0).toISOString(), estimated_kwh: 6 }],
    batches,
    defaultRate: 1.0,
  });
  assert.equal(allocations[0].batch_kwh, 6);
  assert.equal(allocations[0].cost_cny, 1.8);
});

test("buildReport：carId 透传到行程/充电查询，报告带 carId", async () => {
  const seen = [];
  const deps = {
    db: {
      async query(sql, params) {
        seen.push({ sql: String(sql), params });
        return [];
      },
      async queryOne() { return null; },
    },
    state: { pricing: { defaultRateCnyPerKwh: 0.5, history: [] }, fuelBaseline: {} },
    computeTripViews: async (_db, rows) => rows.map((r) => ({ id: r.id, distanceKm: 0, energyKWh: 0, costCny: 0 })),
    listDrivesSql,
    listChargingForStats,
    carId: 2,
    carName: "Model Y",
  };
  const report = await buildReport({ kind: "weekly", deps });
  const drivesCall = seen.find((c) => c.sql.includes("WITH matched AS"));
  assert.equal(drivesCall.params[0], 2);
  const statsCall = seen.find((c) => c.sql.includes("cp.end_date ASC"));
  assert.equal(statsCall.params[0], 2);
  assert.equal(report.carId, 2);
  assert.equal(report.carName, "Model Y");
});

test("demo 双车：数据集/清单/按车查询", async () => {
  const dataset = buildDemoDataset();
  assert.equal(dataset.cars.length, 2);
  assert.ok(dataset.drives.some((d) => d.car_id === 2));
  assert.ok(dataset.charges.some((c) => c.car_id === 2));

  const db = createDemoDb();
  const cars = await db.query("SELECT c.id, c.name FROM cars c ORDER BY c.display_priority ASC NULLS LAST, c.id ASC");
  assert.equal(cars.length, 2);

  const { sql, params } = listDrivesSql({ carId: 2 });
  const rows = await db.query(sql, [...params, 200, 0]);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.car_id === 2));

  const all = await db.query(...(() => { const q = listDrivesSql({}); return [q.sql, [...q.params, 500, 0]]; })());
  assert.ok(all.length > rows.length, "不过滤时含两车行程");
});

// ---- H1 回归：FIFO 全量回放（fifo-ledger） ------------------------------------
// 修复前每个调用点只喂"当前页/单条"行程对着满额批次池抽电 —— 第二趟行程
// 仍按最老批次计价，账本闭包失效。修复后所有路径走同一次全量回放。

test("H1 getFifoLedger：晚近行程按已被历史扣减后的批次计价（D2 抽 C2 而非 C1）", async () => {
  // 批次 1.5 kWh/个 = 单趟行程耗电（10km 理想续航 × 0.15 kWh/km）→ 首趟即耗尽首批
  const charging = [
    { id: 1, car_id: 1, start_date: "2026-01-01 10:00", end_date: "2026-01-01 11:00", charge_energy_added: 1.5, cost: 10, geofence_id: null },
    { id: 2, car_id: 1, start_date: "2026-02-01 10:00", end_date: "2026-02-01 11:00", charge_energy_added: 1.5, cost: 20, geofence_id: null }
  ];
  const drives = [
    { id: 101, car_id: 1, start_at: "2026-01-02 08:00", end_at: "2026-01-02 08:30", distance_km: 40, duration_min: 30, efficiency: 150, ideal_used_km: 10, rated_used_km: 10 },
    { id: 102, car_id: 1, start_at: "2026-02-02 08:00", end_at: "2026-02-02 08:30", distance_km: 40, duration_min: 30, efficiency: 150, ideal_used_km: 10, rated_used_km: 10 }
  ];
  const db = {
    query: async (sql) => {
      const s = String(sql);
      if (s.includes("ideal_used_km")) return drives;
      if (s.includes("FROM charging_processes cp")) return charging;
      if (s.includes("FROM cars")) return [{ id: 1, efficiency: 150 }];
      if (s.includes("FROM geofences")) return [];
      if (s.includes("max(end_date)") && s.includes("FROM drives")) return [{ max_id: 102, max_end: "2026-02-02 08:30" }];
      if (s.includes("max(end_date)")) return [{ max_id: 2, max_end: "2026-02-01 11:00" }];
      return [];
    },
    queryOne: async (sql) => (await db.query(sql))[0] ?? null
  };
  const { getFifoLedger, clearFifoLedgerCache } = await import("../src/core/fifo-ledger.mjs");
  clearFifoLedgerCache();
  const ledger = await getFifoLedger(db, { pricing: { defaultRateCnyPerKwh: 1, history: [] } }, 1);
  const d1 = ledger.byDriveId.get("101");
  const d2 = ledger.byDriveId.get("102");
  assert.equal(d1.cost_cny, 10); // D1 抽 C1：10kWh × ¥1/kWh
  assert.equal(d2.cost_cny, 20); // D2 必须抽 C2（¥2/kWh）—— 修复前会再抽 C1 报 ¥10
});

test("H1 跨车回放互不干扰：B 轴推进不推高 A 的计价", async () => {
  const charging = [
    { id: 1, car_id: 1, start_date: "2026-01-01 10:00", end_date: "2026-01-01 11:00", charge_energy_added: 1.5, cost: 10, geofence_id: null },
    { id: 2, car_id: 2, start_date: "2026-01-01 12:00", end_date: "2026-01-01 13:00", charge_energy_added: 1.5, cost: 30, geofence_id: null }
  ];
  const drives = [
    { id: 201, car_id: 2, start_at: "2026-01-01 11:30", end_at: "2026-01-01 12:00", distance_km: 40, duration_min: 30, efficiency: 150, ideal_used_km: 10, rated_used_km: 10 },
    { id: 202, car_id: 1, start_at: "2026-01-02 08:00", end_at: "2026-01-02 08:30", distance_km: 40, duration_min: 30, efficiency: 150, ideal_used_km: 10, rated_used_km: 10 }
  ];
  const db = {
    query: async (sql) => {
      const s = String(sql);
      if (s.includes("ideal_used_km")) return drives;
      if (s.includes("FROM charging_processes cp")) return charging;
      if (s.includes("FROM cars")) return [{ id: 1, efficiency: 150 }, { id: 2, efficiency: 150 }];
      if (s.includes("FROM geofences")) return [];
      if (s.includes("max(end_date)") && s.includes("FROM drives")) return [{ max_id: 202, max_end: "2026-01-02 08:30" }];
      if (s.includes("max(end_date)")) return [{ max_id: 2, max_end: "2026-01-01 13:00" }];
      return [];
    },
    queryOne: async (sql) => (await db.query(sql))[0] ?? null
  };
  const { getFifoLedger, clearFifoLedgerCache } = await import("../src/core/fifo-ledger.mjs");
  clearFifoLedgerCache();
  const ledger = await getFifoLedger(db, { pricing: { defaultRateCnyPerKwh: 1, history: [] } }, 1);
  assert.equal(ledger.byDriveId.get("202").cost_cny, 10); // A 车 202 抽 A 池 C1（¥1/kWh）
});

// ---- H4 回归：监视器按车分会话/游标 -------------------------------------------

test("H4 多车乱序结算：B 车新行程不得推高 A 车游标，A 晚结算仍发 trip_end", () => {
  const events = [];
  const monitor = new TripMonitor({ onEvent: (e) => events.push(e) });
  monitor.reconcile({ completed: [], actives: [], max_drive_id: 100, latest_charging_id: 500, latest_charging_done_id: 500 }, "t0");

  // 真实交错：水线 100 之上，B 车（101）先结算、A 车（103）晚结算
  // （id ≤ 水线的行生产中不会进增量查询 —— id 游标只向前扫）
  monitor.reconcile({ completed: [{ id: 101, car_id: 2, start_at: "2026-10-10 10:00", end_at: "2026-10-10 10:20" }], actives: [] }, "t1");
  monitor.reconcile({ completed: [{ id: 103, car_id: 1, start_at: "2026-10-10 09:00", end_at: "2026-10-10 09:30" }], actives: [] }, "t2");

  // 两车各自 30 分钟闲置超时 → 两个独立 trip_end（此前全局会话会合并成 1 个）
  const t3 = "2026-10-10 23:00";
  monitor.reconcile({ completed: [], actives: [] }, t3);
  const tripEnds = events.filter((e) => e.type === "trip_end");
  assert.equal(tripEnds.length, 2, `应有两车各自 trip_end，实际 ${tripEnds.length}`);
  assert.ok(tripEnds.some((e) => e.segment_ids.includes(103)));
  assert.ok(tripEnds.some((e) => e.segment_ids.includes(101)));
});

test("H4 多车并发驾驶互不合并：短间隔跨车行程产出独立会话", () => {
  const events = [];
  const monitor = new TripMonitor({ onEvent: (e) => events.push(e) });
  monitor.reconcile({ completed: [], actives: [], max_drive_id: 0, latest_charging_id: 0, latest_charging_done_id: 0 }, "t0");
  // A 车 10:00 停；B 车 10:10-10:20 开（间隔 10 分钟 < 30 分钟闲置阈值）
  monitor.reconcile({ completed: [{ id: 1, car_id: 1, start_at: "2026-10-10 09:30", end_at: "2026-10-10 10:00" }], actives: [] }, "t1");
  monitor.reconcile({ completed: [{ id: 2, car_id: 2, start_at: "2026-10-10 10:10", end_at: "2026-10-10 10:20" }], actives: [] }, "t2");
  monitor.reconcile({ completed: [], actives: [] }, "2026-10-10 23:00");
  const tripEnds = events.filter((e) => e.type === "trip_end");
  assert.equal(tripEnds.length, 2, `两车各自成会话（修复前合并为 1），实际 ${tripEnds.length}`);
});

test("H4 多车充电乱序结算：B 的 done 不得吞掉 A 的晚结算充电", () => {
  const events = [];
  const monitor = new TripMonitor({ onEvent: (e) => events.push(e) });
  monitor.reconcile({ completed: [], actives: [], max_drive_id: 0, latest_charging_id: 600, latest_charging_done_id: 600 }, "t0");

  // 真实交错：水线 600 之上，B(601) 先结算、A(602) 晚结算
  monitor.reconcileChargingClosed([{ id: 601, car_id: 2, start_at: "2026-10-10 12:00", end_at: "2026-10-10 13:00" }], "t1");
  monitor.reconcileChargingClosed([{ id: 602, car_id: 1, start_at: "2026-10-10 11:00", end_at: "2026-10-10 11:30" }], "t2");

  const dones = events.filter((e) => e.type === "charging_done");
  assert.equal(dones.length, 2, `A(602) 与 B(601) 各自 charging_done，实际 ${dones.length}`);
});

// ---- B1 回归：null 桶水线不得钉死增量查询起点（游标饥饿） ----------------------
// init 把全局 max id 灌进所有桶（含 null）；真实数据恒带 car_id → null 桶永不
// 前进。若增量查询取全桶 min，起点永久钉在初始水线 → 水线后第 51 条起饿死。
test("B1 游标饥饿：50 条窗口外的新行程仍被发现（incrementalSnapshot min 排除 null 桶）", async () => {
  const { TripMonitor, __testIncrementalSnapshot } = await import("../src/core/trip-monitor.mjs");
  const events = [];
  const monitor = new TripMonitor({ onEvent: (e) => events.push(e) });
  monitor.reconcile({ completed: [], actives: [], max_drive_id: 1000, latest_charging_id: 500, latest_charging_done_id: 500 }, "t0");
  assert.equal(monitor.state.drive_cursors.null, 1000); // 水线灌入 null 桶（不回放）

  // 造 60 条水线之后的完成行程（LIMIT 50 一帧装不下）
  const rows = Array.from({ length: 60 }, (_, i) => ({
    id: 1001 + i, car_id: 1, start_at: `2026-10-${String((i % 28) + 1).padStart(2, "0")} 08:00`, end_at: `2026-10-${String((i % 28) + 1).padStart(2, "0")} 08:30`
  }));
  let fetched = null;
  const db = {
    query: async (sql, params) => {
      const s = String(sql);
      if (s.includes("FROM drives d") && s.includes("d.id > $1")) {
        fetched = { since: Number(params[0]) || 0 };
        return rows.filter((r) => r.id > (Number(params[0]) || 0)).slice(0, 50);
      }
      if (s.includes("end_date IS NULL")) return [];
      if (s.includes("charging_processes") && s.includes("cp.id > $1")) return [];
      return [];
    }
  };
  // 逐帧轮询直到不再有新行（模拟真实 30s 循环多帧）
  for (let frame = 0; frame < 5; frame++) {
    const snap = await __testIncrementalSnapshot(db, monitor);
    monitor.reconcile({ ...snap, actives: snap.actives }, `t${frame + 1}`);
    if (snap.completed.length === 0) break;
  }
  const seen = monitor.state.drive_cursors["1"];
  assert.equal(seen, 1060, `车 1 的游标应推进到 1060（60 条全部吸收），实际 ${seen}`);
  assert.ok((fetched?.since ?? 0) > 1000, `增量起点必须越过初始水线 1000（B1 修复前被 null 桶钉死），实际 ${fetched?.since}`);
});

// ---- 游标两难回归：饿死(B1) vs 历史重放(事故) 必须同时防住 ---------------------
// 有效游标 = max(本桶, 无主桶底线)。两个方向各钉一条:
//   重放: v1 迁移态(底线只在 null 桶,车桶为空/落后) → 增量起点必须是底线,
//         绝不能归零重放历史(生产事故:历史充电被当新事件推送数百条)
//   饿死: 底线钉死而车桶已前进 → 起点必须跟上车桶,新行不能取不到
test("游标防重放:迁移态(底线仅在 null 桶)增量起点=底线,历史行不产生任何事件", async () => {
  const { TripMonitor, __testIncrementalSnapshot } = await import("../src/core/trip-monitor.mjs");
  const events = [];
  // 模拟 v1 迁移:全局水线在 null 桶,车 1 桶为空(生产事故形态),历史行 id < 底线
  const monitor = new TripMonitor({
    state: { version: 1, initialized: true, last_charging_id: 494, last_charging_done_id: 493, session: null },
    onEvent: (e) => events.push(e)
  });
  assert.equal(monitor.state.charge_cursors.null, 494); // 迁移落底线
  let queriedSince = null;
  const db = {
    query: async (sql, params) => {
      const s = String(sql);
      if (s.includes("charging_processes") && s.includes("cp.id > $1")) {
        queriedSince = Number(params[0]) || 0;
        return []; // 生产库里此处会返回历史行 —— 只要起点=494,就一行都不会被当增量
      }
      if (s.includes("FROM drives d") && s.includes("d.id > $1")) { queriedSince = Number(params[0]) || 0; return []; }
      return [];
    }
  };
  const snap = await __testIncrementalSnapshot(db, monitor);
  monitor.reconcile({ ...snap, actives: [] }, "t1");
  assert.ok(queriedSince >= 493, `增量起点必须 ≥ 底线 493,实际 ${queriedSince}(0 = 会重放全部历史)`);
  assert.equal(events.length, 0, "迁移态首帧不得产生任何事件");
});

test("游标防重放(桶内守卫):车桶落后于底线时,底线之下的行不算新事件", async () => {
  const { TripMonitor } = await import("../src/core/trip-monitor.mjs");
  const events = [];
  const monitor = new TripMonitor({ onEvent: (e) => events.push(e) });
  // 污染态形态:车 1 桶 107 < null 底线 3262(事故后修复前的真实状态)
  monitor.state.drive_cursors.null = 3262;
  monitor.state.drive_cursors["1"] = 107;
  monitor.state.done_cursors.null = 493;
  monitor.state.done_cursors["1"] = 154;
  monitor.reconcile({
    completed: [{ id: 200, car_id: 1, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }],
    actives: [],
    charging_rows: [{ id: 300, car_id: 1, start_at: "2026-01-01 09:00", end_at: "2026-01-01 10:00" }]
  }, "t1");
  assert.equal(events.length, 0, "底线之下的历史行(200<3262, 300<493)不得触发任何事件");
});
