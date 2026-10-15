// live/poll-capture.test.mjs — 轮询事件捕获基线 live 验证（连真实 TeslaMate 库，只读）。
// 仅当 AHA_LIVE=1 时执行；全程只 SELECT，不写任何数据。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../src/core/db.mjs";
import {
  getMaxDriveId,
  getDrivesIncremental,
  getActiveDrive,
  getChargingIncremental,
  getChargingClosedIncremental,
  getLatestChargingProcess
} from "../../src/core/teslamate-queries.mjs";
import { TripMonitor, startTripMonitorLoop, MONITOR_DEFAULTS } from "../../src/core/trip-monitor.mjs";

const LIVE = process.env.AHA_LIVE === "1";
const db = createDb();

test("真库可达（AHA_LIVE!=1 时跳过）", { skip: !LIVE }, async () => {
  assert.equal(await db.ping(), true);
});

test("增量查询：max id 水线 → 增量返回空；探针耗时 < 100ms", { skip: !LIVE }, async () => {
  const t0 = Date.now();
  const maxDrive = await getMaxDriveId(db);
  const sinceMax = await getDrivesIncremental(db, maxDrive);
  const closedSinceMax = await getChargingClosedIncremental(db, (await getLatestChargingProcess(db)).id);
  const elapsed = Date.now() - t0;
  assert.ok(Number.isInteger(maxDrive) && maxDrive > 0, `maxDrive ${maxDrive}`);
  assert.equal(sinceMax.length, 0); // 水线处增量必须为空
  assert.equal(closedSinceMax.length, 0);
  assert.ok(elapsed < 100, `probe took ${elapsed}ms`);
});

test("增量查询：低游标截断返回升序有限行（只读语义）", { skip: !LIVE }, async () => {
  const maxDrive = await getMaxDriveId(db);
  const batch = await getDrivesIncremental(db, Math.max(0, maxDrive - 5));
  assert.ok(batch.length > 0 && batch.length <= 5);
  for (const row of batch) {
    assert.ok(row.id > Math.max(0, maxDrive - 5));
    assert.ok(row.end_at, "completed rows must carry end_date");
  }
  const ids = batch.map((row) => row.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "ascending order");
});

test("live 轮询循环：首帧建水线零事件， poke 后仍零事件（真库无新数据）", { skip: !LIVE }, async () => {
  const events = [];
  const monitor = new TripMonitor({ onEvent: (event) => events.push(event) });
  const loop = startTripMonitorLoop({ monitor, db, pollMs: MONITOR_DEFAULTS.pollMs });
  try {
    // 首帧 tick() 是同步触发的 promise；等两轮微任务+宏任务
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(monitor.state.initialized, true);
    assert.ok(monitor.state.last_drive_id > 0, `last_drive_id ${monitor.state.last_drive_id}`);
    assert.ok(monitor.state.last_charging_id > 0, `last_charging_id ${monitor.state.last_charging_id}`);
    assert.ok(monitor.state.last_charging_done_id > 0, `last_charging_done_id ${monitor.state.last_charging_done_id}`);
    assert.equal(events.length, 0, "冷启动首帧不得产生事件（AC-12.1b）");

    await loop.poke();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(events.length, 0, "无新数据时 poke 不产生事件");
  } finally {
    loop.stop();
  }
});

test("cleanup", { skip: !LIVE }, async () => {
  await db.close();
});
