// poll-capture.test.mjs — 轮询事件捕获基线 + MQTT 可选增强（AC-12.1b / §7.1 / AC-12.3）。
//
// 覆盖：
// - id 增量游标推进（drives/charging 双游标 + charging_done 第三游标）
// - 冷启动水线（首帧 stamp，历史静默，不触发推送）
// - 事件去重（eventKey：同 id 双源/重复观测不双推）
// - MQTT 降级（未配置 → null；连不上 → null；轮询照常）
// - MQTT 边沿 → poke 轮询（双源一致：事件由 DB 权威行产生，只推一次）
// - 60s SLA 口径（结算落库 end_date 非空 → 事件捕获在轮询间隔内，30s 默认 < 60s）
import { test } from "node:test";
import assert from "node:assert/strict";
import { TripMonitor, startTripMonitorLoop, MONITOR_DEFAULTS, isChargingSessionOpen } from "../src/core/trip-monitor.mjs";
import { startMqttBridge, defaultSubscribeTopics, parseChargingBoundary } from "../src/core/mqtt-bridge.mjs";
import { createFakeDb } from "../src/core/db.mjs";

// ---- id 增量游标推进 --------------------------------------------------------

test("drives 游标随增量行推进，旧 id 重复投递被跳过", () => {
  const monitor = new TripMonitor({});
  monitor.reconcile({ completed: [], active: null, max_drive_id: 100, latest_charging_id: 50, latest_charging_done_id: 50 }, "t0");
  assert.equal(monitor.state.last_drive_id, 100);

  monitor.reconcile({
    completed: [{ id: 101, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }],
    active: null
  }, "t1");
  assert.equal(monitor.state.last_drive_id, 101);
  assert.deepEqual(monitor.state.session.segment_ids, [101]);

  // 同一行重复出现在后续快照（非增量投递）：游标不回退、session 不重复吸收
  const events = monitor.reconcile({
    completed: [{ id: 101, start_at: "2026-01-01 08:00", end_at: "2026-01-01 08:30" }],
    active: null
  }, "t2");
  assert.equal(monitor.state.last_drive_id, 101);
  assert.deepEqual(monitor.state.session.segment_ids, [101]);
  assert.equal(events.length, 0);
});

test("charging 双游标：start 游标与 done 游标独立推进", () => {
  const monitor = new TripMonitor({});
  monitor.reconcile({ completed: [], active: null, latest_charging_id: 500, latest_charging_done_id: 499 }, "t0");

  // 新开充电（未结束）：推 start 游标，done 游标不动
  assert.equal(monitor.observeChargingStarted({ id: 501, end_at: null }, "t1"), true);
  assert.equal(monitor.state.last_charging_id, 501);
  assert.equal(monitor.state.last_charging_done_id, 499);

  // 同一会话稍后结算（同一行现在带 end_at）：推 done 游标，产生 charging_done 恰一次
  const event = monitor.observeChargingDone({ id: 501, end_at: "2026-01-01 09:00" }, "t2");
  assert.equal(event.type, "charging_done");
  assert.equal(monitor.state.last_charging_done_id, 501);
  assert.equal(monitor.observeChargingDone({ id: 501, end_at: "2026-01-01 09:00" }, "t3"), null);
});

test("reconcileCharging 增量批处理：open → start、closed → done、乱序安全", () => {
  const events = [];
  const monitor = new TripMonitor({ onEvent: (event) => events.push(event) });
  monitor.reconcile({ completed: [], active: null, latest_charging_id: 10, latest_charging_done_id: 10 }, "t0");

  monitor.reconcileCharging([
    { id: 12, start_at: "2026-01-01 08:00", end_at: "2026-01-01 09:00" }, // 已结算 → done
    { id: 11, start_at: "2026-01-01 07:00", end_at: null }               // 进行中 → start（乱序在前）
  ], "t1");

  assert.deepEqual(events.map((event) => `${event.type}:${event.charging_process_id}`).sort(), [
    "charging_done:12",
    "charging_start:11"
  ]);
  // start 游标：批内 max id（12 已越过 11）；done 游标同样推进到 12
  assert.equal(monitor.state.last_charging_id, 12);
  assert.equal(monitor.state.last_charging_done_id, 12);
});

