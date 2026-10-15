// push-channels / report-engine / health / settings / auth-v2 单元与路由测试。
import { test } from "node:test";
import assert from "node:assert/strict";
import { useMemoryStore } from "../src/core/state.mjs";
import { openStore } from "../src/core/store.mjs";
import {
  createTelegramChannel, createWebPushChannel, createNotifier,
  saveChannelConfig, loadChannelConfig, matrixFromRules, defaultMatrix
} from "../src/core/push-channels.mjs";
import { buildReport, nextReportRun, startReportScheduler } from "../src/core/report-engine.mjs";
import { recordProbe, healthState, resetHealth } from "../src/core/health.mjs";
import { createAuthRoutes, resetLoginLockoutForTest } from "../src/api/auth-routes.mjs";
import { hashPassword } from "../src/api/auth.mjs";
import { lttbDownsample } from "../src/api/trips-routes.mjs";
import { createChargingRoutes } from "../src/api/charging-routes.mjs";
import { createApp, fetchApp } from "../src/api/http-kit.mjs";
import { createJwtMiddleware } from "../src/api/jwt.mjs";
import { loadSecretKey } from "../src/core/secret-box.mjs";

process.env.AHA_STATE_IN_MEMORY = "1";

// ---- helpers -----------------------------------------------------------------

function fakeCtx({ body = {}, cookies = {} } = {}) {
  return { body, cookies, headers: {}, req: { headers: {} }, setCookie() {}, res: { setHeader() {} } };
}

function makeFakeDb(routes) {
  return {
    async query(sql, params = []) {
      for (const { match, rows } of routes) {
        if (match(sql, params)) return typeof rows === "function" ? rows(sql, params) : rows;
      }
      return [];
    },
    async queryOne(sql, params = []) {
      const rows = await this.query(sql, params);
      return rows[0] ?? null;
    },
    ping: async () => true,
    close: async () => {}
  };
}

test("saveChannelConfig/loadChannelConfig：密文落库、明文可解、别名回显", () => {
  useMemoryStore();
  saveChannelConfig("telegram", { config: { enabled: true, chatId: "12345", botTokenAlias: "12345678…" }, secret: "bot-token-plain" });
  const loaded = loadChannelConfig("telegram");
  assert.equal(loaded.config.enabled, true);
  assert.equal(loaded.secret, "bot-token-plain");
  // 未设置 secret 时保留旧密文
  saveChannelConfig("telegram", { config: { enabled: false } });
  assert.equal(loadChannelConfig("telegram").secret, "bot-token-plain");
});

test("Telegram 渠道：disabled 不发；配置 + fetch 成功发送", async () => {
  useMemoryStore();
  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, body: JSON.parse(init.body) });
    if (url.includes("getMe")) return { json: async () => ({ ok: true, result: { username: "aha_bot" } }) };
    if (url.includes("sendMessage")) return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    return { json: async () => ({ ok: false }) };
  };
  const tg = createTelegramChannel({ fetchImpl });
  assert.equal(tg.enabled(), false);
  const disabled = await tg.send({ title: "t", body: "b" });
  assert.equal(disabled.sent, false);

  saveChannelConfig("telegram", { config: { enabled: true, chatId: "42", botTokenAlias: "12345678…" }, secret: "tok" });
  const r = await tg.send({ title: "行程结束", body: "¥9.47" });
  assert.equal(r.sent, true);
  assert.ok(fetchCalls.at(-1).url.includes("sendMessage"));
  assert.equal(fetchCalls.at(-1).body.chat_id, "42");
  assert.match(fetchCalls.at(-1).body.text, /行程结束/);
});

test("matrixFromRules：v1 布尔规则 → v2 矩阵兼容映射", () => {
  const m1 = matrixFromRules({ tripEnd: true, weeklyReport: false, monthlyReport: true, chargingStart: true, chargingDone: true });
  assert.deepEqual(m1.tripEnd, { webpush: true, telegram: true, feishu: true });
  assert.deepEqual(m1.weekly, { webpush: false, telegram: false, feishu: false });
  const m2 = matrixFromRules({}); // 无规则 → 默认矩阵
  assert.deepEqual(m2.chargingDone, { webpush: false, telegram: false, feishu: true });
});

