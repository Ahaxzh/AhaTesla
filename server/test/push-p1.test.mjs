// push-p1.test.mjs — 推送内容设计 P1 批次回归（PUSH-DESIGN.md）。
// 覆盖：静音时段门+backlog+早报合并、trip 计价批次行、charging_start/done
// 富化行、daily 插枪提醒、monthly 年度累计。
import { test } from "node:test";
import assert from "node:assert/strict";
import { useMemoryStore } from "../src/core/state.mjs";
import { openStore } from "../src/core/store.mjs";
import { createNotifier, inQuietHours } from "../src/core/push-channels.mjs";
import { buildReport, startReportScheduler } from "../src/core/report-engine.mjs";

function makeFakeDb(routes) {
  return {
    async query(sql, params = []) {
      for (const { match, rows } of routes) {
        if (match(sql, params)) return typeof rows === "function" ? rows(sql, params) : rows;
      }
      return [];
    },
    async queryOne(sql, params = []) {
      for (const { match, rows } of routes) {
        if (match(sql, params)) return (typeof rows === "function" ? rows(sql, params) : rows)[0] ?? null;
      }
      return null;
    }
  };
}

const probeChannel = (sink) => ({
  id: "feishu", enabled: () => true, status: async () => ({}),
  send: async (msg) => { sink.push(msg); return { sent: true }; }
});

// ---- P1-a 静音时段 -----------------------------------------------------------

test("inQuietHours：普通窗口/跨午夜/非法与关闭态", () => {
  const at = (hm) => new Date(`2026-10-18T${hm}:00+08:00`);
  assert.equal(inQuietHours({ enabled: true, start: "23:00", end: "07:00" }, at("23:30")), true);
  assert.equal(inQuietHours({ enabled: true, start: "23:00", end: "07:00" }, at("06:59")), true);
  assert.equal(inQuietHours({ enabled: true, start: "23:00", end: "07:00" }, at("12:00")), false);
  assert.equal(inQuietHours({ enabled: true, start: "12:00", end: "14:00" }, at("13:00")), true);
  assert.equal(inQuietHours({ enabled: true, start: "12:00", end: "14:00" }, at("11:59")), false);
  assert.equal(inQuietHours({ enabled: false, start: "23:00", end: "07:00" }, at("23:30")), false);
  assert.equal(inQuietHours({ enabled: true, start: "99:00", end: "07:00" }, at("23:30")), false);
  assert.equal(inQuietHours({ enabled: true, start: "08:00", end: "08:00" }, at("08:30")), false); // 同点=关
});

test("静音命中：trip_end 转入 backlog 不投递；charging/daily 不受影响", async () => {
  useMemoryStore();
  const sent = [];
  const state = {
    pushRules: {
      matrix: { tripEnd: { feishu: true }, chargingStart: { feishu: true }, daily: { feishu: true } },
      quietHours: { enabled: true, start: "00:00", end: "23:59" } // 全天静音（测试用）
    }
  };
  const notifier = createNotifier({ state, feishu: probeChannel(sent), telegram: null });

  const r1 = await notifier.dispatch({ type: "trip_end", eventKey: "trip-1", distanceKm: 4.2, costCny: 0.62, startLabel: "家", endLabel: "公司" });
  assert.equal(r1.deferred, true);
  assert.equal(sent.length, 0, "静音期内不投递");
  assert.equal(state.pushRules.quietBacklog.length, 1);
  assert.deepEqual(
    { distanceKm: state.pushRules.quietBacklog[0].distanceKm, startLabel: state.pushRules.quietBacklog[0].startLabel },
    { distanceKm: 4.2, startLabel: "家" }
  );

  await notifier.dispatch({ type: "charging_start", locationName: "家" });
  assert.equal(sent.length, 1, "充电不受静音影响");
  await notifier.dispatch({ type: "daily", dateLabel: "10-18", kpi: { distanceKm: 10 } });
  assert.equal(sent.length, 2, "日报不受静音影响");

  // backlog 上限 10
  for (let i = 0; i < 12; i++) await notifier.dispatch({ type: "trip_end", eventKey: `t-${i}` });
  assert.equal(state.pushRules.quietBacklog.length, 10);
});