test("reconcileChargingClosed：open→close 的行（id 不变）仍触发恰一次 charging_done", () => {
  const events = [];
  const monitor = new TripMonitor({ onEvent: (event) => events.push(event) });
  monitor.reconcile({ completed: [], active: null, latest_charging_id: 100, latest_charging_done_id: 100 }, "t0");

  // 帧1：新开充电（open 行，新行扫描发现）
  monitor.reconcileCharging([{ id: 101, start_at: "2026-01-01 08:00", end_at: null }], "t1");
  assert.deepEqual(events.map((e) => e.type), ["charging_start"]);
  assert.equal(monitor.state.last_charging_id, 101);
  assert.equal(monitor.state.last_charging_done_id, 100); // done 游标未动

  // 帧2：同一行结算（不再出现在"新行"扫描；出现在"已结算增量"扫描）
  monitor.reconcileChargingClosed([{ id: 101, start_at: "2026-01-01 08:00", end_at: "2026-01-01 09:30" }], "t2");
  assert.deepEqual(events.map((e) => e.type), ["charging_start", "charging_done"]);
  assert.equal(monitor.state.last_charging_done_id, 101);

  // 帧3：重复投递 → 游标拦截
  monitor.reconcileChargingClosed([{ id: 101, end_at: "2026-01-01 09:30" }], "t3");
  assert.equal(events.length, 2);
});

// ---- 冷启动水线（AC-12.1b）---------------------------------------------------

test("冷启动：loop 首帧以库内 max id 建三条水线，历史行静默、零事件", async () => {
  const monitor = new TripMonitor({ onEvent: () => assert.fail("冷启动首帧不得产生任何事件") });
  const db = createFakeDb((sql) => {
    if (/COALESCE\(max\(d\.id\)/.test(sql)) return [{ max_id: 3244 }];
    if (/charging_processes cp\s+ORDER BY cp\.id DESC/.test(sql)) return [{ id: 491, end_at: "2026-10-01 00:00" }];
    if (/max\(cp\.id\)[\s\S]*end_date IS NOT NULL/.test(sql)) return [{ max_id: 490 }];
    if (/FROM drives d\s+WHERE d\.id > \$1/.test(sql)) {
      return [
        { id: 3200, start_at: "2026-09-01 08:00", end_at: "2026-09-01 08:30" },
        { id: 3244, start_at: "2026-09-02 08:00", end_at: "2026-09-02 08:30" }
      ];
    }
    if (/FROM charging_processes cp\s+WHERE cp\.id > \$1/.test(sql)) {
      return [{ id: 488, start_at: "2026-08-01 00:00", end_at: null }]; // 僵尸充电会话
    }
    if (/end_date IS NULL/.test(sql)) return [];
    return [];
  });
  const loop = startTripMonitorLoop({ monitor, db, pollMs: 3_600_000 });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    loop.stop();
  }
  assert.equal(monitor.state.initialized, true);
  assert.equal(monitor.state.last_drive_id, 3244);
  assert.equal(monitor.state.last_charging_id, 491);
  assert.equal(monitor.state.last_charging_done_id, 490);
  assert.equal(monitor.pendingEvents().length, 0);
  assert.equal(monitor.state.session, null);
});

test("冷启动后首个真增量：新 drive 吸收 + 已结算充电行 → charging_done 恰一个", async () => {
  const events = [];
  // 固定 clock：parked_at(08:40) 与 at(08:45) 相差 5 分钟 < 空闲阈值 30 分钟，
  // 避免真实时钟导致的 trip_end 提前触发（时间炸弹）。
  const monitor = new TripMonitor({ onEvent: (event) => events.push(event), clock: () => "2026-10-14 08:45" });
  let phase = 0;
  const db = createFakeDb((sql) => {
    if (/COALESCE\(max\(d\.id\)/.test(sql)) return [{ max_id: 3244 }];
    if (/charging_processes cp\s+ORDER BY cp\.id DESC/.test(sql)) return [{ id: 491, end_at: "x" }];
    if (/max\(cp\.id\)[\s\S]*end_date IS NOT NULL/.test(sql)) return [{ max_id: 490 }];
    if (/FROM drives d\s+WHERE d\.id > \$1/.test(sql)) {
      return phase === 0 ? [] : [{ id: 3245, start_at: "2026-10-14 08:00", end_at: "2026-10-14 08:40" }];
    }
    if (/FROM charging_processes cp\s+WHERE cp\.id > \$1 AND cp\.end_date IS NOT NULL/.test(sql)) {
      return phase === 0 ? [] : [{ id: 492, start_at: "2026-10-14 09:00", end_at: "2026-10-14 09:50" }];
    }
    if (/FROM charging_processes cp\s+WHERE cp\.id > \$1/.test(sql)) return [];
    if (/end_date IS NULL/.test(sql)) return [];
    return [];
  });
  const loop = startTripMonitorLoop({ monitor, db, pollMs: 3_600_000 });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.length, 0); // 首帧只有水线
    phase = 1;
    await loop.poke();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    loop.stop();
  }
  // drive 3245 吸收进 session（trip_end 待边界）；充电 492 直接结算 → done 恰一次
  assert.deepEqual(events.map((event) => event.type), ["charging_done"]);
  assert.deepEqual(monitor.state.session.segment_ids, [3245]);
});