test("Notifier.dispatch：矩阵命中渠道并行投递，单渠道失败隔离（AC-12.2）", async () => {
  useMemoryStore();
  const okChannel = { id: "okch", enabled: () => true, status: async () => ({}), send: async () => ({ sent: true }) };
  const badChannel = {
    id: "badch",
    enabled: () => true,
    status: async () => ({}),
    send: async () => { throw new Error("boom"); }
  };
  const state = { pushRules: { matrix: { tripEnd: { webpush: true, feishu: true } } } };
  // channels 映射：webpush→okChannel, feishu→badChannel（键固定为渠道名）
  const notifier = createNotifier({ state, webpush: okChannel, feishu: badChannel, telegram: null });
  const { results } = await notifier.dispatch({ type: "trip_end", distanceKm: 10, costCny: 3 });
  assert.equal(results.webpush.sent, true);
  assert.equal(results.feishu.sent, false);
  assert.match(results.feishu.reason, /boom/);
  assert.ok(typeof results.webpush.deliveryMs === "number");
});

test("report-engine：buildReport 周期聚合 + 油车对比 + topRoutes", async () => {
  useMemoryStore();
  const now = new Date("2026-10-15T02:00:00Z"); // 周四 → 周报期 = 上周一~周日
  const db = makeFakeDb([
    {
      match: (sql) => sql.includes("FROM drives"),
      rows: () => ([
        { id: 1, car_id: 1, start_at: "2026-10-06 01:00", end_at: "2026-10-06 02:00", distance_km: 30, duration_min: 60, start_address_id: null, end_address_id: null, efficiency: 0.15, ideal_used_km: 20, rated_used_km: 22, start_geofence_id: 1, end_geofence_id: 2 },
        { id: 2, car_id: 1, start_at: "2026-10-07 01:00", end_at: "2026-10-07 02:00", distance_km: 30, duration_min: 60, start_address_id: null, end_address_id: null, efficiency: 0.15, ideal_used_km: 20, rated_used_km: 22, start_geofence_id: 2, end_geofence_id: 1 }
      ])
    },
    { match: (sql) => sql.includes("charging_processes"), rows: [] },
    { match: (sql) => sql.includes("FROM addresses"), rows: [] },
    { match: (sql) => sql.includes("FROM geofences"), rows: [{ id: 1, name: "家" }, { id: 2, name: "公司" }] }
  ]);
  const deps = {
    db,
    state: { pricing: { defaultRateCnyPerKwh: 0.6, history: [] }, fuelBaseline: { literPer100km: 8.0, fuelPriceCnyPerL: 8.2 } },
    computeTripViews: async (_db, drives) => drives.map((d) => ({
      id: d.id, distanceKm: d.distance_km, energyKWh: 3, costCny: 1.8,
      routeKey: d.start_geofence_id === 1 ? "家 → 公司" : "公司 → 家"
    })),
    listDrivesSql: () => ({ sql: "SELECT * FROM drives", params: [] }),
    listChargingForStats: async () => []
  };
  const report = await buildReport({ kind: "weekly", now, deps });
  assert.equal(report.kpi.distanceKm, 60);
  assert.equal(report.kpi.driveCount, 2);
  assert.equal(report.kpi.fuelCost, 39.36); // 60km × 0.656
  assert.equal(report.topRoutes.length, 2);
  assert.match(report.periodLabel, /W\d+/);
  assert.match(report.baselineNote, /8L\/100km/);
});

test("report-engine：nextReportRun 周一 08:00 / 月 1 日 08:00", () => {
  const thu = new Date("2026-10-15T10:00:00+08:00"); // 周四
  const nextWeekly = nextReportRun("weekly", thu, "Asia/Shanghai");
  assert.equal(nextWeekly.getDay(), 1); // 周一
  assert.ok(nextWeekly > thu);
  const nextMonthly = nextReportRun("monthly", thu, "Asia/Shanghai");
  assert.equal(nextMonthly.getDate(), 1);
  assert.ok(nextMonthly > thu);
});

