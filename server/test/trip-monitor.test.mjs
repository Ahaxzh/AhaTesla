// trip-monitor.test.mjs — 行程边界状态机语义（按 docs/PRD.md US-12 / AC-12.1a-b 自有规格）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { TripMonitor, MONITOR_DEFAULTS, isChargingSessionOpen } from "../src/core/trip-monitor.mjs";
import { openStore } from "../src/core/store.mjs";

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
  // charging_start（observe 时即时登记）+ trip_end（延时到期）双事件
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.type).sort(), ["charging_start", "trip_end"]);
  assert.ok(events.find((event) => event.type === "trip_end").reason === "charging_started");
});

test("acknowledge 去重：已发送事件不重复", () => {
  const monitor = newMonitor();
  monitor.reconcile({ completed: [{ id: 1, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }], active: null }, "2026-01-01 08:31");
  monitor.observeChargingStarted({ id: 5 }, "2026-01-01 08:32:00");
  monitor.reconcile({ completed: [], active: null }, "2026-01-01 08:33:00");
  assert.equal(monitor.pendingEvents().length, 2);
  for (const event of monitor.pendingEvents()) {
    assert.ok(event);
    assert.equal(monitor.acknowledge(event.eventKey, "2026-01-01 08:34:00"), true);
  }
  assert.equal(monitor.pendingEvents().length, 0);
  for (const event of monitor.pendingEvents()) assert.equal(monitor.acknowledge(event.eventKey), false);
  // 同一 session 再次 queue 不重复（sent_keys 去重）
  const keys = Object.keys(monitor.state.sent_keys);
  assert.equal(keys.length, 2);
  for (const key of keys) assert.equal(monitor.state.sent_keys[key], "2026-01-01 08:34:00");
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
  // charging_start 已随 observe 登记 + trip_end 延时到期
  assert.equal(events.length, 2);
});

// ---- B2 / B3 / B4：按自有规格重写时顺带修复的缺陷回归 ------------------------

test("B2: 首次接入以数据库水线初始化充电游标，不回放僵尸充电会话", () => {
  const events = [];
  const monitor = new TripMonitor({ onEvent: (event) => events.push(event) });
  // 首次接入：快照携带当前 charging_processes 最大 id = 100（通知水线）
  monitor.reconcile({ completed: [], active: null, latest_charging_id: 100 }, "2026-01-01 07:00");
  assert.equal(monitor.state.last_charging_id, 100);

  // 历史遗留的僵尸充电会话（id 85 < 水线，end 空）不得被判为新事件
  const isNew = monitor.observeChargingStarted(
    { id: 85, start_at: "2026-01-01 03:00", end_at: null },
    "2026-01-01 07:01"
  );
  assert.equal(isNew, false);
  assert.equal(monitor.state.session, null);
  assert.equal(events.length, 0);
  assert.equal(monitor.pendingEvents().length, 0);
  assert.equal(monitor.state.last_charging_id, 100); // 水线不回退
});

test("B2: 水线之后的新充电会话仍被识别", () => {
  const monitor = new TripMonitor({});
  monitor.reconcile({ completed: [], active: null, latest_charging_id: 100 }, "2026-01-01 07:00");
  const isNew = monitor.observeChargingStarted({ id: 101, end_at: null }, "2026-01-01 09:00");
  assert.equal(isNew, true);
  assert.equal(monitor.state.last_charging_id, 101);
});

test("B3: isChargingSessionOpen 的显式条件语义", () => {
  assert.equal(isChargingSessionOpen(null), false);
  assert.equal(isChargingSessionOpen(undefined), false);
  assert.equal(isChargingSessionOpen({}), true);                       // 无结束字段视为进行中
  assert.equal(isChargingSessionOpen({ end_at: null }), true);
  assert.equal(isChargingSessionOpen({ end_at: null, end_date: null }), true);
  assert.equal(isChargingSessionOpen({ end_date: null }), true);       // end_at 缺省
  assert.equal(isChargingSessionOpen({ end_at: "2026-01-01T00:00:00Z" }), false);
  assert.equal(isChargingSessionOpen({ end_at: "2026-01-01T00:00:00Z", end_date: null }), false);
});

test("B4: 新充电会话产出 charging_start 事件（水位去重，不重复）", () => {
  const events = [];
  const monitor = new TripMonitor({ onEvent: (event) => events.push(event) });
  monitor.reconcile({ completed: [], active: null, latest_charging_id: 100 }, "2026-01-01 07:00");

  const isNew = monitor.observeChargingStarted(
    { id: 101, start_at: "2026-01-02 08:00", end_at: null },
    "2026-01-02 08:00"
  );
  assert.equal(isNew, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "charging_start");
  assert.equal(events[0].charging_process_id, 101);
  assert.equal(events[0].started_at, "2026-01-02 08:00");

  // 同一会话再次观测：水位已前进，不重复产出
  assert.equal(monitor.observeChargingStarted({ id: 101, end_at: null }, "2026-01-02 08:01"), false);
  assert.equal(events.length, 1);
});

test("B4: 充电开始同时把行驶会话置为 finalizing", () => {
  const monitor = newMonitor();
  monitor.reconcile({ completed: [{ id: 1, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }], active: null }, "2026-01-01 08:31");
  const isNew = monitor.observeChargingStarted({ id: 1, end_at: null }, "2026-01-01 08:32:00");
  assert.equal(isNew, true);
  assert.equal(monitor.state.session.phase, "finalizing");
  assert.equal(monitor.state.session.finalization_reason, "charging_started");
});

test("GA-39: monitor 状态经 SQLite kv 持久化后重启恢复（水线与 sent_keys 不丢）", () => {
  const store = openStore({ file: ":memory:" });
  // 第一次运行：吸收 drive + 充电事件，模拟 index.mjs 的持久化路径
  const first = new TripMonitor({ onEvent: () => {} });
  first.reconcile({ completed: [{ id: 100, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }] }, "2026-01-01 08:31");
  first.observeChargingStarted({ id: 55, end_at: null }, "2026-01-01 08:32");
  first.acknowledge(`charging-start-55`);
  store.kvPut("monitor_state_v1", JSON.stringify(first.state));

  // "重启"：从 kv 恢复，同库同充电行 → 水线拦截，不重复事件
  const doneEvents = [];
  const restored = new TripMonitor({ state: JSON.parse(store.kvGet("monitor_state_v1")), onEvent: (e) => doneEvents.push(e) });
  assert.equal(restored.state.last_drive_id, 100);
  assert.equal(restored.state.last_charging_id, 55);
  assert.equal(restored.observeChargingStarted({ id: 55, end_at: null }, "2026-01-01 09:00"), false); // start 不重复
  assert.equal(doneEvents.length, 0);
  const ev = restored.observeChargingDone({ id: 55, end_at: "2026-01-01 09:30" });
  assert.equal(ev.type, "charging_done"); // done 游标独立，结算仍产出恰一次
  assert.equal(doneEvents.length, 1);
  assert.equal(restored.observeChargingDone({ id: 55, end_at: "2026-01-01 09:30" }), null); // 再来一次被水线拦
});