test("冷启动后增量 drive 被吸收、charging_done 即时、trip_end 由充电边界触发", async () => {
  const events = [];
  // 固定 clock：与上例同理，充电 492 start 08:45 与 clock 对齐。
  const monitor = new TripMonitor({ onEvent: (event) => events.push(event), clock: () => "2026-10-14 08:45" });
  let phase = 0;
  const db = createFakeDb((sql) => {
    if (/COALESCE\(max\(d\.id\)/.test(sql)) return [{ max_id: 3244 }];
    if (/charging_processes cp\s+ORDER BY cp\.id DESC/.test(sql)) return [{ id: 491, end_at: "x" }];
    if (/max\(cp\.id\)[\s\S]*end_date IS NOT NULL/.test(sql)) return [{ max_id: 490 }];
    if (/FROM drives d\s+WHERE d\.id > \$1/.test(sql)) {
      return phase === 0 ? [] : [{ id: 3245, start_at: "2026-10-14 08:00", end_at: "2026-10-14 08:40" }];
    }
    if (/FROM charging_processes cp\s+WHERE cp\.id > \$1/.test(sql)) {
      return phase === 0 ? [] : [{ id: 492, start_at: "2026-10-14 08:45", end_at: null }]; // 进行中
    }
    if (/end_date IS NULL/.test(sql)) return [];
    return [];
  });
  const loop = startTripMonitorLoop({ monitor, db, pollMs: 3_600_000 });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    phase = 1;
    await loop.poke();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    loop.stop();
  }
  // 增量帧：drive 3245 吸收进 session；充电 492 开启 → charging_start 事件 + session finalizing
  assert.deepEqual(events.map((event) => event.type), ["charging_start"]);
  assert.deepEqual(monitor.state.session.segment_ids, [3245]);
  assert.equal(monitor.state.session.phase, "finalizing");
  assert.equal(monitor.state.session.finalization_reason, "charging_started");
});

// ---- 事件去重（eventKey，防双源双推）------------------------------------------

test("eventKey 去重：同一 charging id 的 start/done 各只发一次（跨进程重启恢复）", () => {
  const events = [];
  const monitor = new TripMonitor({ onEvent: (event) => events.push(event) });
  monitor.reconcile({ completed: [], active: null, latest_charging_id: 100, latest_charging_done_id: 100 }, "t0");

  monitor.observeChargingStarted({ id: 101, end_at: null }, "t1");
  monitor.observeChargingStarted({ id: 101, end_at: null }, "t1b"); // 重复观测
  assert.equal(events.filter((event) => event.type === "charging_start").length, 1);

  monitor.observeChargingDone({ id: 101, end_at: "t" }, "t2");
  monitor.observeChargingDone({ id: 101, end_at: "t" }, "t2b"); // 重复观测
  assert.equal(events.filter((event) => event.type === "charging_done").length, 1);

  // 已 acknowledge 的事件再次尝试登记（sent_keys 命中）→ 不再 onEvent
  for (const event of monitor.pendingEvents()) monitor.acknowledge(event.eventKey, "t3");
  assert.equal(monitor.observeChargingDone({ id: 101, end_at: "t" }, "t4"), null);

  // 进程重启：状态恢复后同一 id 仍不重复（游标已推进）
  const restored = new TripMonitor({ state: monitor.toJSON(), onEvent: (event) => events.push(event) });
  assert.equal(restored.observeChargingStarted({ id: 101, end_at: null }, "t5"), false);
  assert.equal(restored.observeChargingDone({ id: 101, end_at: "t" }, "t5"), null);
  assert.equal(events.length, 2);
});

// ---- MQTT 可选增强（§7.1）：降级 ----------------------------------------------

test("MQTT_URL 未配置 → startMqttBridge 返回 null（纯轮询基线，AC-5.1 不显示 MQTT 项）", async () => {
  const bridge = await startMqttBridge({ url: "", monitor: new TripMonitor({}), eventLog: null });
  assert.equal(bridge, null);
});