test("report 调度器：runKind 归档快照 + 同期去重", async () => {
  useMemoryStore();
  const store = openStore({ file: ":memory:" });
  const notifier = { dispatch: async () => ({ results: {} }) };
  const scheduler = startReportScheduler({
    store,
    buildDeps: () => ({
      db: makeFakeDb([]),
      state: { pricing: { defaultRateCnyPerKwh: 0.6, history: [] } },
      computeTripViews: async () => [],
      listDrivesSql: () => ({ sql: "SELECT 1", params: [] }),
      listChargingForStats: async () => []
    }),
    notifier,
    eventLog: { log() {} },
    state: {},
    setTimeoutImpl: () => 0
  });
  scheduler.stop();
  const first = await scheduler.runKind("weekly");
  assert.ok(first.id > 0);
  // 手动再触发一次同期 → 应跳过重复归档（返回 null）
  const dup = await scheduler.runKind("weekly");
  assert.equal(dup, null);
  const all = store.listReportSnapshots("weekly", 10);
  assert.equal(all.length, 1);
});

test("health：连续 2 次失败 → 断连；>2 分钟 → error 横幅；恢复清零", () => {
  resetHealth();
  recordProbe(true);
  assert.equal(healthState().dbOk, true);
  recordProbe(false);
  assert.equal(healthState().dbOk, true); // 1 次失败不算断
  recordProbe(false);
  const down = healthState();
  assert.equal(down.dbOk, false);
  assert.equal(down.bannerLevel, "warn");
  // 模拟失联 3 分钟
  const later = healthState(Date.now() + 3 * 60_000);
  assert.equal(later.bannerLevel, "error");
  recordProbe(true);
  assert.equal(healthState().dbOk, true);
});

test("LTTB：降采样保端点、保形状、点数受限", () => {
  const pts = Array.from({ length: 1000 }, (_, i) => ({ x: i, y: Math.sin(i / 100) }));
  const out = lttbDownsample(pts, 300);
  assert.equal(out.length, 300);
  assert.equal(out[0].x, 0);
  assert.equal(out.at(-1).x, 999);
  assert.ok(out.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  // 小数组原样返回
  assert.equal(lttbDownsample(pts.slice(0, 10), 300).length, 10);
});

test("auth：连续 5 次失败 → 429 锁定；成功登录清零", async () => {
  useMemoryStore();
  resetLoginLockoutForTest();
  const state = { username: "admin", passwordHash: await hashPassword("correct-pass-123"), pricing: { defaultRateCnyPerKwh: 1, history: [] }, pushRules: {}, feishu: { enabled: false } };
  const getSecret = () => Buffer.from("test-secret");
  const auth = createAuthRoutes({ state, getSecret, saveStateFn: () => {}, eventLog: { log() {} } });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => auth.login(fakeCtx({ body: { username: "admin", password: "wrong" } })), (e) => e.status === 401);
  }
  // 第 6 次：即使密码正确也应 429（锁定期）
  await assert.rejects(() => auth.login(fakeCtx({ body: { username: "admin", password: "correct-pass-123" } })), (e) => e.status === 429);
});

test("auth：refresh 双 Token（B3）——refresh cookie 换新 access", async () => {
  useMemoryStore();
  resetLoginLockoutForTest();
  const state = { username: "admin", passwordHash: await hashPassword("correct-pass-123"), pricing: { defaultRateCnyPerKwh: 1, history: [] }, pushRules: {}, feishu: { enabled: false } };
  const getSecret = () => loadSecretKey();
  const auth = createAuthRoutes({ state, getSecret, saveStateFn: () => {}, eventLog: { log() {} } });
  const cookies = {};
  const ctx = {
    body: { username: "admin", password: "correct-pass-123" },
    cookies: {},
    req: { headers: {} },
    setCookie(name, value) { cookies[name] = value; },
    res: { setHeader() {} }
  };
  await auth.login(ctx);
  assert.ok(cookies.ahatesla_token);
  assert.ok(cookies.ahatesla_refresh);
  const refreshCtx = fakeCtx({ cookies: { ahatesla_refresh: cookies.ahatesla_refresh } });
  const r = await auth.refresh(refreshCtx);
  assert.equal(r.ok, true);
  // 无 refresh cookie → 401
  await assert.rejects(() => auth.refresh(fakeCtx({})), (e) => e.status === 401);
});