test("早报消费 backlog:「昨夜静默行程」段呈现并清空", async () => {
  useMemoryStore();
  const store = openStore({ file: ":memory:" });
  const events = [];
  const eventLog = { log: (type, extra) => events.push({ type, extra }) };
  const deps = () => ({
    db: makeFakeDb([
      { match: (s) => s.includes("charging_processes"), rows: [{ id: 9, end_date: "2026-10-17T15:30:00", charge_energy_added: 10, geofence_name: "家" }] },
      { match: (s) => s.includes("FROM geofences"), rows: [] },
      { match: () => true, rows: [{ id: 1, distance_km: 12, duration_min: 30, cost: 1.2 }] }
    ]),
    state: { pricing: { defaultRateCnyPerKwh: 0.6, history: [] } },
    computeTripViews: async (_db, drives) => drives.map((d) => ({ id: d.id, distanceKm: d.distance_km, energyKWh: 1, costCny: d.cost })),
    listDrivesSql: ({ from, to }) => ({ sql: "SELECT * FROM drives", params: [from, to] }),
    listChargingForStats: async () => []
  });
  const pushes = [];
  const notifier = { dispatch: async (event) => { pushes.push(event); return { results: { feishu: { sent: true } } }; } };
  const state = {
    dailyLastRun: null,
    pushRules: { quietBacklog: [
      { at: "2026-10-17T15:41:00Z", startLabel: "家", endLabel: "公司", distanceKm: 4.2, durationMin: 15, costCny: 0.62 }
    ] }
  };
  const scheduler = startReportScheduler({ store, buildDeps: deps, notifier, eventLog, state, setTimeoutImpl: () => 0 });
  scheduler.stop();
  await scheduler.runKind("daily");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].quietTrips.length, 1);
  assert.equal(state.pushRules.quietBacklog.length, 0, "投递后清空");
  assert.ok(events.some((e) => e.type === "report.daily.quiet_merged"));

  // 正文渲染:🌙 段（经真实 eventBody）
  const sent = [];
  const n2 = createNotifier({
    state: { pushRules: { matrix: { daily: { feishu: true } } } },
    feishu: probeChannel(sent), telegram: null
  });
  await n2.dispatch({
    type: "daily", dateLabel: "10-18", kpi: { distanceKm: 12 },
    quietTrips: [{ at: "2026-10-17T15:41:00Z", startLabel: "家", endLabel: "公司", distanceKm: 4.2, costCny: 0.62 }]
  });
  assert.match(sent[0].body, /🌙 昨夜静默行程/);
  assert.match(sent[0].body, /家→公司 4\.2km/);
});

// ---- P1-b/c/d 渲染行（字段由富化层注入，可得才显示） ---------------------------

test("trip_end 计价批次行:多批次显示前2并省略,单批次不显示", async () => {
  useMemoryStore();
  const sent = [];
  const n = createNotifier({ state: { pushRules: { matrix: { tripEnd: { feishu: true } } } }, feishu: probeChannel(sent), telegram: null });
  await n.dispatch({
    type: "trip_end", distanceKm: 9,
    fifoBatches: [
      { source: "家庭充电桩", kwh: 4.1, price: 0.3 },
      { source: "超充", kwh: 2.0, price: 0.92 },
      { source: "默认电价", kwh: 1.5, price: 0.6 }
    ]
  });
  assert.match(sent[0].body, /🔋 计价批次 家庭充电桩 4\.1kWh@¥0\.3 · 超充 2kWh@¥0\.92 …/);
  sent.length = 0;
  await n.dispatch({ type: "trip_end", distanceKm: 5, fifoBatches: [{ source: "默认电价", kwh: 5, price: 0.6 }] });
  assert.doesNotMatch(sent[0].body, /计价批次/);
});

test("charging_start 富化行与 charging_done 对比行/⚠ 标题", async () => {
  useMemoryStore();
  const sent = [];
  const n = createNotifier({ state: { pushRules: { matrix: { chargingStart: { feishu: true }, chargingDone: { feishu: true } } } }, feishu: probeChannel(sent), telegram: null });
  await n.dispatch({ type: "charging_start", locationName: "超充站", batteryPct: 23, estimate: "预计 40 分钟 · ¥38" });
  assert.match(sent[0].body, /🔋 当前 23%/);
  assert.match(sent[0].body, /⏱ 预计 40 分钟 · ¥38/);
  // 无预估数据不硬造
  await n.dispatch({ type: "charging_start", locationName: "家" });
  assert.doesNotMatch(sent[1].body, /⏱/);

  await n.dispatch({ type: "charging_done", energyKwh: 41, costCny: 12.3, endBattery: 82, priceCmpPct: 12, endedEarly: true });
  assert.match(sent[2].title, /⚠ 充电提前中止/);
  assert.match(sent[2].body, /较本站近 5 次均价 高 12%/);
  await n.dispatch({ type: "charging_done", energyKwh: 10, endBattery: 90 });
  assert.doesNotMatch(sent[3].title, /⚠/);
  assert.doesNotMatch(sent[3].body, /均价/);
});

