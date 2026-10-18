// api.test.mjs — 各 API 路由（注入 fake db）、认证中间件、错误格式。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createFakeDb } from "../src/core/db.mjs";
import { createApp, fetchApp, HttpError } from "../src/api/http-kit.mjs";
import { createJwtMiddleware } from "../src/api/jwt.mjs";
import { hashPassword, signJwt } from "../src/api/auth.mjs";
import { createAuthRoutes } from "../src/api/auth-routes.mjs";
import { createTripsRoutes } from "../src/api/trips-routes.mjs";
import { createChargingRoutes } from "../src/api/charging-routes.mjs";
import { createPricingRoutes } from "../src/api/pricing-routes.mjs";
import { createChannelRoutes } from "../src/api/channel-routes.mjs";
import { createDashboardRoutes, createSystemRoutes } from "../src/api/dashboard-routes.mjs";
import { createFeishuChannel } from "../src/core/feishu.mjs";
import { createEventLog } from "../src/core/events.mjs";

const SECRET = randomBytes(32);
const PASSWORD_HASH = await hashPassword("password-123");

function baseState(overrides = {}) {
  return {
    username: "admin",
    passwordHash: PASSWORD_HASH,
    pricing: { defaultRateCnyPerKwh: 1.0, history: [] },
    pushRules: {
      tripEnd: true, chargingStart: true, chargingDone: true,
      weeklyReport: true, weeklyReportDay: 1, monthlyReport: true
    },
    feishu: { enabled: false, appId: "", appSecretEnc: null, lastEventAt: null },
    ...overrides
  };
}

function buildTestApp({ db, state = baseState(), mqtt = { isConfigured: () => true, isConnected: () => true } } = {}) {
  const eventLog = createEventLog();
  const requireAuth = createJwtMiddleware({ getSecret: () => SECRET });
  const saved = [];
  const saveStateFn = (s) => saved.push(structuredClone(s));
  const feishu = createFeishuChannel(state, { fetchImpl: async () => { throw new Error("no network in tests"); } });
  const auth = createAuthRoutes({ state, getSecret: () => SECRET, eventLog, saveStateFn });
  const trips = createTripsRoutes({ db, state });
  const charging = createChargingRoutes({ db, state });
  const pricing = createPricingRoutes({ db, state, setDefaultRateFn: (s, rate, src) => {
    s.pricing.defaultRateCnyPerKwh = rate;
    s.pricing.history.push({ changedAt: new Date().toISOString(), from: 1.0, to: rate, source: src });
    saveStateFn(s);
  } });
  const channels = createChannelRoutes({ state, feishu, eventLog, saveStateFn });
  const dashboard = createDashboardRoutes({ db, state });
  const system = createSystemRoutes({ db, mqtt, eventLog, startedAt: () => Date.now() - 5000 });
  const app = createApp();
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
  return { app, state, saved, eventLog };
}

function tokenFor(username = "admin") {
  return signJwt({ sub: username }, SECRET);
}

// ---- 认证 ------------------------------------------------------------

