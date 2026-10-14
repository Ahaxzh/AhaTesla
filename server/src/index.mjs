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
import { loadState, saveState } from "./core/state.mjs";
import { createEventLog } from "./core/events.mjs";
import { createFeishuChannel } from "./core/feishu.mjs";
import { TripMonitor, startTripMonitorLoop } from "./core/trip-monitor.mjs";
import { hashPassword, generateInitialPassword, signJwt, verifyJwt, TOKEN_COOKIE } from "./api/auth.mjs";
import { createApp, parseCookies } from "./api/http-kit.mjs";
import { createJwtMiddleware } from "./api/jwt.mjs";
import { createAuthRoutes } from "./api/auth-routes.mjs";
import { createTripsRoutes } from "./api/trips-routes.mjs";
import { createChargingRoutes } from "./api/charging-routes.mjs";
import { createPricingRoutes } from "./api/pricing-routes.mjs";
import { createChannelRoutes } from "./api/channel-routes.mjs";
import { createDashboardRoutes, createSystemRoutes } from "./api/dashboard-routes.mjs";

const PORT = Number(process.env.PORT) || 18500;
const DB_URL = process.env.DB_URL || "postgres://teslamate@127.0.0.1:15432/teslamate";
const MQTT_URL = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";

function log(...args) {
  process.stdout.write(`[${new Date().toISOString()}] ${args.join(" ")}\n`);
}

// ---- bootstrap state ------------------------------------------------------

export async function bootstrap({ db, statePathEnv } = {}) {
  loadSecretKey();
  const state = loadState();
  if (!state.passwordHash) {
    const initial = generateInitialPassword();
    state.passwordHash = await hashPassword(initial);
    saveState(state);
    log(`初始密码已生成: ${initial} （登录后请立即修改，此提示不会再次显示）`);
  }
  return state;
}