// ---- P1-e daily 插枪提醒 ------------------------------------------------------

test("daily 插枪提醒:TOU 用户昨日无充电才出现", async () => {
  useMemoryStore();
  openStore({ file: ":memory:" });
  const { getStore } = await import("../src/core/state.mjs");
  getStore().kvPut("pricing:location-tou:1", JSON.stringify({ offPeakStart: "23:00", offPeakEnd: "07:00", offPeakRate: 0.3, peakRate: 1.0 }));

  const deps = () => ({
    db: makeFakeDb([
      { match: (s) => s.includes("charging_processes"), rows: [] }, // 昨日无充电
      { match: (s) => s.includes("FROM geofences"), rows: [{ id: 1, name: "家" }] },
      { match: () => true, rows: [] }
    ]),
    state: { pricing: { defaultRateCnyPerKwh: 0.6, history: [] } },
    computeTripViews: async (_db, drives) => drives.map((d) => ({ id: d.id, distanceKm: d.distance_km, energyKWh: 1, costCny: d.cost })),
    listDrivesSql: ({ from, to }) => ({ sql: "SELECT * FROM drives", params: [from, to] }),
    listChargingForStats: async () => []
  });
  const report = await buildReport({ kind: "daily", now: new Date("2026-10-18T02:00:00Z"), deps: deps() });
  assert.ok(report.plugHint);
  assert.match(report.plugHint, /今晚 23:00 后插枪/);
  assert.match(report.plugHint, /¥0\.30/);

  // 正文渲染
  const sent = [];
  const n = createNotifier({ state: { pushRules: { matrix: { daily: { feishu: true } } } }, feishu: probeChannel(sent), telegram: null });
  await n.dispatch({ type: "daily", dateLabel: "10-18", kpi: { distanceKm: 5 }, plugHint: report.plugHint });
  assert.match(sent[0].body, /🔌 今晚 23:00 后插枪/);
});

// ---- P1-f monthly YTD ---------------------------------------------------------

test("monthly 年度累计行:月报专属,周报不出现", async () => {
  useMemoryStore();
  const monthWindows = [];
  // 月报:period rows + YTD rows(年初窗口)
  let call = 0;
  const depsM = () => ({
    db: makeFakeDb([
      { match: (s) => s.includes("charging_processes"), rows: [] },
      {
        match: () => true,
        rows: () => {
          call += 1;
          return call === 1 ? [{ id: 1, distance_km: 300, duration_min: 500, cost: 30 }] : [{ id: 2, distance_km: 3000, duration_min: 5000, cost: 300 }];
        }
      }
    ]),
    state: { pricing: { defaultRateCnyPerKwh: 0.6, history: [] }, fuelBaseline: { literPer100km: 8.0, fuelPriceCnyPerL: 8.2 } },
    computeTripViews: async (_db, drives) => drives.map((d) => ({ id: d.id, distanceKm: d.distance_km, energyKWh: 2, costCny: d.cost })),
    listDrivesSql: ({ from, to }) => { monthWindows.push(new Date(from).toISOString().slice(0, 10)); return { sql: "SELECT * FROM drives", params: [from, to] }; },
    listChargingForStats: async () => []
  });
  const report = await buildReport({ kind: "monthly", now: new Date("2026-10-18T02:00:00Z"), deps: depsM() });
  // 年初窗口(北京 1/1 00:00 在 UTC ISO 里是上一年 12-31)
  assert.ok(monthWindows.some((w) => w === "2025-12-31" || w.startsWith("2026-01")), `月报应额外聚合年初至今窗口,实际 ${monthWindows}`);
  assert.ok(report.ytd && report.ytd.distanceKm === 3000);
  assert.match(report.closing, /📈 年度至今 3000 km · 电费 ¥300\.00 · 较油车省 ¥1668\.00/);

  const weeklyDeps = () => ({
    db: makeFakeDb([{ match: () => true, rows: [] }]),
    state: { pricing: { defaultRateCnyPerKwh: 0.6, history: [] }, fuelBaseline: { literPer100km: 8.0, fuelPriceCnyPerL: 8.2 } },
    computeTripViews: async (_db, drives) => drives.map((d) => ({ id: d.id, distanceKm: d.distance_km, energyKWh: 2, costCny: d.cost })),
    listDrivesSql: () => ({ sql: "SELECT * FROM drives", params: [] }),
    listChargingForStats: async () => []
  });
  const weekly = await buildReport({ kind: "weekly", now: new Date("2026-10-15T02:00:00Z"), deps: weeklyDeps() });
  assert.equal(weekly.ytd, undefined);
  assert.doesNotMatch(weekly.closing ?? "", /年度至今/);
});