test("MQTT_URL 配置但 broker 不可达 → 优雅降级返回 null（连接超时 5s 内）", async () => {
  const started = Date.now();
  const bridge = await startMqttBridge({
    url: "mqtt://127.0.0.1:1/", // 保留端口，连接必失败
    monitor: new TripMonitor({}),
    eventLog: null,
    connectTimeoutMs: 500,
    reconnectPeriodMs: 0 // 不自动重连，快速失败
  });
  assert.equal(bridge, null);
  assert.ok(Date.now() - started < 10_000);
});

test("默认订阅主题为只读 teslamate 主题（无发布/命令主题）", () => {
  const topics = defaultSubscribeTopics(1);
  assert.ok(topics.length >= 2);
  for (const topic of topics) {
    assert.ok(topic.startsWith("teslamate/cars/1/"), `unexpected topic ${topic}`);
    assert.ok(!/command|cmd|set|control/i.test(topic), `疑似命令主题: ${topic}`);
  }
});

test("parseChargingBoundary 边沿语义", () => {
  assert.deepEqual(parseChargingBoundary(false, true, null, null), { kind: "start" });
  assert.deepEqual(parseChargingBoundary(true, false, null, null), { kind: "done" });
  assert.deepEqual(parseChargingBoundary(null, null, true, false), { kind: "done" });
  assert.equal(parseChargingBoundary(true, true, true, true), null);
  assert.equal(parseChargingBoundary(null, null, null, null), null);
  // 首帧基线（prev=null）不构成边沿——与轮询冷启动水线同理
  assert.equal(parseChargingBoundary(null, true, null, true), null);
  assert.equal(parseChargingBoundary(null, false, null, false), null);
});

// ---- 60s SLA 口径（AC-12.3，PRD v1.3 修订）------------------------------------

test("SLA 口径：轮询间隔 30s（§7.1 基线 15~30s），结算落库 → 捕获延迟 < 60s（不含防抖静默期）", () => {
  // §7.1 基线要求 15~30s；实现取 30s。结算落库（end_date 非空）后最坏等待一个
  // 轮询周期 30s + 查询耗时（探针 1-3ms）→ 捕获在 60s SLA 内；推送防抖
  // （finalizationDelayMs 45s）属业务静默期，不计入 AC-12.3。
  assert.ok(MONITOR_DEFAULTS.pollMs >= 15_000 && MONITOR_DEFAULTS.pollMs <= 30_000);
  assert.ok(MONITOR_DEFAULTS.pollMs < 60_000);
  // 结算行识别即事件：isChargingSessionOpen(closed row) === false → done 路径
  const settledRow = { id: 1, end_at: "2026-10-14T01:00:00Z" };
  assert.equal(isChargingSessionOpen(settledRow), false);
});

// ---- MQTT 边沿 → poke 轮询（双源一致）------------------------------------------

test("MQTT 充电边沿触发 poke：事件由 DB 权威行产生，语义与纯轮询一致且只推一次", async () => {
  const events = [];
  const monitor = new TripMonitor({ onEvent: (event) => events.push(event) });
  let pokes = 0;
  let phase = 0;
  const db = createFakeDb((sql) => {
    if (/COALESCE\(max\(d\.id\)/.test(sql)) return [{ max_id: 3244 }];
    if (/charging_processes cp\s+ORDER BY cp\.id DESC/.test(sql)) return [{ id: 491, end_at: "x" }];
    if (/max\(cp\.id\)[\s\S]*end_date IS NOT NULL/.test(sql)) return [{ max_id: 490 }];
    if (/FROM drives d\s+WHERE d\.id > \$1/.test(sql)) return [];
    if (/FROM charging_processes cp\s+WHERE cp\.id > \$1/.test(sql)) {
      return phase === 0 ? [] : [{ id: 492, start_at: "2026-10-14 10:00", end_at: null }];
    }
    if (/end_date IS NULL/.test(sql)) return [];
    return [];
  });
  const loop = startTripMonitorLoop({ monitor, db, pollMs: 3_600_000 });
  const wrappedPoke = loop.poke;
  loop.poke = () => { pokes += 1; return wrappedPoke(); }; // 模拟 index.mjs 的 onBoundary → loop.poke()
  try {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.length, 0);

    phase = 1;
    loop.poke(); // MQTT charging true 边沿到达 → 立即轮询
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(pokes, 1);
    // 同一事件无论 MQTT 先发现还是轮询先发现：事件来自 observeChargingStarted
    // （水位游标 + eventKey 去重），不会因 MQTT 侧再触发而重复推送
    assert.deepEqual(events.map((event) => event.type), ["charging_start"]);
    loop.poke(); // 重复边沿（防抖抖动）→ 轮询再看同一行，游标拦截
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events.map((event) => event.type), ["charging_start"]);
  } finally {
    loop.stop();
  }
});