export function buildApp({ db, state, eventLog, mqtt, startedAt }) {
  const getSecret = () => loadSecretKey();
  const requireAuth = createJwtMiddleware({ getSecret });
  const feishu = createFeishuChannel(state, { logger: (msg) => eventLog.log("feishu.error", { message: msg }) });

  const auth = createAuthRoutes({ state, getSecret, eventLog });
  const trips = createTripsRoutes({ db, state });
  const charging = createChargingRoutes({ db, state });
  const pricing = createPricingRoutes({ db, state });
  const channels = createChannelRoutes({ state, feishu, eventLog });
  const dashboard = createDashboardRoutes({ db, state });
  const system = createSystemRoutes({ db, mqtt, eventLog, startedAt });

  const app = createApp({ onError: (error) => eventLog.log("server.error", { message: error?.message }) });

  app.post("/api/auth/login", (ctx) => auth.login(ctx));
  app.post("/api/auth/logout", (ctx) => auth.logout(ctx));
  app.post("/api/auth/change-password", requireAuth, (ctx) => auth.changePassword(ctx));
  app.get("/api/auth/me", requireAuth, (ctx) => auth.me(ctx));

  app.get("/api/dashboard", requireAuth, (ctx) => dashboard.dashboard(ctx));
  app.get("/api/trips", requireAuth, (ctx) => trips.list(ctx));
  app.get("/api/trips/:id", requireAuth, (ctx) => trips.detail(ctx));
  app.get("/api/charging", requireAuth, (ctx) => charging.list(ctx));
  app.get("/api/charging/stats", requireAuth, (ctx) => charging.stats(ctx));
  app.get("/api/pricing", requireAuth, (ctx) => pricing.list(ctx));
  app.put("/api/pricing/default", requireAuth, (ctx) => pricing.setDefault(ctx));
  app.get("/api/pricing/history", requireAuth, (ctx) => pricing.history(ctx));
  app.get("/api/channels", requireAuth, (ctx) => channels.list(ctx));
  app.put("/api/channels/feishu", requireAuth, (ctx) => channels.updateFeishu(ctx));
  app.post("/api/channels/feishu/test", requireAuth, (ctx) => channels.testFeishu(ctx));
  app.get("/api/push-rules", requireAuth, (ctx) => channels.getPushRules(ctx));
  app.put("/api/push-rules", requireAuth, (ctx) => channels.putPushRules(ctx));
  app.get("/api/system/status", requireAuth, (ctx) => system.status(ctx));
  app.get("/api/system/events", requireAuth, (ctx) => system.events(ctx));

  return { app, feishu };
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

async function startMqtt({ state, monitor, eventLog }) {
  const topicHandlers = {
    "locked": (value) => monitor.observeVehicleSignal("locked", value),
    "driver_front_door_open": (value) => monitor.observeVehicleSignal("driver_front_door_open", value)
  };
  try {
    const mqtt = (await import("mqtt")).default;
    const client = mqtt.connect(MQTT_URL, { connectTimeout: 5_000, reconnectPeriod: 10_000 });
    client.on("error", (error) => eventLog.log("mqtt.error", { message: error.message }));
    client.on("connect", () => {
      log("mqtt connected", MQTT_URL);
      for (const topic of ["teslamate/cars/1/locked", "teslamate/cars/1/driver_front_door_open"]) {
        client.subscribe(topic);
      }
    });
    client.on("message", (topic, payload) => {
      const field = topic.split("/").pop();
      const handler = topicHandlers[field];
      if (!handler) return;
      const text = payload.toString().trim();
      const value = text === "true" || text === "1";
      const changed = monitor.observeVehicleSignal(field, value);
      if (changed) eventLog.log("mqtt.signal", { field, value });
    });
    return {
      isConnected: () => client.connected === true,
      close: () => client.endAsync?.() ?? client.end(true)
    };
  } catch (error) {
    log("mqtt unavailable:", error.message);
    return { isConnected: () => false, close: async () => {} };
  }
}

// ---- main --------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  const state = await bootstrap();
  const eventLog = createEventLog();
  const db = createDb(DB_URL);

  const monitor = new TripMonitor({
    state: {},
    onEvent: (event) => {
      eventLog.log("push.event", { type: event.type, eventKey: event.eventKey });
      const rules = state.pushRules;
      if (event.type === "trip_end" && !rules.tripEnd) return;
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

  const mqttBridge = await startMqtt({ state, monitor, eventLog });
  const requireAuth = createJwtMiddleware({ getSecret: () => loadSecretKey() });
  app.routes.length = 0; // rebuild route table with real mqtt status route
  {
    const auth = createAuthRoutes({ state, getSecret: () => loadSecretKey(), eventLog });
    const trips = createTripsRoutes({ db, state });
    const charging = createChargingRoutes({ db, state });
    const pricing = createPricingRoutes({ db, state });
    const channels = createChannelRoutes({ state, feishu, eventLog });
    const dashboard = createDashboardRoutes({ db, state });
    const system = createSystemRoutes({ db, mqtt: mqttBridge, eventLog, startedAt });
    app.post("/api/auth/login", (ctx) => auth.login(ctx));
    app.post("/api/auth/logout", (ctx) => auth.logout(ctx));
    app.post("/api/auth/change-password", requireAuth, (ctx) => auth.changePassword(ctx));
    app.get("/api/auth/me", requireAuth, (ctx) => auth.me(ctx));
    app.get("/api/dashboard", requireAuth, (ctx) => dashboard.dashboard(ctx));
    app.get("/api/trips", requireAuth, (ctx) => trips.list(ctx));
    app.get("/api/trips/:id", requireAuth, (ctx) => trips.detail(ctx));
    app.get("/api/charging", requireAuth, (ctx) => charging.list(ctx));
    app.get("/api/charging/stats", requireAuth, (ctx) => charging.stats(ctx));
    app.get("/api/pricing", requireAuth, (ctx) => pricing.list(ctx));
    app.put("/api/pricing/default", requireAuth, (ctx) => pricing.setDefault(ctx));
    app.get("/api/pricing/history", requireAuth, (ctx) => pricing.history(ctx));
    app.get("/api/channels", requireAuth, (ctx) => channels.list(ctx));
    app.put("/api/channels/feishu", requireAuth, (ctx) => channels.updateFeishu(ctx));
    app.post("/api/channels/feishu/test", requireAuth, (ctx) => channels.testFeishu(ctx));
    app.get("/api/push-rules", requireAuth, (ctx) => channels.getPushRules(ctx));
    app.put("/api/push-rules", requireAuth, (ctx) => channels.putPushRules(ctx));
    app.get("/api/system/status", requireAuth, (ctx) => system.status(ctx));
    app.get("/api/system/events", requireAuth, (ctx) => system.events(ctx));
  }

  const loop = startTripMonitorLoop({
    monitor,
    db,
    logger: (message) => eventLog.log("monitor.error", { message })
  });

  const shutdown = async () => {
    loop.stop();
    await mqttBridge.close();
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
