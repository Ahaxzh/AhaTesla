// live/db.test.mjs — SQL 正确性验证，连真实 TeslaMate 库（只读）。
// live-safe：仅当 AHA_LIVE=1 时才执行（连真实 TeslaMate 库，只读），CI 默认跳过。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../src/core/db.mjs";
import {
  getCarSnapshot, getDrivingState, getSystemStats, getMonthStats, getWeekStats,
  listDrivesSql, getRoutePoints, getAddresses, getGeofences,
  listCharging, countCharging, listChargingForStats, getLatestChargingProcess
} from "../../src/core/teslamate-queries.mjs";
import { batchesFromChargingSessions, allocateDriveCosts, priceChargingSession } from "../../src/core/pricing-ledger.mjs";

const LIVE = process.env.AHA_LIVE === "1";
const db = createDb();
const DB_URL = process.env.DB_URL || "postgres://teslamate@127.0.0.1:15432/teslamate";

test("db reachable (skip when AHA_LIVE!=1)", { skip: !LIVE }, async () => {
  assert.equal(await db.ping(), true);
});

test("car snapshot", { skip: !LIVE }, async () => {
  const car = await getCarSnapshot(db);
  assert.ok(car, "expects at least one car");
  assert.equal(typeof car.name, "string");
  assert.ok(car.current_battery === null || Number.isFinite(Number(car.current_battery)));
});

test("driving state", { skip: !LIVE }, async () => {
  const state = await getDrivingState(db);
  // 语义值域：推导态（charging/driving）+ states 在线性值（online/offline/asleep）经
  // mapVehicleState 归一后的全集（含无 open 行时的 asleep_or_parked 兜底）。
  assert.ok(
    ["driving", "charging", "online", "offline", "asleep", "asleep_or_parked"].includes(state.state),
    `unexpected state ${state.state}`
  );
});

test("system stats", { skip: !LIVE }, async () => {
  const stats = await getSystemStats(db);
  assert.ok(stats.drive_count > 2000, `drive_count ${stats.drive_count}`);
  assert.ok(stats.last_drive_at);
});

test("month/week stats", { skip: !LIVE }, async () => {
  const month = await getMonthStats(db, new Date(Date.now() - 30 * 86400_000).toISOString());
  assert.ok(month.drive_count >= 0);
  const week = await getWeekStats(db, new Date(Date.now() - 7 * 86400_000).toISOString());
  assert.ok(Number.isFinite(Number(week.distance_km)));
});

test("list drives with paging + energy fields", { skip: !LIVE }, async () => {
  const { sql, params } = listDrivesSql({});
  const rows = await db.query(sql, [...params, 5, 0]);
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.ok(row.end_at);
    assert.ok(Number.isFinite(Number(row.distance_km)));
    assert.ok(Number.isFinite(Number(row.efficiency)));
  }
});

test("list drives with from/to filter", { skip: !LIVE }, async () => {
  const { sql, params } = listDrivesSql({ from: "2026-10-01T00:00:00Z", to: "2026-10-14T00:00:00Z" });
  const rows = await db.query(sql, [...params, 10, 0]);
  for (const row of rows) {
    assert.ok(new Date(row.end_at).getTime() >= new Date("2026-10-01T00:00:00Z").getTime() - 1);
    assert.ok(new Date(row.end_at).getTime() <= new Date("2026-10-14T00:00:00Z").getTime() + 1);
  }
});

test("route points downsampled", { skip: !LIVE }, async () => {
  const latest = await db.queryOne(`SELECT id FROM drives WHERE end_date IS NOT NULL ORDER BY end_date DESC LIMIT 1`);
  const points = await getRoutePoints(db, latest.id, 200);
  assert.ok(points.length > 0);
  assert.ok(points.length <= 200);
  for (const point of points) {
    assert.ok(Number.isFinite(point.lat));
    assert.ok(Number.isFinite(point.lng));
  }
});

test("addresses lookup", { skip: !LIVE }, async () => {
  const map = await getAddresses(db, [1, 2, 3]);
  assert.ok(typeof map === "object");
});

test("geofences mirror with cost_per_unit", { skip: !LIVE }, async () => {
  const geofences = await getGeofences(db);
  assert.ok(geofences.length > 0);
  const withPrice = geofences.filter((geofence) => geofence.price_per_unit !== null);
  assert.ok(withPrice.length > 0, "real db has priced geofences");
  assert.ok(["per_kwh", "per_minute"].includes(geofences[0].billing_type));
});

test("charging list + count", { skip: !LIVE }, async () => {
  const rows = await listCharging(db, { limit: 10, offset: 0 });
  assert.equal(rows.length, 10);
  const total = await countCharging(db);
  assert.ok(total >= 400, `charging total ${total}`);
  const withStatedCost = rows.filter((row) => row.cost !== null);
  assert.ok(withStatedCost.length > 0);
});

test("charging stats aggregation", { skip: !LIVE }, async () => {
  const rows = await listChargingForStats(db, { sinceIso: new Date(Date.now() - 90 * 86400_000).toISOString() });
  assert.ok(rows.length > 0);
  const priced = rows.map((row) => priceChargingSession(row, 1.0));
  assert.ok(priced.some((item) => item.source === "stated"));
});

test("latest charging process", { skip: !LIVE }, async () => {
  const latest = await getLatestChargingProcess(db);
  assert.ok(latest);
  assert.ok(Number.isInteger(latest.id));
});

test("end-to-end batch allocation against real data", { skip: !LIVE }, async () => {
  // 取最近 30 天充电会话构造批次，再对最近 20 个行程分摊成本
  const charging = await listChargingForStats(db, { sinceIso: new Date(Date.now() - 60 * 86400_000).toISOString() });
  const batches = batchesFromChargingSessions(charging);
  assert.ok(batches.length > 0, "real db yields batches");
  const { sql, params } = listDrivesSql({});
  const drives = await db.query(sql, [...params, 20, 0]);
  const { allocations, remaining_batches } = allocateDriveCosts({
    drives: drives.map((drive) => ({
      id: drive.id,
      start_at: drive.start_at,
      estimated_kwh: drive.ideal_used_km !== null && drive.efficiency
        ? Number((Number(drive.ideal_used_km) * Number(drive.efficiency) / 1000).toFixed(2))
        : null
    })),
    batches,
    defaultRate: 1.0
  });
  assert.equal(allocations.length, drives.length);
  const priced = allocations.filter((allocation) => allocation.cost_cny !== null);
  assert.ok(priced.length > 0, "at least some drives priced");
  for (const allocation of priced) {
    assert.ok(allocation.cost_cny >= 0);
    const sliceSum = allocation.slices.reduce((total, slice) => total + (slice.energy_kwh ?? 0), 0);
    assert.ok(Math.abs(sliceSum - allocation.energy_kwh) < 0.01, "slices sum to drive energy");
  }
  assert.ok(Array.isArray(remaining_batches));
});

test("cleanup", { skip: !LIVE }, async () => {
  await db.close();
});
