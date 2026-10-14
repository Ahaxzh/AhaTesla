// trip-monitor.test.mjs — 边界状态机语义（继承 tesla-butler trip-session）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { TripMonitor, MONITOR_DEFAULTS } from "../src/core/trip-monitor.mjs";

function newMonitor() {
  const monitor = new TripMonitor({});
  // baseline init（首次 reconcile 建立基线，不回放历史）
  monitor.reconcile({ completed: [], active: null }, "2026-01-01 07:00");
  return monitor;
}

test("首次 reconcile 初始化 last_drive_id，不回放历史", () => {
  const monitor = new TripMonitor({});
  const events = monitor.reconcile({
    completed: [
      { id: 10, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" },
      { id: 11, start_at: "2026-01-01 09:00", end_at: "2026-01-01 09:40" }
    ],
    active: null
  }, "2026-01-01 10:00");
  assert.equal(events.length, 0);
  assert.equal(monitor.state.last_drive_id, 11);
  assert.equal(monitor.state.session, null);
});

test("新 drive 累积为 session 段", () => {
  const monitor = newMonitor();
  monitor.reconcile({ completed: [{ id: 10, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }], active: null }, "2026-01-01 08:35");
  assert.deepEqual(monitor.state.session.segment_ids, [10]);
  assert.equal(monitor.state.session.phase, "parked");
  monitor.reconcile({ completed: [], active: { id: 11, start_at: "2026-01-01 08:50" } }, "2026-01-01 08:55");
  assert.equal(monitor.state.session.phase, "driving");
  const events = monitor.reconcile({
    completed: [
      { id: 10, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" },
      { id: 11, start_at: "2026-01-01 08:50", end_at: "2026-01-01 09:20" }
    ],
    active: null
  }, "2026-01-01 09:25");
  assert.equal(events.length, 0);
  assert.deepEqual(monitor.state.session.segment_ids, [10, 11]);
  assert.equal(monitor.state.session.phase, "parked");
});

test("充电间隔恢复边界 → trip_end 事件（charging_between）", () => {
  const monitor = newMonitor();
  monitor.reconcile({ completed: [{ id: 1, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }], active: null }, "2026-01-01 08:31");
  const events = monitor.reconcile({
    completed: [
      { id: 1, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" },
      { id: 2, start_at: "2026-01-01 09:00", end_at: "2026-01-01 09:30", charging_between: true }
    ],
    active: null
  }, "2026-01-01 09:31");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "trip_end");
  assert.equal(events[0].reason, "charging_between");
  assert.deepEqual(events[0].segment_ids, [1]);
  // 新 session 从 drive 2 开始
  assert.deepEqual(monitor.state.session.segment_ids, [2]);
});

test("不活动超时恢复边界（inactivity_timeout）", () => {
  const monitor = newMonitor();
  monitor.reconcile({ completed: [{ id: 1, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }], active: null }, "2026-01-01 08:31");
  const events = monitor.reconcile({
    completed: [
      { id: 1, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" },
      { id: 2, start_at: "2026-01-01 10:00", end_at: "2026-01-01 10:30" } // gap 1.5h > 30min
    ],
    active: null
  }, "2026-01-01 10:31");
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "inactivity_timeout");
});

test("门锁信号触发 finalizing → active 复活取消", () => {
  const monitor = newMonitor();
  monitor.reconcile({ completed: [{ id: 1, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }], active: null }, "2026-01-01 08:31");
  // 信号基线 + 开锁再上锁（edge，停车后 8 分钟、10 分钟并行窗口内）
  monitor.observeVehicleSignal("locked", true, "2026-01-01 08:31:30");
  monitor.observeVehicleSignal("locked", false, "2026-01-01 08:37:00");
  const changed = monitor.observeVehicleSignal("locked", true, "2026-01-01 08:38:00");
  assert.equal(changed, true);
  assert.equal(monitor.state.session.phase, "finalizing");
  assert.equal(monitor.state.session.finalization_reason, "locked");
  // 延时窗口内 active 复活 → 取消
  monitor.reconcile({ completed: [], active: { id: 2, start_at: "2026-01-01 08:38:20" } }, "2026-01-01 08:38:30");
  assert.equal(monitor.state.session.phase, "driving");
  assert.equal(monitor.state.session.finalization_reason, null);
});

test("门锁信号 + 延时到期 → 产出 trip_end 事件", () => {
  const monitor = newMonitor();
  monitor.reconcile({ completed: [{ id: 1, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }], active: null }, "2026-01-01 08:31");
  monitor.observeVehicleSignal("locked", true, "2026-01-01 08:31:30");
  monitor.observeVehicleSignal("locked", false, "2026-01-01 08:37:00");
  monitor.observeVehicleSignal("locked", true, "2026-01-01 08:38:00");
  const events = monitor.reconcile({ completed: [], active: null }, "2026-01-01 08:39:00"); // > 45s 延时
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "locked");
  assert.deepEqual(events[0].segment_ids, [1]);
});

test("locked 信号在停车窗口容差外不触发", () => {
  const monitor = newMonitor();
  monitor.reconcile({ completed: [{ id: 1, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }], active: null }, "2026-01-01 08:31");
  monitor.observeVehicleSignal("locked", false, "2026-01-01 08:31:01");
  monitor.observeVehicleSignal("locked", true, "2026-01-01 09:30:00"); // far after parked_at
  assert.notEqual(monitor.state.session.phase, "finalizing");
});

test("信号基线化：首次观测不产生状态迁移", () => {
  const monitor = newMonitor();
  monitor.reconcile({ completed: [{ id: 1, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }], active: null }, "2026-01-01 08:31");
  const changed = monitor.observeVehicleSignal("locked", true, "2026-01-01 08:31:05");
  assert.equal(changed, false);
});

test("充电开始立即 finalize session", () => {
  const monitor = newMonitor();
  monitor.reconcile({ completed: [{ id: 1, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }], active: null }, "2026-01-01 08:31");
  monitor.observeChargingStarted({ id: 77 }, "2026-01-01 08:32:00");
  assert.equal(monitor.state.session.phase, "finalizing");
  assert.equal(monitor.state.session.finalization_reason, "charging_started");
  const events = monitor.reconcile({ completed: [], active: null }, "2026-01-01 08:33:00");
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "charging_started");
});

