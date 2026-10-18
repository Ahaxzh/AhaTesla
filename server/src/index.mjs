// index.mjs — AhaTesla server entry point.
// API on :18500 (PORT env) + static hosting of ../../web/dist when present.
// Worker (trip monitor + MQTT signals + push dispatch + report scheduler) runs in this process.

// 出网代理支持：Node 内置 fetch（undici）不读 HTTP(S)_PROXY 环境变量。
// Telegram/飞书等外呼在有代理变量的环境下必须显式接管 dispatcher，否则直连超时。
// 本机无代理变量时零开销（不设置 dispatcher）。
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy) {
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { loadSecretKey, dataDir } from "./core/secret-box.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { createDb } from "./core/db.mjs";
import { isDemo, createDemoDb } from "./core/demo-data.mjs";
import { loadState, saveState, getStore } from "./core/state.mjs";
import { createEventLog } from "./core/events.mjs";
import { createFeishuChannel } from "./core/feishu.mjs";
import { TripMonitor, startTripMonitorLoop } from "./core/trip-monitor.mjs";
import { startMqttBridge } from "./core/mqtt-bridge.mjs";
import { createNotifier, createTelegramChannel, createWebPushChannel, createWecomChannel, createNtfyChannel, createBarkChannel } from "./core/push-channels.mjs";
import { startReportScheduler } from "./core/report-engine.mjs";
import { recordProbe, createOutageWatcher } from "./core/health.mjs";
import { checkTirePressure } from "./core/alerts.mjs";
import { signJwt, verifyJwt, TOKEN_COOKIE } from "./api/auth.mjs";
import { createApp, parseCookies } from "./api/http-kit.mjs";
import { createJwtMiddleware } from "./api/jwt.mjs";
import { createAuthRoutes } from "./api/auth-routes.mjs";
import { createTripsRoutes } from "./api/trips-routes.mjs";
import { createChargingRoutes } from "./api/charging-routes.mjs";
import { createPricingRoutes } from "./api/pricing-routes.mjs";
import { createLedgerRoutes } from "./api/ledger-routes.mjs";
import { createChannelRoutes } from "./api/channel-routes.mjs";
import { createDashboardRoutes, createSystemRoutes } from "./api/dashboard-routes.mjs";
import { createDashboardExtraRoutes, createSettingsRoutes, createHealthLiteRoutes } from "./api/dashboard-extra-routes.mjs";
import { createSetupRoutes } from "./api/setup-routes.mjs";
import { createPushRoutes } from "./api/push-routes.mjs";
import { createAiRoutes } from "./api/ai-routes.mjs";
import { createAiCopywriter } from "./core/ai-copywriter.mjs";
import { computeTripViews as tripsComputeTripViews } from "./api/trips-routes.mjs";
import { listDrivesSql, listChargingForStats } from "./core/teslamate-queries.mjs";
import { enrichTripEndEvent, enrichChargingDoneEvent, enrichChargingStartEvent } from "./core/event-enrichment.mjs";

const PORT = Number(process.env.PORT) || 18500;
const DB_URL = process.env.DB_URL || "postgres://teslamate@127.0.0.1:15432/teslamate";
// MQTT 可选增强（§7.1）：仅显式配置 MQTT_URL 时启用；默认不配置（纯轮询基线）。
const MQTT_URL = process.env.MQTT_URL || "";

// 事件类型 → 推送矩阵开关（state.pushRules 键名），见 docs/API_CONTRACT.md §6。
const EVENT_PUSH_RULE = Object.freeze({
  trip_end: "tripEnd",
  charging_start: "chargingStart",
  charging_done: "chargingDone"
});

function log(...args) {
  process.stdout.write(`[${new Date().toISOString()}] ${args.join(" ")}\n`);
}

// ---- bootstrap state ------------------------------------------------------

// AC-1.4：无预设明文密码。管理员账号由 /setup 向导首位注册创建（t_3f9fe52a）；
// bootstrap 不再生成/打印初始密码。保留函数供旧测试导入兼容。
export async function bootstrap({ db, statePathEnv } = {}) {
  loadSecretKey();
  const state = loadState();
  return state;
}

export function buildApp({ db, state, eventLog, mqtt, startedAt, notifier = null, reportScheduler = null, buildDeps = null, ai = null }) {
  const getSecret = () => loadSecretKey();
  const requireAuth = createJwtMiddleware({ getSecret });
  const feishu = createFeishuChannel(state, { logger: (msg) => eventLog.log("feishu.error", { message: msg }) });

  const app = createApp({ onError: (error) => eventLog.log("server.error", { message: error?.message }) });

  registerRoutes(app, { requireAuth, getSecret, state, db, eventLog, mqtt, startedAt, feishu, notifier, reportScheduler, buildDeps, ai });

  return { app, feishu };
}

// 路由注册统一入口：buildApp 与 main() 重建路由共用，避免两份清单漂移。
function registerRoutes(app, { requireAuth, getSecret, state, db, eventLog, mqtt, startedAt, feishu, setupDeps = null, notifier = null, reportScheduler = null, buildDeps = null, ai = null }) {
  const auth = createAuthRoutes({ state, getSecret, eventLog });
  const setup = setupDeps ?? createSetupRoutes({ state, db, getSecret, saveStateFn: saveState, eventLog, currentDbUrl: process.env.DB_URL });
  const trips = createTripsRoutes({ db, state });
  const charging = createChargingRoutes({ db, state, getStore });
  const pricing = createPricingRoutes({ db, state, getStore });
  const ledger = createLedgerRoutes({ db, state, getStore });
  const channels = createChannelRoutes({ state, feishu, eventLog });
  const dashboard = createDashboardRoutes({ db, state });
  const dashboardExtra = createDashboardExtraRoutes({ db, state });
  const settingsRoutes = createSettingsRoutes({ state, getStore });
  const healthLite = createHealthLiteRoutes({});
  const system = createSystemRoutes({ db, mqtt, eventLog, startedAt });
  const push = createPushRoutes({ state, notifier, eventLog, store: getStore(), reportScheduler, buildDeps });
  // registerRoutes 也被测试直接调用：ai 未注入时兜底一个全局 store 实例
  const aiRoutes = createAiRoutes({ ai: ai ?? createAiCopywriter({ eventLog }), eventLog });

  // /api/setup/*（契约 §1）：status 匿名；admin 仅 uninitialized；其余需管理员登录。
  app.get("/api/setup/status", (ctx) => setup.status(ctx));
  app.post("/api/setup/admin", (ctx) => setup.registerAdmin(ctx));
  app.post("/api/setup/test-connection", requireAuth, (ctx) => setup.testConnection(ctx));
  app.post("/api/setup/datasource", requireAuth, (ctx) => setup.saveDatasource(ctx));
  app.get("/api/setup/car-discovery", requireAuth, (ctx) => setup.carDiscovery(ctx));
  app.post("/api/setup/select-car", requireAuth, (ctx) => setup.selectCar(ctx));
  // m4a 轨道 B（存量接入）：候选地址探测 + 一次性凭据自动建只读账号。
  app.post("/api/setup/probe-discovery", requireAuth, (ctx) => setup.probeDiscovery(ctx));
  app.post("/api/setup/auto-ro", requireAuth, (ctx) => setup.autoRo(ctx));

  app.post("/api/auth/login", (ctx) => auth.login(ctx));
  app.post("/api/auth/refresh", (ctx) => auth.refresh(ctx));
  app.post("/api/auth/logout", (ctx) => auth.logout(ctx));
  app.post("/api/auth/change-password", requireAuth, (ctx) => auth.changePassword(ctx));
  app.post("/api/auth/sessions/revoke-all", requireAuth, (ctx) => auth.revokeAll(ctx));
  app.get("/api/auth/me", requireAuth, (ctx) => auth.me(ctx));

  app.get("/api/dashboard", requireAuth, (ctx) => dashboard.dashboard(ctx));
  app.get("/api/cars", requireAuth, (ctx) => dashboard.cars(ctx));
  app.get("/api/dashboard/timeline", requireAuth, (ctx) => dashboardExtra.timeline(ctx));
  app.get("/api/dashboard/heatmap", requireAuth, (ctx) => dashboardExtra.heatmap(ctx));
  app.get("/api/trips", requireAuth, (ctx) => trips.list(ctx));
  app.get("/api/trips/:id", requireAuth, (ctx) => trips.detail(ctx));
  app.get("/api/charging", requireAuth, (ctx) => charging.list(ctx));
  app.get("/api/charging/stats", requireAuth, (ctx) => charging.stats(ctx));
  app.get("/api/charging/:id", requireAuth, (ctx) => charging.detail(ctx));
  app.put("/api/charging/:id/cost", requireAuth, (ctx) => ledger.putChargeCost(ctx));
  app.post("/api/ledger/summary", requireAuth, (ctx) => ledger.summary(ctx));
  app.post("/api/ledger/recalculate", requireAuth, (ctx) => ledger.startRecalculate(ctx));
  app.get("/api/ledger/recalculate/:jobId", requireAuth, (ctx) => ledger.recalculateStatus(ctx));
  app.get("/api/pricing", requireAuth, (ctx) => pricing.list(ctx));
  app.put("/api/pricing/default", requireAuth, (ctx) => pricing.setDefault(ctx));
  app.put("/api/pricing/locations/:id", requireAuth, (ctx) => pricing.updateLocation(ctx));
  app.get("/api/pricing/history", requireAuth, (ctx) => pricing.history(ctx));
  app.get("/api/settings", requireAuth, (ctx) => settingsRoutes.get(ctx));
  app.put("/api/settings", requireAuth, (ctx) => settingsRoutes.put(ctx));
  app.get("/api/channels", requireAuth, (ctx) => push.listChannels(ctx));
  app.put("/api/channels/feishu", requireAuth, (ctx) => channels.updateFeishu(ctx));
  app.post("/api/channels/feishu/test", requireAuth, (ctx) => channels.testFeishu(ctx));
  app.put("/api/channels/telegram", requireAuth, (ctx) => push.updateTelegram(ctx));
  app.post("/api/channels/telegram/test", requireAuth, (ctx) => push.testTelegram(ctx));
  // m4b 三渠道：企业微信 / ntfy / Bark（契约 §channels）
  app.put("/api/channels/wecom", requireAuth, (ctx) => push.updateWecom(ctx));
  app.post("/api/channels/wecom/test", requireAuth, (ctx) => push.testWecom(ctx));
  app.put("/api/channels/ntfy", requireAuth, (ctx) => push.updateNtfy(ctx));
  app.post("/api/channels/ntfy/test", requireAuth, (ctx) => push.testNtfy(ctx));
  app.put("/api/channels/bark", requireAuth, (ctx) => push.updateBark(ctx));
  app.post("/api/channels/bark/test", requireAuth, (ctx) => push.testBark(ctx));
  // BYO 模型（契约 §AI，m4c-c3）
  app.get("/api/ai/config", requireAuth, (ctx) => aiRoutes.get(ctx));
  app.put("/api/ai/config", requireAuth, (ctx) => aiRoutes.put(ctx));
  app.post("/api/ai/test", requireAuth, (ctx) => aiRoutes.test(ctx));
  app.post("/api/push/webpush/subscribe", requireAuth, (ctx) => push.webpushSubscribe(ctx));
  app.post("/api/push/webpush/unsubscribe", requireAuth, (ctx) => push.webpushUnsubscribe(ctx));
  app.post("/api/push/webpush/test", requireAuth, (ctx) => push.webpushTest(ctx));
  app.post("/api/push/webpush/init-vapid", requireAuth, (ctx) => push.webpushInitVapid(ctx));
  app.get("/api/push/env", (ctx) => push.getPushEnv(ctx)); // 匿名（AC-11.0 前端置灰依据）
  app.get("/api/push-rules", requireAuth, (ctx) => push.getPushRules(ctx));
  app.put("/api/push-rules", requireAuth, (ctx) => push.putPushRules(ctx));
  app.get("/api/reports", requireAuth, (ctx) => push.listReports(ctx));
  app.get("/api/reports/:id", requireAuth, (ctx) => push.reportDetail(ctx));
  app.post("/api/reports/generate", requireAuth, (ctx) => push.generateReport(ctx));
  app.get("/api/system/status", requireAuth, (ctx) => system.status(ctx));
  app.get("/api/system/events", requireAuth, (ctx) => system.events(ctx));
  app.get("/api/system/health-lite", (ctx) => healthLite.healthLite(ctx)); // 匿名探活（GA-32）
}

// ---- static hosting --------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".map": "application/json"
};