test("charging list：month 筛选 SQL 透传", async () => {
  useMemoryStore();
  const db = makeFakeDb([
    { match: (sql, params) => sql.includes("charging_processes") && sql.includes("LIMIT"), rows: [{ id: 7, start_at: "2026-10-01 00:00", end_at: "2026-10-01 01:00", charge_energy_added: 20, geofence_name: "家" }] },
    { match: (sql) => sql.includes("count(*)"), rows: [{ total: 1 }] }
  ]);
  const state = { pricing: { defaultRateCnyPerKwh: 0.6, history: [] } };
  const routes = createChargingRoutes({ db, state, getStore: () => null });
  const result = await routes.list({ query: { month: "2026-10" }, ...fakeCtx() });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, 7);
  assert.ok(["manual", "geofence", "default", "unknown"].includes(result.items[0].costSource));
});

test("charging detail：功率曲线 + 桩端效率 + 峰值打点（B6）", async () => {
  useMemoryStore();
  const db = makeFakeDb([
    {
      match: (sql) => sql.includes("WHERE cp.id = $1"),
      rows: [{ id: 9, start_at: "2026-10-01 00:00", end_at: "2026-10-01 01:00", charge_energy_added: 50, charge_energy_used: 55, geofence_name: "超充", cost: 80, duration_min: 60, start_battery_level: 20, end_battery_level: 80 }]
    },
    {
      match: (sql) => sql.includes("FROM charges c"),
      rows: Array.from({ length: 50 }, (_, i) => ({ date: `2026-10-01 00:${String(i).padStart(2, "0")}`, battery_level: 20 + i, charger_power: i < 10 ? 100 + i : 250 - i * 2 }))
    }
  ]);
  const state = { pricing: { defaultRateCnyPerKwh: 0.6, history: [] } };
  const routes = createChargingRoutes({ db, state, getStore: () => null });
  const detail = await routes.detail({ params: { id: "9" }, ...fakeCtx() });
  assert.equal(detail.id, 9);
  assert.equal(detail.costSource, "manual"); // stated cost 80
  assert.ok(detail.powerCurve.length > 0);
  assert.ok(detail.powerCurve.length <= 300);
  assert.equal(detail.maxKw, 230);
  assert.equal(detail.maxKwSoc, 30);
  assert.equal(detail.efficiency.ratio, 0.9091);
  assert.equal(detail.efficiency.lossKwh, 5);
});

test("charging detail：charge_energy_used NULL → 隐藏损耗模块", async () => {
  useMemoryStore();
  const db = makeFakeDb([
    { match: (sql) => sql.includes("WHERE cp.id = $1"), rows: [{ id: 10, start_at: "2026-10-01 00:00", end_at: "2026-10-01 01:00", charge_energy_added: 30, charge_energy_used: null, geofence_name: "家" }] },
    { match: (sql) => sql.includes("FROM charges c"), rows: [] }
  ]);
  const state = { pricing: { defaultRateCnyPerKwh: 0.6, history: [] } };
  const routes = createChargingRoutes({ db, state, getStore: () => null });
  const detail = await routes.detail({ params: { id: "10" }, ...fakeCtx() });
  assert.equal(detail.efficiency, null);
});

test("系统状态路由：latencyMs + readonlyVerified 元数据探测", async () => {
  useMemoryStore();
  const db = makeFakeDb([
    { match: (sql) => sql.includes("has_table_privilege"), rows: [{ table_write: false, schema_create: false }] },
    { match: (sql) => sql.includes("drive_count"), rows: [{ drive_count: 10, last_drive_at: "2026-10-14" }] }
  ]);
  const { createSystemRoutes } = await import("../src/api/dashboard-routes.mjs");
  const system = createSystemRoutes({ db, mqtt: null, eventLog: { log() {} }, startedAt: () => Date.now() });
  const status = await system.status(fakeCtx());
  assert.equal(status.teslamate.dbOk, true);
  assert.ok(typeof status.teslamate.latencyMs === "number");
  assert.equal(status.teslamate.readonlyVerified, true);
  assert.equal(status.teslamate.mqtt, undefined); // 未配置不返回（B8）
});

