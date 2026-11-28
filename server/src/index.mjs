// index.mjs — AhaTesla server entry point（组合根：只做装配与生命周期，不装领域逻辑）。
// API on :18500 (PORT env) + static hosting of ../../web/dist when present.
// Worker (trip monitor + MQTT signals + push dispatch + report scheduler) runs in this process.
//
// 领域逻辑归属（B5 解耦后）：
//   推送管线 core/push-dispatch · 巡检 core/patrols · 保养判定 core/maintenance
//   monitor 持久化 core/monitor-persistence · 静态托管 api/static

// 出网代理支持：Node 内置 fetch（undici）不读 HTTP(S)_PROXY 环境变量。
// Telegram/飞书等外呼在有代理变量的环境下必须显式接管 dispatcher，否则直连超时。
// 本机无代理变量时零开销（不设置 dispatcher）。
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy) {
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSecretKey, dataDir, decryptSecret } from "./core/secret-box.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { createDb } from "./core/db.mjs";
import { isDemo, createDemoDb } from "./core/demo-data.mjs";
import { loadState, saveState, getStore } from "./core/state.mjs";
import { createEventLog } from "./core/events.mjs";
import { createFeishuChannel } from "./core/feishu.mjs";
import { TripMonitor, startTripMonitorLoop } from "./core/trip-monitor.mjs";
import { createMonitorPersistence } from "./core/monitor-persistence.mjs";
import { createPushDispatch } from "./core/push-dispatch.mjs";
import { createPatrols } from "./core/patrols.mjs";
import { startMqttBridge } from "./core/mqtt-bridge.mjs";
import { createNotifier, createTelegramChannel, createWebPushChannel, createWecomChannel, createNtfyChannel, createBarkChannel } from "./core/push-channels.mjs";
import { startReportScheduler } from "./core/report-engine.mjs";
import { getBatteryHealth } from "./core/battery-health.mjs";
import { carIdFromQuery } from "./api/car-scope.mjs";
import { recordProbe, createOutageWatcher } from "./core/health.mjs";
import { createApp } from "./api/http-kit.mjs";
import { createJwtMiddleware } from "./api/jwt.mjs";
import { createStaticHandler } from "./api/static.mjs";
import { createAuthRoutes } from "./api/auth-routes.mjs";
import { createTripsRoutes } from "./api/trips-routes.mjs";
import { createChargingRoutes } from "./api/charging-routes.mjs";
import { createPricingRoutes } from "./api/pricing-routes.mjs";
import { createLedgerRoutes } from "./api/ledger-routes.mjs";
import { createExportRoutes } from "./api/export-routes.mjs";
import { createMaintenanceRoutes } from "./api/maintenance-routes.mjs";
import { createDashboardRoutes } from "./api/dashboard-routes.mjs";
import { createDashboardExtraRoutes } from "./api/dashboard-extra-routes.mjs";
import { createSettingsRoutes } from "./api/settings-routes.mjs";
import { createSystemRoutes, createHealthLiteRoutes } from "./api/system-routes.mjs";
import { createSetupRoutes } from "./api/setup-routes.mjs";
import { createPushRoutes } from "./api/push-routes.mjs";
import { createAiRoutes } from "./api/ai-routes.mjs";
import { createAiCopywriter } from "./core/ai-copywriter.mjs";
import { computeTripViews } from "./core/trip-views.mjs";
import { listDrivesSql, listChargingForStats } from "./core/teslamate-queries.mjs";

const PORT = Number(process.env.PORT) || 18500;
// MQTT 可选增强（§7.1）：仅显式配置 MQTT_URL 时启用；默认不配置（纯轮询基线）。
const MQTT_URL = process.env.MQTT_URL || "";

function log(...args) {
  process.stdout.write(`[${new Date().toISOString()}] ${args.join(" ")}\n`);
}