export function createStaticHandler(rootDir) {
  if (!rootDir || !existsSync(rootDir)) return null;
  return async (req, res, pathname) => {
    let rel = pathname === "/" ? "/index.html" : pathname;
    const filePath = join(rootDir, rel);
    if (!filePath.startsWith(rootDir)) return false;
    try {
      const content = await readFile(filePath);
      const ext = filePath.slice(filePath.lastIndexOf("."));
      // 缓存策略：HTML 与 SW 永远走网络（发版即生效）；带 hash 的构建产物长缓存
      const isHtml = ext === ".html" || pathname === "/";
      const isSw = rel === "/service-worker.js";
      const hashed = /-[A-Za-z0-9_-]{8}\.(js|css|png|svg|woff2?)$/.test(rel);
      const cacheControl = isHtml || isSw
        ? "no-cache, must-revalidate"
        : hashed
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600";
      res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": cacheControl });
      res.end(content);
      return true;
    } catch {
      // SPA fallback
      try {
        const index = await readFile(join(rootDir, "index.html"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache, must-revalidate" });
        res.end(index);
        return true;
      } catch {
        return false;
      }
    }
  };
}

// ---- MQTT signal bridge ------------------------------------------------------

// MQTT 为可选增强（§7.1）：仅 MQTT_URL 显式配置时启用；未配置/连不上时优雅
// 降级为纯轮询基线（事件捕获不依赖 MQTT）。只读订阅，绝不发布车辆命令。
async function startMqtt({ monitor, eventLog, loop }) {
  try {
    const bridge = await startMqttBridge({
      url: MQTT_URL,
      monitor,
      eventLog,
      logger: (message) => log("mqtt:", message)
    });
    if (!bridge) return null;
    // MQTT 充电边沿到达 → 立即触发一次轮询（DB 权威行产生事件；双源一致 AC-12.1b）
    bridge.onBoundary = () => loop?.poke?.();
    return bridge;
  } catch (error) {
    log("mqtt unavailable:", error.message);
    return null;
  }
}

// ---- main --------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  const state = await bootstrap();
  // §7.1 事件日志落 SQLite（进程重启可回看）；getStore 顺带完成 JSON→SQLite 一次性迁移。
  const eventLog = createEventLog({ store: getStore() });
  // AHATESLA_DEMO=1：不连 TeslaMate 库，全部查询由确定性种子数据应答（m4d 演示模式）
  const db = isDemo() ? createDemoDb() : createDb(DB_URL);
  if (isDemo()) log("DEMO MODE — AHATESLA_DEMO=1：数据为合成演示数据，未连接任何 TeslaMate 库");

  // 实例设置（GA-36）：货币/单位/时区/油车基准 —— kv 持久化，启动时恢复进 state
  {
    const store0 = getStore();
    try {
      const rawSettings = store0.kvGet("app:settings");
      if (rawSettings) state.settings = { ...(state.settings || {}), ...JSON.parse(rawSettings) };
      const rawFb = store0.kvGet("app:fuelBaseline");
      if (rawFb) state.fuelBaseline = { ...state.fuelBaseline, ...JSON.parse(rawFb) };
    } catch { /* 坏数据忽略，走默认 */ }
  }

  // GA-39（§7.4 崩溃自愈）：monitor 状态（水线游标 + sent_keys/pending_events）
  // 持久化到 SQLite kv，重启恢复，避免重复推送/水线重算。防抖写回（节流 2s）。
  const MONITOR_STATE_KEY = "monitor_state_v1";
  const store = getStore();
  const savedMonitorState = (() => {
    try {
      const raw = store.kvGet(MONITOR_STATE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  })();
  let monitorSaveTimer = null;
  const persistMonitorState = () => {
    if (monitorSaveTimer) return;
    monitorSaveTimer = setTimeout(() => {
      monitorSaveTimer = null;
      try {
        store.kvPut(MONITOR_STATE_KEY, JSON.stringify(monitor.state));
      } catch (error) {
        eventLog?.log?.("monitor.persist_error", { message: error.message });
      }
    }, 2_000);
    monitorSaveTimer.unref?.();
  };

  const monitor = new TripMonitor({
    state: savedMonitorState,
    onEvent: (event) => {
      eventLog.log("push.event", { type: event.type, eventKey: event.eventKey });
      dispatchPush(event).catch((error) => eventLog.log("push.error", { message: error.message }));
    }
  });

  // ---- Notifier（三渠道抽象，GA-08）+ AI 润色（m4c-c3）+ 报告调度器（GA-11） ----
  const feishuChannel = createFeishuChannel(state, { logger: (msg) => eventLog.log("feishu.error", { message: msg }) });
  const ai = createAiCopywriter({ store, eventLog });
  const notifier = createNotifier({
    state,
    eventLog,
    feishu: feishuChannel,
    telegram: createTelegramChannel({ logger: (m) => eventLog.log("telegram.error", { message: m }) }),
    webpush: createWebPushChannel({ logger: (m) => eventLog.log("webpush.error", { message: m }) }),
    wecom: createWecomChannel({ logger: (m) => eventLog.log("wecom.error", { message: m }) }),
    ntfy: createNtfyChannel({ logger: (m) => eventLog.log("ntfy.error", { message: m }) }),
    bark: createBarkChannel({ logger: (m) => eventLog.log("bark.error", { message: m }) }),
    ai
  });
  // 报告构建依赖（computeTripViews/listDrivesSql/listChargingForStats 已静态导入）
  const reportBuildDeps = () => ({
    db, state,
    computeTripViews: tripsComputeTripViews,
    listDrivesSql,
    listChargingForStats
  });
  const reportScheduler = startReportScheduler({
    store,
    buildDeps: reportBuildDeps,
    notifier,
    eventLog,
    state,
    tz: state.settings?.timezone || "Asia/Shanghai",
    logger: (msg) => log("report:", msg)
  });

  const { app, feishu } = buildApp({ db, state, eventLog, mqtt: null, startedAt, notifier, reportScheduler, buildDeps: reportBuildDeps, ai });

  // ---- m4e 多车:推送事件的车辆标记(60s 车辆缓存) --------------------------
  let carsCache = { at: 0, list: null };
  async function carsListCached() {
    if (carsCache.list && Date.now() - carsCache.at < 60_000) return carsCache.list;
    try {
      const rows = await db.query("SELECT id, name FROM cars ORDER BY id ASC");
      carsCache = { at: Date.now(), list: rows };
    } catch {
      carsCache = { at: Date.now(), list: carsCache.list || [] }; // 查询失败沿用旧缓存
    }
    return carsCache.list;
  }
  async function carIdOfEvent(event) {
    try {
      if (event.type === "trip_end" && Array.isArray(event.segment_ids) && event.segment_ids.length) {
        const r = await db.queryOne("SELECT car_id FROM drives WHERE id = $1", [Number(event.segment_ids[0])]);
        return r?.car_id ?? null;
      }
      if ((event.type === "charging_start" || event.type === "charging_done" || event.type === "chargeInterrupt")
        && event.charging_process_id) {
        const r = await db.queryOne("SELECT car_id FROM charging_processes WHERE id = $1", [Number(event.charging_process_id)]);
        return r?.car_id ?? null;
      }
    } catch { /* 查不到就不标记 */ }
    return null;
  }
  async function carLabelForEvent(event) {
    const cars = await carsListCached();
    if (!cars || cars.length <= 1) return null; // 单车实例:标题零变化
    const carId = event.carId ?? await carIdOfEvent(event);
    if (carId == null) return null;
    const car = cars.find((c) => Number(c.id) === Number(carId));
    if (!car) return null;
    return state.settings?.carAliases?.[String(carId)] || car.name;
  }

  async function dispatchPush(rawEvent) {
    // 事件富化（v2.2 + P1 b/c/d）：天气/胎压/速度/怠速 + 计价批次 + 充电预估/对比
    let event = rawEvent;
    try {
      if (event.type === "trip_end") {
        event = await enrichTripEndEvent(db, event, {
          defaultRate: state.pricing.defaultRateCnyPerKwh,
          defaultRateHistory: state.pricing.history
        });
      } else if (event.type === "charging_done") event = await enrichChargingDoneEvent(db, event);
      else if (event.type === "charging_start") event = await enrichChargingStartEvent(db, event);
    } catch (error) {
      eventLog.log("push.enrich_error", { message: error.message });
    }
    // m4e 多车:车辆标记。cars ≤1 时零变化(不挂 carLabel,标题不加后缀);
    // 多车时 trip/charging 事件按事件源车挂 `carLabel`(别名优先),标题后缀 `· 别名`。
    try {
      const label = await carLabelForEvent(event);
      if (label) event.carLabel = label;
    } catch { /* 标记失败不影响推送 */ }
    // 矩阵化投递（GA-08/AC-12.2）：多渠道并行 + 单渠道失败隔离 + deliveryMs 埋点
    const t0 = Date.now();
    const { results } = await notifier.dispatch(event);
    const anySent = Object.values(results).some((r) => r?.sent);
    const deliveryMs = Date.now() - t0;
    eventLog.log("push.dispatch", { type: event.type, results, deliveryMs });
    if (anySent && event.eventKey) monitor.acknowledge(event.eventKey);

    // P2 告警派生:充电结束且明显提前(富化层 endBattery<80 置 endedEarly)→
    // 独立更醒目的 chargeInterrupt 告警(charging_done 照常已发,两者并存)。
    // charging_done 本身每会话恰一次(monitor 去重) → 派生事件天然每会话一次。
    if (event.type === "charging_done" && event.endedEarly) {
      try {
        const alarm = await notifier.dispatch({
          type: "chargeInterrupt",
          charging_process_id: event.charging_process_id,
          endBattery: event.endBattery,
          energyKwh: event.energyKwh,
          locationName: event.locationName
        });
        eventLog.log("push.dispatch", { type: "chargeInterrupt", derived: true, results: alarm.results, deliveryMs: Date.now() - t0 });
      } catch (error) {
        eventLog.log("push.error", { message: `chargeInterrupt: ${error.message}` });
      }
    }
  }

  const staticHandler = createStaticHandler(join(__dirname, "..", "..", "web", "dist"));
  const server = app.listen(PORT, "0.0.0.0", () => {
    log(`AhaTesla server listening on :${PORT} (data: ${dataDir()})`);
    if (staticHandler) log("serving web/dist");
  });

  // static hosting via the raw server "request" pre-hook:
  const rawHandler = server.listeners("request")[0];
  server.removeAllListeners("request");
  server.on("request", async (req, res) => {
    if (req.method === "GET" && !req.url.startsWith("/api/")) {
      const pathname = new URL(req.url, "http://localhost").pathname;
      const served = staticHandler ? await staticHandler(req, res, pathname) : false;
      if (served) return;
    }
    rawHandler(req, res);
  });

  // P2 告警:数据断联/恢复(边沿各一次,共用 outage 矩阵行)
  const outageWatcher = createOutageWatcher({
    thresholdMs: 10 * 60_000,
    onOutage: (ms) => dispatchPush({ type: "outage", outageMs: ms }).catch(() => {}),
    onRecovered: (ms) => dispatchPush({ type: "outage_recovered", outageMs: ms }).catch(() => {})
  });

  // P2 告警:胎压巡检(随监控循环同频,越限且距上次告警 ≥24h 才推)
  if (!state.alerts) state.alerts = {};
  async function patrolTirePressure() {
    const now = Date.now();
    if (state.alerts.lastTireAlertAt && now - state.alerts.lastTireAlertAt < 24 * 3600_000) return;
    const r = await checkTirePressure(db);
    if (!r) return;
    state.alerts.lastTireAlertAt = now;
    try { saveState(state); } catch { /* 节流窗内存生效即可 */ }
    await dispatchPush({
      type: "tirePressure", tirePressure: r, minBar: r.min, suggest: r.suggest
    }).catch(() => {});
  }

  const loop = startTripMonitorLoop({
    monitor,
    db,
    // 探活结果喂给健康状态机（GA-32 失联横幅数据源）；失败由 loop 内部 logger 兜底
    // P2:同一帧喂断联观察者(≥10min 边沿推送)与胎压巡检(24h 节流)
    onPollResult: (ok) => {
      const result = recordProbe(ok);
      outageWatcher.observe(result);
      void patrolTirePressure();
    },
    logger: (message) => eventLog.log("monitor.error", { message })
  });
  // GA-39：周期 + 事件驱动节流持久化 monitor 状态（水线游标/sent_keys/pending_events）
  const origPoke = loop.poke.bind(loop);
  loop.poke = () => Promise.resolve(origPoke()).finally(persistMonitorState);
  const persistTimer = setInterval(persistMonitorState, 30_000);
  persistTimer.unref?.();

  // loop 先建，MQTT 充电边沿才能 poke 即时轮询（§7.1 增强路径）
  const mqttBridge = await startMqtt({ monitor, eventLog, loop });
  if (mqttBridge) {
    const requireAuth2 = createJwtMiddleware({ getSecret: () => loadSecretKey() });
    app.routes.length = 0;
    registerRoutes(app, { requireAuth: requireAuth2, getSecret: () => loadSecretKey(), state, db, eventLog, mqtt: mqttBridge, startedAt, feishu, notifier, reportScheduler, buildDeps: reportBuildDeps, ai });
    log(`mqtt enabled (optional enhancement): ${MQTT_URL}`);
  } else if (MQTT_URL) {
    log(`mqtt configured but unavailable — degraded to polling baseline: ${MQTT_URL}`);
  } else {
    log("mqtt not configured — polling baseline only (§7.1)");
  }

  const shutdown = async () => {
    loop.stop();
    reportScheduler?.stop?.();
    clearInterval(persistTimer);
    if (monitorSaveTimer) { clearTimeout(monitorSaveTimer); }
    try { store.kvPut(MONITOR_STATE_KEY, JSON.stringify(monitor.state)); } catch {}
    await mqttBridge?.close?.();
    server.close();
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run main when executed directly (not under --test import).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`fatal: ${error.stack || error}\n`);
    process.exit(1);
  });
}
