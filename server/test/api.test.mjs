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
import { createExportRoutes } from "../src/api/export-routes.mjs";
import { createMaintenanceRoutes } from "../src/api/maintenance-routes.mjs";
import { createPricingRoutes } from "../src/api/pricing-routes.mjs";
import { createChannelRoutes } from "../src/api/channel-routes.mjs";
import { createPushRoutes } from "../src/api/push-routes.mjs";
import { matrixFromRules } from "../src/core/push-channels.mjs";
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
  app.get("/api/trips/overview", requireAuth, (ctx) => trips.overview(ctx));
  app.get("/api/trips/route-summary", requireAuth, (ctx) => trips.routeSummary(ctx));
  app.get("/api/trips/display-accuracy", requireAuth, (ctx) => trips.displayAccuracy(ctx));
  app.get("/api/trips/efficiency-profile", requireAuth, (ctx) => trips.efficiencyProfile(ctx));
  app.get("/api/trips/:id", requireAuth, (ctx) => trips.detail(ctx));
  app.get("/api/charging", requireAuth, (ctx) => charging.list(ctx));
  app.get("/api/charging/stats", requireAuth, (ctx) => charging.stats(ctx));
  app.get("/api/charging/habits", requireAuth, (ctx) => charging.habits(ctx));
  const exportRoutes = createExportRoutes({ db, state });
  app.get("/api/export/trips", requireAuth, (ctx) => exportRoutes.trips(ctx));
  app.get("/api/export/charging", requireAuth, (ctx) => exportRoutes.charging(ctx));
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
        efficiency: 150, ideal_used_km: 20, rated_used_km: 22,
        tp_fl: 3.1, tp_fr: 3.0, tp_rl: 2.9, tp_rr: 3.0
      }];
    }
    if (/FROM positions p/.test(sql) && /battery_level/.test(sql)) {
      // SoC 起止：首读 78% → 末读 31%
      return [{ v: /ORDER BY p\.date ASC/.test(sql) ? 78 : 31 }];
    }
    if (/GREATEST\(d\.start_rated_range_km/.test(sql) && !/outside_temp_avg/.test(sql)) {
      // 表显偏差：9 月 100/105、10 月 90/100、11 月微样本(rated 9 <50 剔除)
      return [
        { end_at: "2026-09-05T02:00:00Z", distance_km: 100, rated_used_km: 105 },
        { end_at: "2026-10-05T02:00:00Z", distance_km: 90, rated_used_km: 100 },
        { end_at: "2026-11-05T02:00:00Z", distance_km: 8, rated_used_km: 9 },
      ];
    }
    if (/outside_temp_avg/.test(sql) && /JOIN cars c ON c\.id = d\.car_id/.test(sql)) {
      // 能效画像：r2 是最佳(139)；r1/r2 均 60km/h；eff 0.152 kWh/km
      return [
        { end_at: "2026-05-01T02:00:00Z", distance_km: 100, duration_min: 100, temp_c: 15, rated_used_km: 105, efficiency: 0.152 },
        { end_at: "2026-06-01T02:00:00Z", distance_km: 60, duration_min: 60, temp_c: 19, rated_used_km: 55, efficiency: 0.152 },
        { end_at: "2026-07-01T02:00:00Z", distance_km: 50, duration_min: 30, temp_c: 25, rated_used_km: 55, efficiency: 0.152 },
        { end_at: "2026-08-01T02:00:00Z", distance_km: 40, duration_min: 80, temp_c: 5, rated_used_km: 60, efficiency: 0.152 },
      ];
    }
    if (/ideal_used_km/.test(sql) && /FROM drives/.test(sql)) {
      // FIFO 回放轻量分页（无坐标 LATERAL）
      return [{
        id: 3241, car_id: 1,
        start_at: "2026-10-13 02:11:40", end_at: "2026-10-13 02:58:09",
        distance_km: 21.5, duration_min: 47,
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
        id: 490, car_id: 1, start_date: "2026-10-12 19:00", end_date: "2026-10-12 20:00",
        charge_energy_added: 25.3, cost: 38.0,
        geofence_name: "CND", geofence_cost_per_unit: 1.8, address_name: null,
        start_ideal_range_km: null, end_ideal_range_km: null,
        start_rated_range_km: null, end_rated_range_km: null,
        start_battery_level: 20, end_battery_level: 80
      }];
    }
    if (/FROM positions/.test(sql)) {
      // 轨迹点（v2.6.1 起兼供急刹/胎压变化计算）：2s 内 50→20 = 15 km/h/s ≥12 → 1 次急刹；
      // tpms 2.8→3.0（行驶升温）
      return [
        { date: "2026-10-13 02:11:40", lat: 24.48, lng: 118.09, odometer: 30000, speed: 50, tp_fl: 2.8, tp_fr: 2.8, tp_rl: 2.9, tp_rr: 2.9 },
        { date: "2026-10-13 02:11:42", lat: 24.51, lng: 118.12, odometer: 30021, speed: 20, tp_fl: 3.0, tp_fr: 3.0, tp_rl: 3.1, tp_rr: 3.1 }
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
  // 胎压（行程内最后有效读数，与推送同口径）：四轮 + 最低值着色由前端处理
  assert.deepEqual(res.json.tirePressure, { fl: 3.1, fr: 3.0, rl: 2.9, rr: 3.0 });
  // SoC 起止（v2.5）：行程首/末有效电量读数
  assert.deepEqual(res.json.soc, { start: 78, end: 31 });
  // 急刹次数（v2.6.1 阈值 12 + 初速≥30）：50→20（2s，15 km/h/s）恰 1 次
  assert.equal(res.json.hardBraking, 1);
  // 行程内胎压变化（v2.6）：首 2.85 → 末 3.05（行驶升温升压）
  assert.equal(res.json.tirePressureChange.deltaBar, 0.2);
  assert.equal(res.json.tirePressureChange.start.fl, 2.8);
  assert.equal(res.json.tirePressureChange.end.fl, 3.0);
  const missing = await fetchApp(app, "GET", "/api/trips/999", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "not_found");
});

test("trips 非法 from 参数 → 400", async () => {
  const { app } = buildTestApp({ db: tripsFakeDb() });
  const res = await fetchApp(app, "GET", "/api/trips?from=not-a-date", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 400);
});

// ---- trips overview / route-summary（v0.3 行程页汇总） --------------------

function overviewFakeDb() {
  return createFakeDb((sql) => {
    if (/count\(\*\)::int AS n/.test(sql)) return [{ n: 45, distance_km: 1240.5, duration_min: 1710 }];
    if (/SELECT cp\.end_date AS end_at/.test(sql)) {
      return [{ end_at: "2026-09-01T12:00:00.000Z", duration_min: 1500 }, { end_at: "2026-09-03T12:00:00.000Z", duration_min: 900 }];
    }
    if (/SELECT d\.id, d\.end_date AS end_at/.test(sql)) {
      return [
        { id: 3241, end_at: "2026-09-01T02:00:00.000Z", duration_min: 950 },
        { id: 3242, end_at: "2026-09-02T02:00:00.000Z", duration_min: 760 },
      ];
    }
    if (/max\(p\.speed\)/.test(sql)) return [{ max_speed: 128 }];
    return [];
  });
}

test("overview/route-summary SQL 卫哨：不允许出现 AND AND（v0.3 线上翻车回归）", async () => {
  const db = overviewFakeDb();
  const { app } = buildTestApp({ db });
  await fetchApp(app, "GET", "/api/trips/overview", { cookie: `ahatesla_token=${tokenFor()}` });
  await fetchApp(app, "GET", "/api/trips/route-summary", { cookie: `ahatesla_token=${tokenFor()}` });
  for (const c of db.calls) {
    assert.doesNotMatch(c.sql, /AND\s+AND/i, `double AND in: ${c.sql.slice(0, 120)}`);
  }
});

test("GET /api/trips/overview：KPI + 状态占比 + daily 按日桶（≤150 天零填充）", async () => {
  const { app } = buildTestApp({ db: overviewFakeDb() });
  const from = "2026-08-15T00:00:00.000Z";
  const to = "2026-11-13T00:00:00.000Z";
  const res = await fetchApp(app, "GET", `/api/trips/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.tripCount, 45);
  assert.equal(res.json.distanceKm, 1240.5);
  assert.equal(res.json.durationMin, 1710);
  assert.equal(res.json.maxSpeedKmh, 128);
  // 区间 90 天 = 129600 分 − 行驶 1710 − 充电 2400 → 驻车 125490
  assert.equal(res.json.stateShare.driveMin, 1710);
  assert.equal(res.json.stateShare.chargeMin, 2400);
  assert.equal(res.json.stateShare.parkedMin, 125490);
  // daily：2026-08-15→11-13 = 91 天按日桶；结束时刻归日（默认 Asia/Shanghai）
  assert.equal(res.json.daily.bucket, "day");
  assert.equal(res.json.daily.points.length, 91);
  assert.deepEqual(res.json.daily.points[0], { date: "2026-08-15", driveMin: 0, chargeMin: 0, trips: 0 });
  const sep1 = res.json.daily.points.find((p) => p.date === "2026-09-01");
  assert.deepEqual(sep1, { date: "2026-09-01", driveMin: 950, chargeMin: 1500, trips: 1 });
  assert.deepEqual(res.json.daily.points.find((p) => p.date === "2026-09-02"), { date: "2026-09-02", driveMin: 760, chargeMin: 0, trips: 1 });
  assert.deepEqual(res.json.daily.points.find((p) => p.date === "2026-09-03"), { date: "2026-09-03", driveMin: 0, chargeMin: 900, trips: 0 });
});

test("GET /api/trips/overview：区间 >150 天 → daily 自动切周桶（周一起）", async () => {
  const { app } = buildTestApp({ db: overviewFakeDb() });
  const from = "2026-05-01T00:00:00.000Z";
  const to = "2026-11-13T00:00:00.000Z";
  const res = await fetchApp(app, "GET", `/api/trips/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.daily.bucket, "week");
  const points = res.json.daily.points;
  // 首桶=区间首个周一 2026-04-27；9/1、9/2 同落周一起始的那一周，行程/充电并入同桶
  assert.equal(points[0].date, "2026-04-27");
  const sepWeek = points.find((p) => p.date === "2026-08-31");
  assert.deepEqual(sepWeek, { date: "2026-08-31", driveMin: 1710, chargeMin: 2400, trips: 2 });
});

test("GET /api/trips/overview 非法 from → 400", async () => {
  const { app } = buildTestApp({ db: overviewFakeDb() });
  const res = await fetchApp(app, "GET", "/api/trips/overview?from=zzz", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 400);
});

test("GET /api/trips/route-summary：按 drive 分组 segments（每段 ≤10 点含首尾）", async () => {
  const db = createFakeDb((sql) => {
    if (/ORDER BY d\.distance DESC NULLS LAST LIMIT 400/.test(sql)) return [{ id: 3241 }, { id: 3242 }];
    if (/row_number\(\) OVER \(PARTITION BY p\.drive_id/.test(sql)) {
      // 窗口抽样 SQL：过滤应含首尾 + 取模（卫哨已另测 AND AND）
      assert.match(sql, /rn = 1 OR rn = cnt OR/);
      return [
        { drive_id: 3241, lat: 31.22, lng: 121.4, speed: 32 },
        { drive_id: 3241, lat: 31.23, lng: 121.42, speed: 75 },
        { drive_id: 3241, lat: 31.24, lng: 121.44, speed: 90 },
        { drive_id: 3242, lat: 31.30, lng: 121.50, speed: 40 },
        { drive_id: 3242, lat: 31.31, lng: 121.52, speed: 55 },
      ];
    }
    return [];
  });
  const { app } = buildTestApp({ db });
  const res = await fetchApp(app, "GET", "/api/trips/route-summary", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.tripCount, 2);
  assert.equal(res.json.segments.length, 2);
  assert.equal(res.json.segments[0].driveId, 3241);
  assert.equal(res.json.segments[0].points.length, 3);
  assert.equal(res.json.segments[1].driveId, 3242);
});

test("GET /api/charging?from/to：日期区间透传 SQL（优先于 month）", async () => {
  const db = chargingFakeDb();
  const { app } = buildTestApp({ db });
  const from = "2026-10-01T00:00:00.000Z";
  const res = await fetchApp(app, "GET", `/api/charging?from=${encodeURIComponent(from)}`, { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.ok(db.calls.some((c) => /cp\.start_date >= /.test(c.sql) && c.sql.includes("2026-10-01")));
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
  // VERSION 来自 src/version.mjs（BASE + GIT_SHA 短 SHA；测试环境无 GIT_SHA → 纯基准版本）
  assert.ok(/^1\.2\.0(\+[0-9a-f]{7}|\+local)?$/.test(res.json.version), `version 格式：${res.json.version}`);
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
      return [{ id: 1, name: "My Tesla", current_battery: 55, range_km: 220.5, odometer_km: 30021, position_at: "2026-10-13 03:00:00", last_drive_at: "2026-10-13 02:58:09", lat: 24.4896, lng: 118.1046, tp_fl: 3.1, tp_fr: 3.0, tp_rl: 2.9, tp_rr: 3.0, tp_at: "2026-10-13 03:00:00" }];
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
    if (/FROM geofences/.test(sql)) return [{ id: 1, name: "家里", lat: 24.4895, lng: 118.1045, radius: 200 }];
    if (/FROM charging_processes/.test(sql)) return [];
    return [];
  });
}

test("GET /api/dashboard 汇总", async () => {
  const { app } = buildTestApp({ db: dashboardFakeDb() });
  const res = await fetchApp(app, "GET", "/api/dashboard", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.car.name, "My Tesla");
  // 车辆位置：经纬度 + ISO 时间 + 围栏解析的位置文字（顶部卡右下角）；缺坐标时为 null
  assert.equal(res.json.car.position.lat, 24.4896);
  assert.equal(res.json.car.position.lng, 118.1046);
  assert.equal(res.json.car.position.at, "2026-10-13T03:00:00.000Z");
  assert.equal(res.json.car.position.label, "家里"); // fixture 围栏半径 200m 覆盖定位点
  // 胎压（最后一次唤醒读数 + 时间；沉睡时为旧值，前端标「测量于」）
  assert.deepEqual(res.json.car.tirePressure, { fl: 3.1, fr: 3.0, rl: 2.9, rr: 3.0, at: "2026-10-13T03:00:00.000Z" });
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

// ---- 日报手动重发 + 推送矩阵变更审计（push-routes） --------------------------

test("POST /api/reports/generate daily：重发返回逐通道结果；昨日无数据 409 report_empty", async () => {
  const state = baseState();
  let emptyMode = false;
  const scheduler = {
    // 路由语义：daily 手动触发 = force 重发 + 不消费昨夜 backlog
    runKind: async (kind, opts = {}) => {
      if (kind !== "daily") return null;
      if (emptyMode || opts.force !== true || opts.manual !== true) return null;
      return {
        id: null, report: { periodLabel: "10/21 日报" }, deliveryMs: 3,
        results: { telegram: { sent: true }, feishu: { sent: false, reason: "auth_failed: ..." } }
      };
    }
  };
  const notifier = { channels: {}, matrix: () => ({ daily: {} }) };
  const push = createPushRoutes({ state, notifier, eventLog: createEventLog(), store: null, reportScheduler: scheduler, buildDeps: () => ({}) });
  const app = createApp();
  const requireAuth = createJwtMiddleware({ getSecret: () => SECRET });
  app.post("/api/reports/generate", requireAuth, (ctx) => push.generateReport(ctx));
  const cookie = `ahatesla_token=${tokenFor()}`;

  const res = await fetchApp(app, "POST", "/api/reports/generate", { cookie, body: { type: "daily" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.type, "daily");
  assert.equal(res.json.periodLabel, "10/21 日报");
  assert.equal(res.json.results.telegram.sent, true);
  assert.equal(res.json.results.feishu.sent, false);

  emptyMode = true;
  const empty = await fetchApp(app, "POST", "/api/reports/generate", { cookie, body: { type: "daily" } });
  assert.equal(empty.status, 409);
  assert.equal(empty.json.error.code, "report_empty");
});

test("PUT /api/push-rules 矩阵变更 → push.rules_updated 事件记录变更格子", async () => {
  const state = baseState();
  const eventLog = createEventLog();
  const notifier = { channels: {}, matrix: () => matrixFromRules(state.pushRules) };
  const push = createPushRoutes({ state, notifier, eventLog, store: null, reportScheduler: null, buildDeps: () => ({}) });
  const app = createApp();
  const requireAuth = createJwtMiddleware({ getSecret: () => SECRET });
  app.put("/api/push-rules", requireAuth, (ctx) => push.putPushRules(ctx));

  // 全新矩阵 daily.telegram 默认 false → 开启应记录在案
  const res = await fetchApp(app, "PUT", "/api/push-rules", {
    cookie: `ahatesla_token=${tokenFor()}`,
    body: { matrix: { daily: { webpush: true, telegram: true, feishu: true } } }
  });
  assert.equal(res.status, 200);
  const hit = eventLog.list().find((e) => e.type === "push.rules_updated");
  assert.ok(hit, "矩阵变更必须留审计事件");
  assert.ok(hit.changed.includes("daily.telegram"));
  assert.ok(hit.changed.includes("daily.webpush"));
  assert.ok(!hit.changed.includes("daily.feishu"), "未变的格子不记录");
});

// ---- CSV 导出（v2.4） ------------------------------------------------------

test("GET /api/export/trips：CSV 附件（BOM/表头/FIFO 口径行），未登录 401", async () => {
  const { app } = buildTestApp({ db: tripsFakeDb() });
  const anon = await fetchApp(app, "GET", "/api/export/trips");
  assert.equal(anon.status, 401);

  const res = await fetchApp(app, "GET", "/api/export/trips", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/csv; charset=utf-8");
  assert.match(res.headers["content-disposition"], /^attachment; filename="ahatesla-trips-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.ok(res.text.startsWith("﻿"), "UTF-8 BOM（Excel 中文不乱码）");
  const lines = res.text.slice(1).trimEnd().split(/\r\n/);
  assert.equal(lines[0], "开始时间,结束时间,起点,终点,里程(km),时长(分),能耗(kWh),电费(元),kWh/100km,路线");
  assert.equal(lines.length, 2, "tripsFakeDb 单行程 → 表头 + 1 行");
  assert.ok(lines[1].includes("家里"));
  assert.ok(lines[1].includes("21.5"));
});

test("GET /api/export/trips：含逗号/引号的围栏名按 RFC 4180 转义", async () => {
  // 地址列走 shortAddressLabel（按逗号拆段压缩，逗号进不来）；用户自建围栏名原样透传 → 转义必须在此生效
  const db = createFakeDb((sql) => {
    if (/FROM drives/.test(sql) && /LIMIT \$2 OFFSET \$3/.test(sql)) {
      return [{ id: 7, car_id: 1, start_at: "2026-10-13 02:00", end_at: "2026-10-13 03:00", distance_km: 10, duration_min: 60, start_address_id: null, end_address_id: 2, start_geofence_id: 5, end_geofence_id: null, efficiency: 150, ideal_used_km: 8, rated_used_km: 9 }];
    }
    if (/FROM addresses/.test(sql)) return [];
    if (/FROM charging_processes/.test(sql)) return [];
    if (/FROM geofences/.test(sql)) return [{ id: 5, name: '园区充电, "东门"侧', latitude: 31.2, longitude: 121.4 }];
    return [];
  });
  const { app } = buildTestApp({ db });
  const res = await fetchApp(app, "GET", "/api/export/trips", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  const dataLine = res.text.slice(1).trimEnd().split(/\r\n/)[1];
  assert.ok(dataLine.includes('"园区充电, ""东门""侧"'), "逗号包裹 + 内嵌引号翻倍");
});

test("GET /api/export/charging：CSV 附件 + 费用来源三态", async () => {
  const { app } = buildTestApp({ db: chargingFakeDb() });
  const res = await fetchApp(app, "GET", "/api/export/charging", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.match(res.headers["content-disposition"], /^attachment; filename="ahatesla-charging-\d{4}-\d{2}-\d{2}\.csv"$/);
  const lines = res.text.slice(1).trimEnd().split(/\r\n/);
  assert.equal(lines[0], "开始时间,结束时间,地点,充入(kWh),电费(元),单价(元/kWh),SoC起(%),SoC止(%),时长(分),峰值功率(kW),费用来源");
  assert.equal(lines.length, 3, "chargingFakeDb 2 会话 → 表头 + 2 行");
  assert.match(lines[1], /CND/);
  assert.match(lines[1], /已录入/);   // cost=38 stated → manual
  assert.match(lines[2], /默认估算/); // 无 cost 无围栏价 → default
});

// ---- 充电习惯画像（v2.5） --------------------------------------------------

test("GET /api/charging/habits：SoC 窗口/占比/十格直方图；起止缺失的会话不计入", async () => {
  const db = createFakeDb((sql) => {
    if (/FROM charging_processes cp/.test(sql) && /start_battery_level/.test(sql)) {
      return [
        { start_battery_level: 12, end_battery_level: 85 },
        { start_battery_level: 20, end_battery_level: 95 },
        { start_battery_level: 30, end_battery_level: 80 },
        { start_battery_level: 45, end_battery_level: 90 },
        { start_battery_level: null, end_battery_level: 70 }, // 起始缺失 → 剔除
        { start_battery_level: 18, end_battery_level: 88 },
        { start_battery_level: 22, end_battery_level: 92 },
        { start_battery_level: 35, end_battery_level: 78 },
        { start_battery_level: 28, end_battery_level: 83 },
        { start_battery_level: 40, end_battery_level: 96 },
        { start_battery_level: 15, end_battery_level: 75 },
      ];
    }
    return [];
  });
  const { app } = buildTestApp({ db });
  const res = await fetchApp(app, "GET", "/api/charging/habits", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  const j = res.json;
  assert.equal(j.sessions, 10, "10 对齐备样本");
  assert.equal(j.sufficient, true);
  assert.equal(j.avgStartSoc, 27); // 265/10 = 26.5 → 四舍五入
  assert.equal(j.avgEndSoc, 86);   // 862/10
  assert.equal(j.endAbove90Pct, 30); // 95/92/96 三次
  assert.equal(j.startBelow15Pct, 10); // 仅 12 一次
  assert.deepEqual(j.startHist, [0, 3, 3, 2, 2, 0, 0, 0, 0, 0]);
  assert.deepEqual(j.endHist, [0, 0, 0, 0, 0, 0, 0, 2, 4, 4]);
});

test("GET /api/charging/habits：样本不足 sufficient=false（前端隐藏依据）", async () => {
  const { app } = buildTestApp({ db: chargingFakeDb() });
  const res = await fetchApp(app, "GET", "/api/charging/habits", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.sufficient, false);
  assert.equal(res.json.sessions, 0);
});

// ---- 表显偏差 / 能效画像 / 保养提醒（v2.5/v2.6） --------------------------

test("GET /api/trips/display-accuracy：月度 ratio + 微样本月剔除", async () => {
  const { app } = buildTestApp({ db: tripsFakeDb() });
  const res = await fetchApp(app, "GET", "/api/trips/display-accuracy", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  const ms = res.json.months;
  assert.equal(ms.length, 2, "11 月 rated 9km < 50 剔除");
  assert.deepEqual(ms[0], { month: "2026-09", actualKm: 100, ratedKm: 105, trips: 1, ratio: 0.952 });
  assert.equal(ms[1].ratio, 0.9);
  assert.equal(res.json.avgRatio, 0.927); // 190/205
});

test("GET /api/trips/efficiency-profile：个人最佳 + 温度/速度分箱（里程加权）", async () => {
  const { app } = buildTestApp({ db: tripsFakeDb() });
  const res = await fetchApp(app, "GET", "/api/trips/efficiency-profile", { cookie: `ahatesla_token=${tokenFor()}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.samples, 4);
  // 最佳：60km @ 55km表显 × 0.152 → 139 Wh/km，20°C 均 60 km/h
  assert.equal(res.json.best.whPerKm, 139);
  assert.equal(res.json.best.tempC, 19);
  assert.equal(res.json.best.avgSpeedKmh, 60);
  // 温度箱：10~20°C = r1(160,100km)+r2(139,60km) 里程加权 → 152
  assert.equal(res.json.tempBins.find((b) => b.label === "10~20°C").whPerKm, 152);
  assert.equal(res.json.tempBins.find((b) => b.label === "0~10°C").whPerKm, 228);
  // 速度箱：60km/h 的两程落 60~80 → 152；100km/h 落 80+ → 167
  assert.equal(res.json.speedBins.find((b) => b.label === "60~80 km/h").whPerKm, 152);
  assert.equal(res.json.speedBins.find((b) => b.label === "80+ km/h").whPerKm, 167);
});

test("maintenance：默认配置 GET → PUT 持久化 → 到期判定；非法值 400", async () => {
  const savedKv = {};
  const store = { kvGet: (k) => savedKv[k] ?? null, kvPut: (k, v) => { savedKv[k] = v; } };
  const db = createFakeDb((sql) => (/FROM cars c/.test(sql) ? [{ id: 1, odometer_km: 24560 }] : []));
  const routes = createMaintenanceRoutes({ db, store });
  // 默认：两项，lastAtKm 未设 → dueInKm null
  const got = await routes.get({ query: {} });
  assert.equal(got.odometerKm, 24560);
  assert.equal(got.items.length, 2);
  assert.equal(got.items[0].label, "轮胎换位");
  assert.equal(got.items.every((i) => i.dueInKm == null), true);
  // PUT：换位上次 20000km → 剩 10000-(24560-20000)=5440；更换周期改 30000
  await routes.put({ body: { items: [{ key: "tireRotate", lastAtKm: 20000 }, { key: "tireReplace", intervalKm: 30000 }] } });
  const got2 = await routes.get({ query: {} });
  assert.equal(got2.items.find((i) => i.key === "tireRotate").dueInKm, 5440);
  assert.equal(got2.items.find((i) => i.key === "tireRotate").due, false);
  assert.equal(got2.items.find((i) => i.key === "tireReplace").intervalKm, 30000);
  // 已到期：换位周期 2000、上次 22000 → 2000-2560 = -560
  await routes.put({ body: { items: [{ key: "tireRotate", intervalKm: 2000, lastAtKm: 22000 }] } });
  const got3 = await routes.get({ query: {} });
  assert.equal(got3.items.find((i) => i.key === "tireRotate").dueInKm, -560);
  assert.equal(got3.items.find((i) => i.key === "tireRotate").due, true);
  // 校验：intervalKm 越界 400
  await assert.rejects(
    () => routes.put({ body: { items: [{ key: "tireRotate", intervalKm: 10 }] } }),
    (e) => e.status === 400,
  );
  // 未知 key 静默忽略
  await routes.put({ body: { items: [{ key: "hack", intervalKm: 1000 }] } });
  assert.equal(JSON.parse(savedKv["maintenance:items"]).length, 2);
});