// 红线 2：URL 凭据（mqtt://user:pass@host）不得进日志 —— 打日志前抹掉 userinfo。
function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "";
    }
    return u.toString();
  } catch {
    return "<invalid-url>";
  }
}

// AC-1.4：无预设明文密码，管理员账号由 /setup 向导首位注册创建。

export function buildApp({ db, state, eventLog, mqtt = null, startedAt, notifier = null, reportScheduler = null, buildDeps = null, ai = null }) {
  const getSecret = () => loadSecretKey();
  const requireAuth = createJwtMiddleware({ getSecret });
  const app = createApp({ onError: (error) => eventLog.log("server.error", { message: error?.message }) });

  registerRoutes(app, { requireAuth, getSecret, state, db, eventLog, mqtt, startedAt, notifier, reportScheduler, buildDeps, ai });

  return app;
}

// 路由注册统一入口（buildApp 与测试共用，避免两份清单漂移）。
// 注：静态路由表 + :id 顺序匹配 —— 汇总/habits/energy-curve 必须先于 /:id 注册。
export function registerRoutes(app, { requireAuth, getSecret, state, db, eventLog, mqtt, startedAt, setupDeps = null, notifier = null, reportScheduler = null, buildDeps = null, ai = null }) {
  const auth = createAuthRoutes({ state, getSecret, eventLog });
  const setup = setupDeps ?? createSetupRoutes({ state, db, getSecret, saveStateFn: saveState, eventLog, currentDbUrl: process.env.DB_URL }); // db.retarget 由 saveDatasource 注入下方
  const trips = createTripsRoutes({ db, state });
  const charging = createChargingRoutes({ db, state, getStore });
  const pricing = createPricingRoutes({ db, state, getStore });
  const ledger = createLedgerRoutes({ db, state, getStore });
  const exportRoutes = createExportRoutes({ db, state });
  const maintenance = createMaintenanceRoutes({ db, store: getStore() });
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
  app.get("/api/battery-health", requireAuth, async (ctx) => getBatteryHealth(db, { carId: carIdFromQuery(ctx, state) }));
  app.get("/api/dashboard/heatmap", requireAuth, (ctx) => dashboardExtra.heatmap(ctx));
  app.get("/api/trips", requireAuth, (ctx) => trips.list(ctx));
  // 汇总与轨迹必须在 :id 之前注册（手写路由按注册顺序匹配）
  app.get("/api/trips/overview", requireAuth, (ctx) => trips.overview(ctx));
  app.get("/api/trips/route-summary", requireAuth, (ctx) => trips.routeSummary(ctx));
  app.get("/api/trips/display-accuracy", requireAuth, (ctx) => trips.displayAccuracy(ctx));
  app.get("/api/trips/efficiency-profile", requireAuth, (ctx) => trips.efficiencyProfile(ctx));
  // v2.8.2 车机能量曲线（positions 1km 分桶）：须在 :id 前注册（同上，顺序匹配）
  app.get("/api/trips/energy-curve", requireAuth, (ctx) => trips.energyCurve(ctx));
  app.get("/api/trips/:id", requireAuth, (ctx) => trips.detail(ctx));
  app.get("/api/charging", requireAuth, (ctx) => charging.list(ctx));
  app.get("/api/charging/stats", requireAuth, (ctx) => charging.stats(ctx));
  // habits 必须在 /:id 之前注册（手写路由按注册顺序匹配）
  app.get("/api/charging/habits", requireAuth, (ctx) => charging.habits(ctx));
  app.get("/api/charging/:id", requireAuth, (ctx) => charging.detail(ctx));
  app.put("/api/charging/:id/cost", requireAuth, (ctx) => ledger.putChargeCost(ctx));
  app.post("/api/ledger/summary", requireAuth, (ctx) => ledger.summary(ctx));
  // CSV 导出（v2.4）：attachment 响应（ctx.res.end 原生写，不走 ctx.json）
  app.get("/api/export/trips", requireAuth, (ctx) => exportRoutes.trips(ctx));
  app.get("/api/export/charging", requireAuth, (ctx) => exportRoutes.charging(ctx));
  // 保养里程提醒（v2.5）：配置 kv 持久化；状态读 + 配置写
  app.get("/api/maintenance", requireAuth, (ctx) => maintenance.get(ctx));
  app.put("/api/maintenance", requireAuth, (ctx) => maintenance.put(ctx));
  app.post("/api/ledger/recalculate", requireAuth, (ctx) => ledger.startRecalculate(ctx));
  app.get("/api/ledger/recalculate/:jobId", requireAuth, (ctx) => ledger.recalculateStatus(ctx));
  app.get("/api/pricing", requireAuth, (ctx) => pricing.list(ctx));
  app.put("/api/pricing/default", requireAuth, (ctx) => pricing.setDefault(ctx));
  app.put("/api/pricing/locations/:id", requireAuth, (ctx) => pricing.updateLocation(ctx));
  app.get("/api/pricing/history", requireAuth, (ctx) => pricing.history(ctx));
  app.get("/api/settings", requireAuth, (ctx) => settingsRoutes.get(ctx));
  app.put("/api/settings", requireAuth, (ctx) => settingsRoutes.put(ctx));
  app.get("/api/channels", requireAuth, (ctx) => push.listChannels(ctx));
  app.put("/api/channels/feishu", requireAuth, (ctx) => push.updateFeishu(ctx));
  app.post("/api/channels/feishu/test", requireAuth, (ctx) => push.testFeishu(ctx));
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

// 数据源解析顺序：env DB_URL（compose/裸机显式配置，process env 优先）→ 向导保存的
// connect 数据源（state.datasource，密码 AES-GCM 加密落库）→ 本机开发回落地址。
// 此前 DB_URL 留空直接回落作者本机桥接死地址，向导存好的凭据无人消费 —— 容器用户按
// README「DB_URL 留空交给向导」操作会四级校验全绿但永远无数据。
function resolveDbUrl(state) {
  if (process.env.DB_URL) return process.env.DB_URL;
  try {
    const ds = state?.datasource;
    if (ds?.mode === "connect" && ds.configured && ds.host && ds.user && ds.passwordEnc) {
      const dsn = `postgres://${encodeURIComponent(ds.user)}:${encodeURIComponent(decryptSecret(ds.passwordEnc))}@${ds.host}:${ds.port || 5432}/${ds.database || "teslamate"}`;
      log(`datasource: using saved setup config (${ds.user}@${ds.host}:${ds.port || 5432}/${ds.database || "teslamate"})`);
      return dsn;
    }
  } catch (error) {
    log("datasource: saved config unreadable, falling back:", error.message);
  }
  return "postgres://teslamate@127.0.0.1:15432/teslamate";
}

async function main() {
  const startedAt = Date.now();
  loadSecretKey();
  const state = loadState();
  // §7.1 事件日志落 SQLite（进程重启可回看）；getStore 顺带完成 JSON→SQLite 一次性迁移。
  const eventLog = createEventLog({ store: getStore() });
  // AHATESLA_DEMO=1：不连 TeslaMate 库，全部查询由确定性种子数据应答（m4d 演示模式）
  const db = isDemo() ? createDemoDb() : createDb(resolveDbUrl(state));
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
  const store = getStore();

  // GA-39（§7.4 崩溃自愈）：monitor 状态 kv 持久化（防抖 2s + 周期兜底）
  const monitor = new TripMonitor({
    state: (() => {
      try {
        const raw = store.kvGet("monitor_state_v1");
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    })(),
    onEvent: (event) => {
      eventLog.log("push.event", { type: event.type, eventKey: event.eventKey });
      dispatch(event).catch((error) => eventLog.log("push.error", { message: error.message }));
    }
  });
  const monitorPersistence = createMonitorPersistence({ monitor, store, eventLog });

  // ---- 渠道 + AI 润色（m4c-c3）+ 报告调度器（GA-11）+ 推送管线 ----------------
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
  const { dispatch, carsListCached, replayPending } = createPushDispatch({ db, state, notifier, eventLog, monitor });

  const reportBuildDeps = () => ({
    db, state,
    computeTripViews,
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

  // M2 修复：崩溃/重启时未完成投递的 pending 事件补发（dedupe 保证同 key 不重推）
  {
    const { total, replayed } = replayPending();
    if (total) {
      log(`monitor pending events: ${total} loaded, ${replayed} replayed`);
      monitorPersistence.persist();
    }
  }

  // ---- HTTP：路由一次注册 + MQTT 懒视图（替代「连上后清表重注册」hack） ------
  // system 路由只在请求时读 mqtt.isConfigured()/isConnected() —— 桥接建立后
  // 视图自动反映，无需重注册路由表。
  const mqttRef = { bridge: null };
  const mqttView = {
    isConfigured: () => Boolean(mqttRef.bridge),
    isConnected: () => mqttRef.bridge?.isConnected?.() ?? false
  };
  const app = buildApp({ db, state, eventLog, mqtt: mqttView, startedAt, notifier, reportScheduler, buildDeps: reportBuildDeps, ai });

  const staticHandler = createStaticHandler(join(__dirname, "..", "..", "web", "dist"));
  // 默认只绑 127.0.0.1（裸机/systemd 部署不再意外监听全部网卡走明文 HTTP）；
  // Docker/compose 需要容器内 0.0.0.0 —— 两份 compose 已显式设置 HOST=0.0.0.0。
  const HOST = process.env.HOST || "127.0.0.1";
  const server = app.listen(PORT, HOST, () => {
    log(`AhaTesla server listening on ${HOST}:${PORT} (data: ${dataDir()})`);
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

  // ---- 巡检与告警（P2/v2.5/v2.6）-------------------------------------------
  // 数据断联/恢复(边沿各一次,共用 outage 矩阵行) + 三巡检(各自 kv 节流)
  const outageWatcher = createOutageWatcher({
    thresholdMs: 10 * 60_000,
    onOutage: (ms) => dispatch({ type: "outage", outageMs: ms }).catch(() => {}),
    onRecovered: (ms) => dispatch({ type: "outage_recovered", outageMs: ms }).catch(() => {})
  });
  const patrols = createPatrols({ db, state, store, dispatch, carsListCached });

  const loop = startTripMonitorLoop({
    monitor,
    db,
    // 探活结果喂给健康状态机（GA-32 失联横幅数据源）；失败由 loop 内部 logger 兜底
    onPollResult: (ok) => {
      outageWatcher.observe(recordProbe(ok));
      patrols.runAll();
    },
    logger: (message) => eventLog.log("monitor.error", { message })
  });
  // GA-39：周期 + 事件驱动节流持久化 monitor 状态（水线游标/sent_keys/pending_events）
  const origPoke = loop.poke.bind(loop);
  loop.poke = () => Promise.resolve(origPoke()).finally(() => monitorPersistence.persist());
  const persistTimer = setInterval(() => monitorPersistence.persist(), 30_000);
  persistTimer.unref?.();

  // loop 先建，MQTT 充电边沿才能 poke 即时轮询（§7.1 增强路径）
  const mqttBridge = await startMqtt({ monitor, eventLog, loop });
  mqttRef.bridge = mqttBridge;
  if (mqttBridge) {
    log(`mqtt enabled (optional enhancement): ${redactUrl(MQTT_URL)}`);
  } else if (MQTT_URL) {
    log(`mqtt configured but unavailable — degraded to polling baseline: ${redactUrl(MQTT_URL)}`);
  } else {
    log("mqtt not configured — polling baseline only (§7.1)");
  }

  const shutdown = async () => {
    loop.stop();
    reportScheduler?.stop?.();
    clearInterval(persistTimer);
    monitorPersistence.dispose();
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
