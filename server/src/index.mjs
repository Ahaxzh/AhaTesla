// index.mjs — AhaTesla server entry point.
// API on :18500 (PORT env) + static hosting of ../../web/dist when present.
// Worker (trip monitor + MQTT signals + push dispatch) runs in this process.
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { loadSecretKey, dataDir } from "./core/secret-box.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { createDb } from "./core/db.mjs";
import { loadState, saveState, getStore } from "./core/state.mjs";
import { createEventLog } from "./core/events.mjs";
import { createFeishuChannel } from "./core/feishu.mjs";
import { TripMonitor, startTripMonitorLoop } from "./core/trip-monitor.mjs";
import { startMqttBridge } from "./core/mqtt-bridge.mjs";
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
import { createSetupRoutes } from "./api/setup-routes.mjs";

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

export function buildApp({ db, state, eventLog, mqtt, startedAt }) {
  const getSecret = () => loadSecretKey();
  const requireAuth = createJwtMiddleware({ getSecret });
  const feishu = createFeishuChannel(state, { logger: (msg) => eventLog.log("feishu.error", { message: msg }) });

  const auth = createAuthRoutes({ state, getSecret, eventLog });
  const setup = createSetupRoutes({ state, db, getSecret, saveStateFn: saveState, eventLog });
  const trips = createTripsRoutes({ db, state });
  const charging = createChargingRoutes({ db, state });
  const pricing = createPricingRoutes({ db, state, getStore });
  const ledger = createLedgerRoutes({ db, state, getStore });
  const channels = createChannelRoutes({ state, feishu, eventLog });
  const dashboard = createDashboardRoutes({ db, state });
  const system = createSystemRoutes({ db, mqtt, eventLog, startedAt });

  const app = createApp({ onError: (error) => eventLog.log("server.error", { message: error?.message }) });

  registerRoutes(app, { requireAuth, getSecret, state, db, eventLog, mqtt, startedAt, feishu });

  return { app, feishu };
}

// 路由注册统一入口：buildApp 与 main() 重建路由共用，避免两份清单漂移。
function registerRoutes(app, { requireAuth, getSecret, state, db, eventLog, mqtt, startedAt, feishu, setupDeps = null }) {
  const auth = createAuthRoutes({ state, getSecret, eventLog });
  const setup = setupDeps ?? createSetupRoutes({ state, db, getSecret, saveStateFn: saveState, eventLog });
  const trips = createTripsRoutes({ db, state });
  const charging = createChargingRoutes({ db, state });
  const pricing = createPricingRoutes({ db, state, getStore });
  const ledger = createLedgerRoutes({ db, state, getStore });
  const channels = createChannelRoutes({ state, feishu, eventLog });
  const dashboard = createDashboardRoutes({ db, state });
  const system = createSystemRoutes({ db, mqtt, eventLog, startedAt });

  // /api/setup/*（契约 §1）：status 匿名；admin 仅 uninitialized；其余需管理员登录。
  app.get("/api/setup/status", (ctx) => setup.status(ctx));
  app.post("/api/setup/admin", (ctx) => setup.registerAdmin(ctx));
  app.post("/api/setup/test-connection", requireAuth, (ctx) => setup.testConnection(ctx));
  app.post("/api/setup/datasource", requireAuth, (ctx) => setup.saveDatasource(ctx));
  app.get("/api/setup/car-discovery", requireAuth, (ctx) => setup.carDiscovery(ctx));
  app.post("/api/setup/select-car", requireAuth, (ctx) => setup.selectCar(ctx));

  app.post("/api/auth/login", (ctx) => auth.login(ctx));
  app.post("/api/auth/logout", (ctx) => auth.logout(ctx));
  app.post("/api/auth/change-password", requireAuth, (ctx) => auth.changePassword(ctx));
  app.get("/api/auth/me", requireAuth, (ctx) => auth.me(ctx));

  app.get("/api/dashboard", requireAuth, (ctx) => dashboard.dashboard(ctx));
  app.get("/api/trips", requireAuth, (ctx) => trips.list(ctx));
  app.get("/api/trips/:id", requireAuth, (ctx) => trips.detail(ctx));
  app.get("/api/charging", requireAuth, (ctx) => charging.list(ctx));
  app.get("/api/charging/stats", requireAuth, (ctx) => charging.stats(ctx));
  app.put("/api/charging/:id/cost", requireAuth, (ctx) => ledger.putChargeCost(ctx));
  app.post("/api/ledger/summary", requireAuth, (ctx) => ledger.summary(ctx));
  app.post("/api/ledger/recalculate", requireAuth, (ctx) => ledger.startRecalculate(ctx));
  app.get("/api/ledger/recalculate/:jobId", requireAuth, (ctx) => ledger.recalculateStatus(ctx));
  app.get("/api/pricing", requireAuth, (ctx) => pricing.list(ctx));
  app.put("/api/pricing/default", requireAuth, (ctx) => pricing.setDefault(ctx));
  app.put("/api/pricing/locations/:id", requireAuth, (ctx) => pricing.updateLocation(ctx));
  app.get("/api/pricing/history", requireAuth, (ctx) => pricing.history(ctx));
  app.get("/api/channels", requireAuth, (ctx) => channels.list(ctx));
  app.put("/api/channels/feishu", requireAuth, (ctx) => channels.updateFeishu(ctx));
  app.post("/api/channels/feishu/test", requireAuth, (ctx) => channels.testFeishu(ctx));
  app.get("/api/push-rules", requireAuth, (ctx) => channels.getPushRules(ctx));
  app.put("/api/push-rules", requireAuth, (ctx) => channels.putPushRules(ctx));
  app.get("/api/system/status", requireAuth, (ctx) => system.status(ctx));
  app.get("/api/system/events", requireAuth, (ctx) => system.events(ctx));
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
      res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
      res.end(content);
      return true;
    } catch {
      // SPA fallback
      try {
        const index = await readFile(join(rootDir, "index.html"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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
  const db = createDb(DB_URL);

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
      const rules = state.pushRules;
      // 推送矩阵：每类事件独立开关（AC-12.1）；未登记的 event.type 直接放行。
      const ruleKey = EVENT_PUSH_RULE[event.type];
      if (ruleKey && rules[ruleKey] === false) return;
      dispatchPush(event).catch((error) => eventLog.log("push.error", { message: error.message }));
    }
  });

  const { app, feishu } = buildApp({ db, state, eventLog, mqtt: null, startedAt });

  async function dispatchPush(event) {
    const result = await feishu.pushEvent(event);
    if (result.sent && event.eventKey) monitor.acknowledge(event.eventKey);
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

  const loop = startTripMonitorLoop({
    monitor,
    db,
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
    registerRoutes(app, { requireAuth: requireAuth2, getSecret: () => loadSecretKey(), state, db, eventLog, mqtt: mqttBridge, startedAt, feishu });
    log(`mqtt enabled (optional enhancement): ${MQTT_URL}`);
  } else if (MQTT_URL) {
    log(`mqtt configured but unavailable — degraded to polling baseline: ${MQTT_URL}`);
  } else {
    log("mqtt not configured — polling baseline only (§7.1)");
  }

  const shutdown = async () => {
    loop.stop();
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