test("settings 路由（GA-36）：读写 + 校验", async () => {
  useMemoryStore();
  const state = { settings: undefined, fuelBaseline: undefined };
  const { createSettingsRoutes } = await import("../src/api/dashboard-extra-routes.mjs");
  const routes = createSettingsRoutes({ state, getStore: () => openStore({ file: ":memory:" }) });
  const cur = await routes.get(fakeCtx());
  assert.equal(cur.currency.symbol, "¥");
  assert.equal(cur.distanceUnit, "km");
  assert.equal(cur.timezone, "Asia/Shanghai");
  await routes.put({ ...fakeCtx({ body: { currency: { symbol: "$", code: "USD" }, distanceUnit: "mi", fuelBaseline: { literPer100km: 9, fuelPriceCnyPerL: 7.5 } } }) });
  const next = await routes.get(fakeCtx());
  assert.equal(next.currency.symbol, "$");
  assert.equal(next.distanceUnit, "mi");
  assert.equal(next.fuelBaseline.literPer100km, 9);
  await assert.rejects(() => routes.put(fakeCtx({ body: { currency: { symbol: "₩" } } })), (e) => e.status === 400);
  await assert.rejects(() => routes.put(fakeCtx({ body: { timezone: "Not/AZone" } })), (e) => e.status === 400);
});

test("health-lite 匿名路由（GA-32）", async () => {
  resetHealth();
  const { createHealthLiteRoutes } = await import("../src/api/dashboard-extra-routes.mjs");
  const routes = createHealthLiteRoutes({});
  const r = await routes.healthLite(fakeCtx());
  assert.deepEqual(Object.keys(r).sort(), ["bannerLevel", "dbOk", "outageMs"]);
  assert.equal(r.dbOk, true);
});

test("timeline 路由：24h 状态段 + summary（P2 模块2）", async () => {
  useMemoryStore();
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const db = makeFakeDb([
    { match: (sql) => sql.includes("FROM drives d") && sql.includes("start_date ASC"), rows: [{ start_at: iso(now - 3 * 3600_000), end_at: iso(now - 2 * 3600_000) }] },
    { match: (sql) => sql.includes("charging_processes cp") && sql.includes("ORDER BY"), rows: [{ start_at: iso(now - 5 * 3600_000), end_at: iso(now - 4 * 3600_000) }] },
    { match: (sql) => sql.includes("FROM states s"), rows: [{ start_at: iso(now - 20 * 3600_000), end_at: iso(now - 5 * 3600_000), state: "asleep" }] }
  ]);
  const { createDashboardExtraRoutes } = await import("../src/api/dashboard-extra-routes.mjs");
  const routes = createDashboardExtraRoutes({ db, state: {} });
  const r = await routes.timeline(fakeCtx());
  assert.ok(r.segments.length > 0);
  assert.ok(r.segments.length <= 200);
  assert.ok(r.summary.drivingH > 0.9 && r.summary.drivingH < 1.1);
  assert.ok(r.summary.chargingH > 0.9 && r.summary.chargingH < 1.1);
  assert.ok(r.summary.asleepH > 0);
  const states = new Set(r.segments.map((s) => s.state));
  for (const s of states) assert.ok(["driving", "charging", "asleep", "online", "offline"].includes(s), `unexpected state ${s}`);
});

test("heatmap 路由：90 天按本地日期聚合（P2 模块4）", async () => {
  useMemoryStore();
  const day = 24 * 3600_000;
  const db = makeFakeDb([
    { match: (sql) => sql.includes("FROM drives d"), rows: () => [
      { end_at: new Date(Date.now() - 1 * day).toISOString(), distance: 42.5 },
      { end_at: new Date(Date.now() - 1 * day).toISOString(), distance: 7.5 },
      { end_at: new Date(Date.now() - 3 * day).toISOString(), distance: 10 }
    ] }
  ]);
  const { createDashboardExtraRoutes } = await import("../src/api/dashboard-extra-routes.mjs");
  const routes = createDashboardExtraRoutes({ db, state: {} });
  const r = await routes.heatmap({ query: {}, ...fakeCtx() });
  assert.equal(r.daysData.length, 90);
  assert.equal(r.maxKm, 50);
  const yday = r.daysData.find((d) => d.date === r.daysData.at(-2).date);
  assert.equal(yday.distanceKm, 50);
});