test("登录成功返回 token + httpOnly cookie", async () => {
  const { app } = buildTestApp({ db: createFakeDb() });
  const res = await fetchApp(app, "POST", "/api/auth/login", { body: { username: "admin", password: "password-123" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.username, "admin");
  assert.ok(res.json.token);
  const cookie = res.setCookie.find((c) => c.startsWith("ahatesla_token="));
  assert.ok(cookie);
  assert.match(cookie, /HttpOnly/);
});

test("错误密码 → 401 {error:{code,message}}", async () => {
  const { app } = buildTestApp({ db: createFakeDb() });
  const res = await fetchApp(app, "POST", "/api/auth/login", { body: { username: "admin", password: "nope" } });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, "invalid_credentials");
  assert.ok(res.json.error.message);
});

test("缺字段 → 400", async () => {
  const { app } = buildTestApp({ db: createFakeDb() });
  const res = await fetchApp(app, "POST", "/api/auth/login", { body: { username: "admin" } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, "bad_request");
});

test("未认证访问受保护端点 → 401", async () => {
  const { app } = buildTestApp({ db: createFakeDb() });
  for (const path of ["/api/dashboard", "/api/trips", "/api/charging", "/api/pricing", "/api/system/status"]) {
    const res = await fetchApp(app, "GET", path);
    assert.equal(res.status, 401, path);
    assert.equal(res.json.error.code, "unauthorized");
  }
});

test("cookie 认证 /api/auth/me；伪造 token 401", async () => {
  const { app } = buildTestApp({ db: createFakeDb() });
  const ok = await fetchApp(app, "GET", "/api/auth/me", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.username, "admin");
  assert.equal(ok.json.initialized, true);
  const bad = await fetchApp(app, "GET", "/api/auth/me", { cookie: `ahatesla_token=forged.token.sig` });
  assert.equal(bad.status, 401);
});

test("Bearer 认证也可用", async () => {
  const { app } = buildTestApp({ db: createFakeDb() });
  const res = await fetchApp(app, "GET", "/api/auth/me", { headers: { authorization: `Bearer ${tokenFor()}` } });
  assert.equal(res.status, 200);
});

test("logout 清 cookie", async () => {
  const { app } = buildTestApp({ db: createFakeDb() });
  const res = await fetchApp(app, "POST", "/api/auth/logout");
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  const cookie = res.setCookie.find((c) => c.startsWith("ahatesla_token=;"));
  assert.ok(cookie);
});

test("change-password：旧密码校验、新密码强度、状态落盘", async () => {
  const { app, saved } = buildTestApp({ db: createFakeDb() });
  const cookie = `ahatesla_token=${tokenFor()}`;
  const wrong = await fetchApp(app, "POST", "/api/auth/change-password", { cookie, body: { oldPassword: "bad", newPassword: "new-password-9" } });
  assert.equal(wrong.status, 401);
  const weak = await fetchApp(app, "POST", "/api/auth/change-password", { cookie, body: { oldPassword: "password-123", newPassword: "short" } });
  assert.equal(weak.status, 400);
  assert.equal(weak.json.error.code, "weak_password");
  const ok = await fetchApp(app, "POST", "/api/auth/change-password", { cookie, body: { oldPassword: "password-123", newPassword: "new-password-9" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(saved.length, 1);
  assert.notEqual(saved[0].passwordHash, PASSWORD_HASH);
});

// ---- trips ------------------------------------------------------------

function tripsFakeDb() {
  return createFakeDb((sql, params) => {
    if (/FROM drives/.test(sql) && /LIMIT \$2 OFFSET \$3/.test(sql) && /position_count/.test(sql)) {
      return [{
        id: 3241, car_id: 1,
        start_at: "2026-10-13 02:11:40", end_at: "2026-10-13 02:58:09",
        distance_km: 21.5, duration_min: 47,
        start_address_id: 1, end_address_id: 2,
        efficiency: 150, ideal_used_km: 20, rated_used_km: 22
      }];
    }
    if (/WHERE d\.id = \$1/.test(sql)) {
      if (Number(params[0]) !== 3241) return [];
      return [{
        id: 3241, car_id: 1,
        start_at: "2026-10-13 02:11:40", end_at: "2026-10-13 02:58:09",
        distance_km: 21.5, duration_min: 47,
        start_address_id: 1, end_address_id: 2,
        efficiency: 150, ideal_used_km: 20, rated_used_km: 22
      }];
    }
    if (/count\(\*\)::int AS total/.test(sql) && /FROM drives/.test(sql)) return [{ total: 3023 }];
    if (/FROM addresses/.test(sql)) {
      return [
        { id: 1, display_name: "家里", name: "家里", road: null, city: null, neighbourhood: null },
        { id: 2, display_name: "公司", name: "公司", road: null, city: null, neighbourhood: null }
      ];
    }
    if (/FROM charging_processes/.test(sql) && /geofence_name/.test(sql)) {
      return [{
        id: 490, end_date: "2026-10-12 20:00", charge_energy_added: 25.3, cost: 38.0,
        geofence_name: "CND", geofence_cost_per_unit: 1.8, address_name: null
      }];
    }
    if (/FROM positions/.test(sql)) {
      return [
        { date: "2026-10-13 02:11:40", lat: 24.48, lng: 118.09, odometer: 30000 },
        { date: "2026-10-13 02:58:09", lat: 24.51, lng: 118.12, odometer: 30021 }
      ];
    }
    return [];
  });
}

test("GET /api/trips 返回分页 + Trip 字段 + 成本分摊", async () => {
  const { app } = buildTestApp({ db: tripsFakeDb() });
  const res = await fetchApp(app, "GET", "/api/trips?limit=10&offset=0", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 3023);
  const trip = res.json.items[0];
  assert.equal(trip.id, 3241);
  assert.equal(trip.startAddress, "家里");
  assert.equal(trip.endAddress, "公司");
  assert.equal(trip.routeKey, "家里 → 公司");
  assert.equal(trip.distanceKm, 21.5);
  assert.equal(trip.durationMin, 47);
  assert.equal(trip.energyKWh, 3); // 20km × 150Wh/km
  // batch: 25.3kWh @38/25.3 → cost = 3 × (38/25.3)
  const expected = Number((3 * (38.0 / 25.3)).toFixed(2));
  assert.equal(trip.costCny, expected);
  assert.equal(trip.kwhPer100km, Number((3 / 21.5 * 100).toFixed(2)));
  assert.equal(trip.startAt, "2026-10-13T02:11:40.000Z"); // naive UTC → ISO
});

test("GET /api/trips/:id 返回路线点集", async () => {
  const { app } = buildTestApp({ db: tripsFakeDb() });
  const res = await fetchApp(app, "GET", "/api/trips/3241", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.route.length, 2);
  assert.equal(res.json.route[0].lat, 24.48);
  assert.equal(res.json.id, 3241);
  const missing = await fetchApp(app, "GET", "/api/trips/999", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "not_found");
});

test("trips 非法 from 参数 → 400", async () => {
  const { app } = buildTestApp({ db: tripsFakeDb() });
  const res = await fetchApp(app, "GET", "/api/trips?from=not-a-date", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 400);
});

// ---- charging -----------------------------------------------------------

function chargingFakeDb() {
  return createFakeDb((sql) => {
    if (/power_max_kw/.test(sql)) {
      return [
        {
          id: 490, start_at: "2026-10-12 19:00", end_at: "2026-10-12 20:00",
          charge_energy_added: 25.3, cost: 38.0, duration_min: 60,
          start_battery_level: 20, end_battery_level: 80,
          geofence_name: "CND", geofence_cost_per_unit: 1.8,
          address_name: null, power_max_kw: 90
        },
        {
          id: 489, start_at: "2026-10-10 19:00", end_at: "2026-10-10 20:00",
          charge_energy_added: 10, cost: null, duration_min: 60,
          start_battery_level: 30, end_battery_level: 50,
          geofence_name: null, geofence_cost_per_unit: null,
          address_name: "某处充电站", power_max_kw: 40
        }
      ];
    }
    if (/count\(\*\)::int AS total FROM charging_processes/.test(sql)) return [{ total: 490 }];
    if (/FROM charging_processes/.test(sql) && /geofence_name/.test(sql)) {
      return [
        { id: 490, end_date: "2026-10-12 20:00", charge_energy_added: 25.3, cost: 38.0, geofence_name: "CND", geofence_cost_per_unit: 1.8, address_name: null },
        { id: 489, end_date: "2026-10-10 20:00", charge_energy_added: 10, cost: null, geofence_name: null, geofence_cost_per_unit: null, address_name: "某处充电站" }
      ];
    }
    return [];
  });
}

test("GET /api/charging：cost 直接用 / 无 cost 回落默认价", async () => {
  const { app } = buildTestApp({ db: chargingFakeDb() });
  const res = await fetchApp(app, "GET", "/api/charging?limit=2", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 490);
  const [first, second] = res.json.items;
  assert.equal(first.id, 490);
  assert.equal(first.costCny, 38.0);
  assert.equal(first.locationName, "CND");
  assert.equal(first.powerMaxKw, 90);
  assert.equal(second.id, 489);
  assert.equal(second.costCny, 10.0); // default 1.0 × 10
  assert.equal(second.locationName, "某处充电站");
});

test("GET /api/charging/stats 聚合按地点", async () => {
  const { app } = buildTestApp({ db: chargingFakeDb() });
  const res = await fetchApp(app, "GET", "/api/charging/stats?period=month", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.sessionCount, 2);
  assert.equal(res.json.totalKWh, 35.3);
  assert.equal(res.json.totalCostCny, 48.0);
  assert.equal(res.json.byLocation.length, 2);
  const cnd = res.json.byLocation.find((l) => l.name === "CND");
  assert.equal(cnd.count, 1);
  assert.equal(cnd.cost, 38.0);
});

// ---- pricing ------------------------------------------------------------

test("GET /api/pricing 镜像 geofences + 默认价", async () => {
  const db = createFakeDb((sql) => {
    if (/FROM geofences/.test(sql)) {
      return [
        { id: 1, name: "HOME", price_per_unit: null, session_fee: null, billing_type: "per_kwh" },
        { id: 2, name: "CND", price_per_unit: 1.8, session_fee: null, billing_type: "per_kwh" }
      ];
    }
    return [];
  });
  const { app } = buildTestApp({ db });
  const res = await fetchApp(app, "GET", "/api/pricing", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.defaultRateCnyPerKwh, 1.0);
  assert.equal(res.json.locations.length, 2);
  assert.equal(res.json.locations[1].pricePerUnit, 1.8);
});

test("PUT /api/pricing/default 校验 + 历史", async () => {
  const { app } = buildTestApp({ db: createFakeDb() });
  const cookie = `ahatesla_token=${tokenFor()}`;
  const bad = await fetchApp(app, "PUT", "/api/pricing/default", { cookie, body: { rate: 99 } });
  assert.equal(bad.status, 400);
  const ok = await fetchApp(app, "PUT", "/api/pricing/default", { cookie, body: { rate: 1.3 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.defaultRateCnyPerKwh, 1.3);
  const history = await fetchApp(app, "GET", "/api/pricing/history", { cookie });
  assert.equal(history.status, 200);
  assert.equal(Array.isArray(history.json), true);
  assert.equal(history.json[0].to, 1.3);
  assert.equal(history.json[0].source, "api");
});

// ---- channels / push-rules ----------------------------------------------

test("GET /api/channels：未配置飞书 → enabled=false 优雅降级", async () => {
  const { app } = buildTestApp({ db: createFakeDb() });
  const res = await fetchApp(app, "GET", "/api/channels", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.feishu.enabled, false);
  assert.equal(res.json.feishu.connected, false);
  assert.equal(res.json.web.enabled, true);
});

test("PUT /api/channels/feishu 校验", async () => {
  const { app } = buildTestApp({ db: createFakeDb() });
  const cookie = `ahatesla_token=${tokenFor()}`;
  const bad = await fetchApp(app, "PUT", "/api/channels/feishu", { cookie, body: { enabled: "yes" } });
  assert.equal(bad.status, 400);
  const ok = await fetchApp(app, "PUT", "/api/channels/feishu", { cookie, body: { enabled: true, appId: "cli_test", appSecret: "s3cret" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
});

test("POST /api/channels/feishu/test 未启用 → 400", async () => {
  const { app } = buildTestApp({ db: createFakeDb() });
  const res = await fetchApp(app, "POST", "/api/channels/feishu/test", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, "channel_disabled");
});

test("push-rules GET/PUT 校验", async () => {
  const { app } = buildTestApp({ db: createFakeDb() });
  const cookie = `ahatesla_token=${tokenFor()}`;
  const get = await fetchApp(app, "GET", "/api/push-rules", { cookie });
  assert.equal(get.json.tripEnd, true);
  const bad = await fetchApp(app, "PUT", "/api/push-rules", { cookie, body: { weeklyReportDay: 9 } });
  assert.equal(bad.status, 400);
  const bad2 = await fetchApp(app, "PUT", "/api/push-rules", { cookie, body: { tripEnd: "on" } });
  assert.equal(bad2.status, 400);
  const ok = await fetchApp(app, "PUT", "/api/push-rules", { cookie, body: { tripEnd: false, weeklyReportDay: 5 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.tripEnd, false);
  assert.equal(ok.json.weeklyReportDay, 5);
});

// ---- system ------------------------------------------------------------

test("GET /api/system/status 汇报 db/mqtt/uptime/version", async () => {
  const { app } = buildTestApp({ db: createFakeDb((sql) => {
    if (/drive_count/.test(sql)) return [{ drive_count: 3023, last_drive_at: "2026-10-13 02:58:09" }];
    return [];
  }) });
  const res = await fetchApp(app, "GET", "/api/system/status", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.teslamate.dbOk, true);
  // 已配置 MQTT（isConfigured=true）→ 返回 mqtt 块（AC-5.1）
  assert.deepEqual(res.json.teslamate.mqtt, { ok: true });
  assert.equal(res.json.teslamate.driveCount, 3023);
  assert.equal(res.json.teslamate.lastDriveAt, "2026-10-13T02:58:09.000Z");
  assert.equal(res.json.version, "0.1.0");
  assert.ok(res.json.uptime >= 0);
});

test("GET /api/system/status 未配置 MQTT 时不返回 mqtt 块（AC-5.1/§7.1 可选增强）", async () => {
  const { app } = buildTestApp({ db: createFakeDb((sql) => {
    if (/drive_count/.test(sql)) return [{ drive_count: 1, last_drive_at: null }];
    return [];
  }), mqtt: null });
  const res = await fetchApp(app, "GET", "/api/system/status", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal("mqtt" in res.json.teslamate, false);
  assert.equal("mqttOk" in res.json.teslamate, false);
});

test("GET /api/system/status MQTT 已配置但断开时返回 mqtt.ok=false", async () => {
  const { app } = buildTestApp({ db: createFakeDb(), mqtt: { isConfigured: () => true, isConnected: () => false } });
  const res = await fetchApp(app, "GET", "/api/system/status", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.teslamate.mqtt, { ok: false });
});

test("db 故障时 status 仍 200 且 dbOk=false", async () => {
  const db = createFakeDb(() => { throw new Error("connection refused"); });
  db.ping = async () => { throw new Error("connection refused"); };
  const { app } = buildTestApp({ db });
  const res = await fetchApp(app, "GET", "/api/system/status", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.teslamate.dbOk, false);
});

test("GET /api/system/events 返回事件日志", async () => {
  const { app } = buildTestApp({ db: createFakeDb() });
  const cookie = `ahatesla_token=${tokenFor()}`;
  await fetchApp(app, "POST", "/api/auth/login", { body: { username: "admin", password: "password-123" } });
  const res = await fetchApp(app, "GET", "/api/system/events?limit=10", { cookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.items));
});

// ---- dashboard ------------------------------------------------------------

function dashboardFakeDb() {
  return createFakeDb((sql) => {
    if (/position_at/.test(sql)) {
      return [{ id: 1, name: "My Tesla", current_battery: 55, range_km: 220.5, odometer_km: 30021, position_at: "2026-10-13 03:00:00", last_drive_at: "2026-10-13 02:58:09" }];
    }
    if (/driving/.test(sql)) return [{ state: "asleep_or_parked" }];
    if (/drive_minutes/.test(sql)) return [{ distance_km: 800.2, drive_count: 40, drive_minutes: 1200 }];
    if (/AS distance_km/.test(sql) && /interval|drives d/.test(sql) && !/position_count/.test(sql)) return [{ distance_km: 300.5 }];
    if (/position_count/.test(sql)) {
      return [{
        id: 3241, car_id: 1, start_at: "2026-10-13 02:11:40", end_at: "2026-10-13 02:58:09",
        distance_km: 21.5, duration_min: 47, start_address_id: 1, end_address_id: 2,
        efficiency: 150, ideal_used_km: 20, rated_used_km: 22
      }];
    }
    if (/count\(\*\)::int AS total/.test(sql) && /FROM drives/.test(sql)) return [{ total: 1 }];
    if (/FROM addresses/.test(sql)) return [{ id: 1, display_name: "家里" }, { id: 2, display_name: "公司" }];
    if (/FROM charging_processes/.test(sql)) return [];
    return [];
  });
}

test("GET /api/dashboard 汇总", async () => {
  const { app } = buildTestApp({ db: dashboardFakeDb() });
  const res = await fetchApp(app, "GET", "/api/dashboard", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.car.name, "My Tesla");
  assert.equal(res.json.car.currentBattery, 55);
  assert.equal(res.json.car.state, "asleep_or_parked");
  assert.equal(res.json.monthStats.driveCount, 40);
  assert.equal(res.json.monthStats.driveHours, 20);
  assert.ok(res.json.fuelComparison.fuelCostCny > 0);
  assert.equal(res.json.recentTrips.length, 1);
});

// ---- 错误格式 / 通用 -------------------------------------------------------

test("未知路由 → 404 错误格式", async () => {
  const { app } = buildTestApp({ db: createFakeDb() });
  const res = await fetchApp(app, "GET", "/api/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(Object.keys(res.json.error), ["code", "message"]);
});

test("非法 JSON body → 400 invalid_json", async () => {
  const { app } = buildTestApp({ db: createFakeDb() });
  const { Readable } = await import("node:stream");
  const req = Readable.from(["{not json"]);
  Object.assign(req, { method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json" } });
  // reuse fetch path manually
  const res = await new Promise((resolve) => {
    const chunks = [];
    const fakeRes = {
      setHeader() {}, getHeader() { return undefined; },
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      write(c) { chunks.push(Buffer.from(c)); },
      end(c) { if (c) chunks.push(Buffer.from(c)); resolve({ status: this.status, json: JSON.parse(Buffer.concat(chunks).toString()) }); },
      writableEnded: false
    };
    app.handle(req, fakeRes);
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, "invalid_json");
});

test("路由抛内部错误 → 500 {error:{code:'internal'}}", async () => {
  const db = createFakeDb(() => { throw new Error("boom"); });
  const { app } = buildTestApp({ db });
  const res = await fetchApp(app, "GET", "/api/trips", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 500);
  assert.equal(res.json.error.code, "internal");
});