test("acknowledge 去重：已发送事件不重复", () => {
  const monitor = newMonitor();
  monitor.reconcile({ completed: [{ id: 1, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }], active: null }, "2026-01-01 08:31");
  monitor.observeChargingStarted({ id: 5 }, "2026-01-01 08:32:00");
  monitor.reconcile({ completed: [], active: null }, "2026-01-01 08:33:00");
  const [event] = monitor.pendingEvents();
  assert.ok(event);
  assert.equal(monitor.acknowledge(event.eventKey, "2026-01-01 08:34:00"), true);
  assert.equal(monitor.pendingEvents().length, 0);
  assert.equal(monitor.acknowledge(event.eventKey), false);
  // 同一 session 再次 queue 不重复（sent_keys 去重）
  assert.equal(monitor.state.sent_keys[event.eventKey], "2026-01-01 08:34:00");
});

test("30 分钟不活动超时兜底产出 trip_end", () => {
  const monitor = newMonitor();
  monitor.reconcile({ completed: [{ id: 1, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }], active: null }, "2026-01-01 08:31");
  const events = monitor.reconcile({ completed: [], active: null }, "2026-01-01 09:10:00");
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "inactivity_timeout");
});

test("状态可序列化恢复（进程重启）", () => {
  const monitor = newMonitor();
  monitor.reconcile({ completed: [{ id: 1, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }], active: null }, "2026-01-01 08:31");
  const saved = monitor.toJSON();
  const restored = new TripMonitor({ state: saved });
  assert.deepEqual(restored.state.session.segment_ids, [1]);
  assert.equal(restored.state.last_drive_id, 1);
  restored.observeChargingStarted({ id: 9 }, "2026-01-01 08:40:00");
  const events = restored.reconcile({ completed: [], active: null }, "2026-01-01 08:41:00");
  assert.equal(events.length, 1);
});
