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
