// ledger-api.test.mjs — t_d9fb43bd API 层：TOU 配置路由、费用补录 7 天窗口、
// recalculate job、ledger summary（GA-14/16）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createFakeDb } from "../src/core/db.mjs";
import { createApp, fetchApp } from "../src/api/http-kit.mjs";
import { createJwtMiddleware } from "../src/api/jwt.mjs";
import { hashPassword, signJwt } from "../src/api/auth.mjs";
import { createPricingRoutes } from "../src/api/pricing-routes.mjs";
import { createLedgerRoutes } from "../src/api/ledger-routes.mjs";
import { openStore } from "../src/core/store.mjs";

const SECRET = randomBytes(32);
const TOKEN = signJwt({ sub: "admin" }, SECRET, 3600);

function buildApp({ db }) {
  const store = openStore({ file: ":memory:" });
  const state = {
    username: "admin",
    passwordHash: null,
    pricing: { defaultRateCnyPerKwh: 1.0, history: [] },
    pushRules: {}
  };
  const requireAuth = createJwtMiddleware({ getSecret: () => SECRET });
  const pricing = createPricingRoutes({ db, state, getStore: () => store });
  const ledger = createLedgerRoutes({ db, state, getStore: () => store });
  const app = createApp();
  app.get("/api/pricing", requireAuth, (ctx) => pricing.list(ctx));
  app.put("/api/pricing/locations/:id", requireAuth, (ctx) => pricing.updateLocation(ctx));
  app.put("/api/charging/:id/cost", requireAuth, (ctx) => ledger.putChargeCost(ctx));
  app.post("/api/ledger/summary", requireAuth, (ctx) => ledger.summary(ctx));
  app.post("/api/ledger/recalculate", requireAuth, (ctx) => ledger.startRecalculate(ctx));
  app.get("/api/ledger/recalculate/:jobId", requireAuth, (ctx) => ledger.recalculateStatus(ctx));
  return { app, store, state };
}

const authHeaders = { cookie: `ahatesla_token=${TOKEN}` };

test("PUT /api/pricing/locations/:id：tou 配置持久化并回读；fixed 清除", async () => {
  const db = createFakeDb((sql) => {
    if (/FROM geofences/i.test(sql)) {
      return [{ id: 5, name: "HOME", price_per_unit: null, session_fee: null, billing_type: null }];
    }
    return [];
  });
  const { app } = buildApp({ db });

  const put = await fetchApp(app, "PUT", "/api/pricing/locations/5", {
    headers: authHeaders,
    body: { priceMode: "tou", tou: { offPeakStart: "23:00", offPeakEnd: "07:00", offPeakRate: 0.3, peakRate: 1.2 } }
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.priceMode, "tou");

  const list = (await fetchApp(app, "GET", "/api/pricing", { headers: authHeaders })).json;
  const home = list.locations.find((l) => l.id === 5);
  assert.equal(home.priceMode, "tou");
  assert.equal(home.tou.offPeakRate, 0.3);

  // 切回 fixed → tou 清除
  const fix = await fetchApp(app, "PUT", "/api/pricing/locations/5", {
    headers: authHeaders, body: { priceMode: "fixed", pricePerUnit: 1.5 }
  });
  assert.equal(fix.status, 200);
  const list2 = (await fetchApp(app, "GET", "/api/pricing", { headers: authHeaders })).json;
  assert.equal(list2.locations.find((l) => l.id === 5).priceMode, "fixed");

  // 非法 tou → 400
  const bad = await fetchApp(app, "PUT", "/api/pricing/locations/5", {
    headers: authHeaders, body: { priceMode: "tou", tou: { offPeakStart: "25:00", offPeakEnd: "07:00", offPeakRate: 0.3, peakRate: 1.2 } }
  });
  assert.equal(bad.status, 400);
});

test("PUT /api/charging/:id/cost：7 天窗口内补录成功并触发重算；超窗 422", async () => {
  const recent = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  const old = new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString();
  let endAt = recent;
  const db = createFakeDb((sql) => {
    if (/FROM charging_processes cp WHERE cp\.id = \$1/.test(sql)) return [{ end_at: endAt }];
    if (/FROM charging/i.test(sql)) return [];
    if (/FROM drives/i.test(sql)) return [];
    return [];
  });
  const { app } = buildApp({ db });

  const ok = await fetchApp(app, "PUT", "/api/charging/42/cost", {
    headers: authHeaders, body: { amount: 66.6, note: "国网发票" }
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.ok(ok.json.jobId);

  endAt = old;
  const expired = await fetchApp(app, "PUT", "/api/charging/43/cost", {
    headers: authHeaders, body: { amount: 30 }
  });
  assert.equal(expired.status, 422);
  assert.equal(expired.json.error.code, "window_expired");

  // 非法金额 → 400
  const badAmount = await fetchApp(app, "PUT", "/api/charging/42/cost", {
    headers: authHeaders, body: { amount: -5 }
  });
  assert.equal(badAmount.status, 400);
});

test("POST /api/ledger/recalculate：返回 jobId，进度可查终态 done", async () => {
  const db = createFakeDb((sql) => {
    if (/FROM charging/i.test(sql)) {
      return [{ id: 1, start_at: "2026-01-01 10:00", end_at: "2026-01-01 11:00", charge_energy_added: 45, cost: 50 }];
    }
    return [];
  });
  const { app } = buildApp({ db });
  const start = (await fetchApp(app, "POST", "/api/ledger/recalculate", {
    headers: authHeaders, body: { all: true }
  })).json;
  assert.ok(start.jobId);
  // 轮询到终态（内存 job 异步完成极快）
  let status;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 20));
    status = (await fetchApp(app, "GET", `/api/ledger/recalculate/${start.jobId}`, { headers: authHeaders })).json;
    if (status.status === "done" || status.status === "error") break;
  }
  assert.equal(status.status, "done");
  assert.equal(status.progress, 100);

  // 未知 jobId → 404
  const nf = await fetchApp(app, "GET", "/api/ledger/recalculate/nope", { headers: authHeaders });
  assert.equal(nf.status, 404);
});

test("POST /api/ledger/summary：月份窗口校验与输出结构", async () => {
  const db = createFakeDb(() => []);
  const { app } = buildApp({ db });
  const ok = await fetchApp(app, "POST", "/api/ledger/summary?month=2026-01", { headers: authHeaders, body: {} });
  assert.equal(ok.status, 200);
  const body = ok.json;
  assert.equal(body.month, "2026-01");
  assert.ok("distanceKm" in body && "totalCost" in body && "parkingLoss" in body && "breakdown" in body);
  assert.ok(body.fuelComparison.baseline.includes("8L/100km"));

  const bad = await fetchApp(app, "POST", "/api/ledger/summary?month=2026-13", { headers: authHeaders, body: {} });
  assert.equal(bad.status, 400);
});
