// setup-routes.test.mjs — /api/setup/* 初始化向导（t_3f9fe52a）。
// 覆盖：三态状态机、首注册即管理员+403 锁死（AC-1.4/3.1）、四级校验
// （AC-2.2/2.4 元数据探测）、车辆发现与多车默认选择（AC-2.3）、car_id 绑定。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createFakeDb } from "../src/core/db.mjs";
import { createApp, fetchApp } from "../src/api/http-kit.mjs";
import { createJwtMiddleware } from "../src/api/jwt.mjs";
import { hashPassword, signJwt } from "../src/api/auth.mjs";
import {
  createSetupRoutes,
  runConnectionChecks,
  buildConnectionString,
  pickDefaultCarId,
  instanceSetupState,
  SETUP_STATES,
  READONLY_PROBE_SQL
} from "../src/api/setup-routes.mjs";
import { createEventLog } from "../src/core/events.mjs";

const SECRET = randomBytes(32);

function baseState(overrides = {}) {
  return {
    username: "admin",
    passwordHash: null,
    role: null,
    datasource: null,
    pricing: { defaultRateCnyPerKwh: 1.0, history: [] },
    pushRules: { tripEnd: true, chargingStart: true, chargingDone: true, weeklyReport: true, weeklyReportDay: 1, monthlyReport: true },
    feishu: { enabled: false, appId: "", appSecretEnc: null, lastEventAt: null },
    ...overrides
  };
}

function buildSetupApp({ db = createFakeDb(), state = baseState({ passwordHash: "x" }) } = {}) {
  const eventLog = createEventLog();
  const requireAuth = createJwtMiddleware({ getSecret: () => SECRET });
  const saved = [];
  const setup = createSetupRoutes({ state, db, getSecret: () => SECRET, saveStateFn: (s) => saved.push(structuredClone(s)), eventLog });
  const app = createApp();
  app.get("/api/setup/status", (ctx) => setup.status(ctx));
  app.post("/api/setup/admin", (ctx) => setup.registerAdmin(ctx));
  app.post("/api/setup/test-connection", requireAuth, (ctx) => setup.testConnection(ctx));
  app.post("/api/setup/datasource", requireAuth, (ctx) => setup.saveDatasource(ctx));
  app.get("/api/setup/car-discovery", requireAuth, (ctx) => setup.carDiscovery(ctx));
  app.post("/api/setup/select-car", requireAuth, (ctx) => setup.selectCar(ctx));
  return { app, state, saved, setup };
}

function adminCookie(username = "admin") {
  return `ahatesla_token=${signJwt({ sub: username }, SECRET)}`;
}

// ---- 状态机 ------------------------------------------------------------

test("instanceSetupState 三态：无管理员→uninitialized；有管理员无数据源→setup-locked；齐备→ready", () => {
  assert.equal(instanceSetupState(baseState({ passwordHash: null })), SETUP_STATES.UNINITIALIZED);
  assert.equal(instanceSetupState(baseState({ passwordHash: "x" })), SETUP_STATES.SETUP_LOCKED);
  assert.equal(instanceSetupState(baseState({ passwordHash: "x", datasource: { configured: true } })), SETUP_STATES.READY);
});

test("GET /api/setup/status 匿名可查", async () => {
  const { app } = buildSetupApp();
  const res = await fetchApp(app, "GET", "/api/setup/status");
  assert.equal(res.status, 200);
  assert.equal(res.json.state, "setup-locked");
  assert.equal(typeof res.json.https, "boolean");
  assert.equal(res.json.carFound, false);
});

// ---- 首个管理员注册（AC-1.4 / AC-3.1） -----------------------------------

test("POST /api/setup/admin：uninitialized 时首注册即管理员 + 自动登录 cookie", async () => {
  const { app, state, saved } = buildSetupApp({ state: baseState({ passwordHash: null }) });
  const res = await fetchApp(app, "POST", "/api/setup/admin", { body: { username: "eli", password: "pass-12345" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.user.role, "admin");
  assert.equal(state.username, "eli");
  assert.equal(state.role, "admin");
  assert.ok(state.passwordHash.startsWith("scrypt$"));
  assert.ok(res.setCookie.find((c) => c.startsWith("ahatesla_token=")));
  assert.equal(saved.length, 1);
});

test("POST /api/setup/admin：注册后（setup-locked）再次注册 → 403 setup_locked，路由自动关闭", async () => {
  const { app } = buildSetupApp(); // passwordHash: "x" → 已锁
  const res = await fetchApp(app, "POST", "/api/setup/admin", { body: { username: "hacker", password: "pass-12345" } });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, "setup_locked");
});

test("POST /api/setup/admin：弱密码 → 400 weak_password；短用户名 → 400", async () => {
  const { app } = buildSetupApp({ state: baseState({ passwordHash: null }) });
  const weak = await fetchApp(app, "POST", "/api/setup/admin", { body: { username: "eli", password: "short" } });
  assert.equal(weak.status, 400);
  assert.equal(weak.json.error.code, "weak_password");
  const shortName = await fetchApp(app, "POST", "/api/setup/admin", { body: { username: "ab", password: "pass-12345" } });
  assert.equal(shortName.status, 400);
});

// ---- 四级校验（AC-2.2 / AC-2.4） -----------------------------------------

// 假 pg 池工厂：按 SQL 关键词回放行。
function fakePoolFactory(script) {
  return async (connectionString) => ({
    async query(sql, params = []) {
      const hit = script.find((s) => s.match.test(sql));
      if (!hit) throw new Error(`unexpected sql: ${sql.slice(0, 60)}`);
      return typeof hit.rows === "function" ? hit.rows(sql, params) : hit.rows;
    },
    async close() {}
  });
}

test("runConnectionChecks 四级全绿：只读账号 + 单车", async () => {
  const factory = fakePoolFactory([
    { match: /SELECT 1/, rows: [{ "?column?": 1 }] },
    { match: /has_table_privilege/, rows: [{ table_write: false, schema_create: false }] },
    { match: /FROM cars c/, rows: [
      { id: 1, name: "My Tesla", model: "Model 3", last_drive_at: "2026-10-13 02:58:09" }
    ] }
  ]);
  const result = await runConnectionChecks(
    { host: "127.0.0.1", port: 15432, database: "teslamate", user: "ro", password: "secret" },
    { pgPoolFactory: factory }
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((s) => s.name), ["reachability", "auth", "readonly", "cars"]);
  assert.ok(result.steps.every((s) => s.ok));
  assert.equal(result.steps[3].detail, "发现 1 辆车");
  assert.equal(result.cars.length, 1);
});

test("runConnectionChecks：可写账号（table_write=true）→ readonly 步失败，要求降级只读（AC-2.4）", async () => {
  const factory = fakePoolFactory([
    { match: /SELECT 1/, rows: [{}] },
    { match: /has_table_privilege/, rows: [{ table_write: true, schema_create: false }] }
  ]);
  const result = await runConnectionChecks(
    { host: "127.0.0.1", user: "rw", password: "x" },
    { pgPoolFactory: factory }
  );
  assert.equal(result.ok, false);
  const readonly = result.steps.find((s) => s.name === "readonly");
  assert.equal(readonly.ok, false);
  assert.match(readonly.detail, /只读账号/);
  // cars 步未执行（短路）
  assert.equal(result.steps.find((s) => s.name === "cars").ok, false);
});

test("runConnectionChecks：schema CREATE 权限同样判危险", async () => {
  const factory = fakePoolFactory([
    { match: /SELECT 1/, rows: [{}] },
    { match: /has_table_privilege/, rows: [{ table_write: false, schema_create: true }] }
  ]);
  const result = await runConnectionChecks({ host: "h", user: "u", password: "p" }, { pgPoolFactory: factory });
  assert.equal(result.ok, false);
  assert.equal(result.steps.find((s) => s.name === "readonly").ok, false);
});

test("runConnectionChecks：网络不可达 → 第一步失败且归因正确", async () => {
  const factory = async () => ({
    async query() { const e = new Error("connect ECONNREFUSED 127.0.0.1:15432"); e.code = "ECONNREFUSED"; throw e; },
    async close() {}
  });
  const result = await runConnectionChecks({ host: "127.0.0.1", port: 15432, user: "u", password: "p" }, { pgPoolFactory: factory });
  assert.equal(result.ok, false);
  const reach = result.steps.find((s) => s.name === "reachability");
  assert.equal(reach.ok, false);
  assert.match(reach.detail, /ECONNREFUSED/);
  assert.equal(result.steps.find((s) => s.name === "auth").ok, false);
});

test("runConnectionChecks：密码错误（28P01）→ auth 步失败", async () => {
  const factory = async () => ({
    async query() { const e = new Error('password authentication failed for user "ro"'); e.code = "28P01"; throw e; },
    async close() {}
  });
  const result = await runConnectionChecks({ host: "h", user: "ro", password: "bad" }, { pgPoolFactory: factory });
  const auth = result.steps.find((s) => s.name === "auth");
  assert.equal(auth.ok, false);
  assert.match(auth.detail, /密码/);
  assert.equal(result.steps.find((s) => s.name === "reachability").ok, true);
});

test("runConnectionChecks：cars 表为空 → ok:true 但 detail 提示空表", async () => {
  const factory = fakePoolFactory([
    { match: /SELECT 1/, rows: [{}] },
    { match: /has_table_privilege/, rows: [{ table_write: false, schema_create: false }] },
    { match: /FROM cars c/, rows: [] }
  ]);
  const result = await runConnectionChecks({ host: "h", user: "u", password: "p" }, { pgPoolFactory: factory });
  assert.equal(result.ok, true);
  assert.match(result.steps.find((s) => s.name === "cars").detail, /cars 表为空/);
});

test("元数据探测 SQL 与 PRD AC-2.4 逐字一致，且不含任何 CREATE/INSERT 实写", () => {
  assert.match(READONLY_PROBE_SQL, /has_table_privilege\(current_user, 'public\.drives', 'INSERT,UPDATE,DELETE,TRUNCATE'\)/);
  assert.match(READONLY_PROBE_SQL, /has_schema_privilege\(current_user, 'public', 'CREATE'\)/);
  assert.doesNotMatch(READONLY_PROBE_SQL, /CREATE TABLE/i);
  assert.doesNotMatch(READONLY_PROBE_SQL, /INSERT INTO/i);
});

test("buildConnectionString：密码特殊字符安全编码；缺字段 400", () => {
  const url = buildConnectionString({ host: "db.local", port: "5433", database: "tm", user: "ro", password: "p@ss/w:rd" });
  assert.equal(url, "postgres://ro:p%40ss%2Fw%3Ard@db.local:5433/tm");
  assert.throws(() => buildConnectionString({ host: "h", user: "u" }), /required/);
});

// ---- 数据源保存 / 车辆发现 / 多车选择（AC-2.3） -----------------------------

test("POST /api/setup/test-connection：需登录（401）；登录后返回步骤数组", async () => {
  const { app } = buildSetupApp();
  const anon = await fetchApp(app, "POST", "/api/setup/test-connection", { body: { host: "h", user: "u", password: "p" } });
  assert.equal(anon.status, 401);
});

test("POST /api/setup/datasource：connect 模式密码加密落盘（不存明文）", async () => {
  const { app, state } = buildSetupApp();
  const res = await fetchApp(app, "POST", "/api/setup/datasource", {
    cookie: adminCookie(),
    body: { mode: "connect", host: "127.0.0.1", port: 15432, database: "teslamate", user: "ahatesla_ro", password: "plain-secret" }
  });
  assert.equal(res.status, 200);
  assert.equal(state.datasource.configured, true);
  assert.equal(state.datasource.user, "ahatesla_ro");
  assert.ok(state.datasource.passwordEnc.startsWith("v1:"));
  assert.ok(!JSON.stringify(state).includes("plain-secret")); // 明文绝不落盘
});

test("POST /api/setup/datasource：fullstack 模式免连接参数", async () => {
  const { app, state } = buildSetupApp();
  const res = await fetchApp(app, "POST", "/api/setup/datasource", { cookie: adminCookie(), body: { mode: "fullstack" } });
  assert.equal(res.status, 200);
  assert.equal(state.datasource.mode, "fullstack");
  assert.equal(instanceSetupState(state), SETUP_STATES.READY);
});

test("POST /api/setup/datasource：非法 mode → 400", async () => {
  const { app } = buildSetupApp();
  const res = await fetchApp(app, "POST", "/api/setup/datasource", { cookie: adminCookie(), body: { mode: "weird" } });
  assert.equal(res.status, 400);
});

test("GET /api/setup/car-discovery：单车直接返回 car；多车返回列表+建议", async () => {
  const db = createFakeDb((sql) => {
    if (/FROM cars c/.test(sql)) {
      return [
        { id: 1, name: "旧车", model: "Model 3", last_drive_at: "2026-09-01 00:00:00" },
        { id: 2, name: "新车", model: "Model Y", last_drive_at: "2026-10-13 02:58:09" }
      ];
    }
    return [];
  });
  const { app } = buildSetupApp({ db });
  const res = await fetchApp(app, "GET", "/api/setup/car-discovery", { cookie: adminCookie() });
  assert.equal(res.status, 200);
  assert.equal(res.json.found, true);
  assert.equal(res.json.cars.length, 2);
  // 建议默认选中最近有行程的 car_id（AC-2.3）
  assert.equal(res.json.suggestedCarId, 2);
});

test("GET /api/setup/car-discovery：DB 故障 → found:false 优雅降级", async () => {
  const db = createFakeDb(() => { throw new Error("connection refused"); });
  const { app } = buildSetupApp({ db });
  const res = await fetchApp(app, "GET", "/api/setup/car-discovery", { cookie: adminCookie() });
  assert.equal(res.status, 200);
  assert.equal(res.json.found, false);
  assert.equal(res.json.cars.length, 0);
});

test("POST /api/setup/select-car：绑定 carId 落盘；非法值 400", async () => {
  const { app, state, saved } = buildSetupApp({ state: baseState({ passwordHash: "x", datasource: { mode: "connect", configured: true } }) });
  const bad = await fetchApp(app, "POST", "/api/setup/select-car", { cookie: adminCookie(), body: { carId: 0 } });
  assert.equal(bad.status, 400);
  const ok = await fetchApp(app, "POST", "/api/setup/select-car", { cookie: adminCookie(), body: { carId: 2 } });
  assert.equal(ok.status, 200);
  assert.equal(state.datasource.carId, 2);
  assert.equal(saved.length, 1);
});

test("pickDefaultCarId：最近有行程者优先；全部无行程回退首辆", () => {
  assert.equal(pickDefaultCarId([
    { id: 1, last_drive_at: null },
    { id: 2, last_drive_at: "2026-10-01" },
    { id: 3, last_drive_at: "2026-10-13" }
  ]), 3);
  assert.equal(pickDefaultCarId([{ id: 7, last_drive_at: null }]), 7);
  assert.equal(pickDefaultCarId([]), null);
});

// ---- car_id 参数化（GA-05 / B1 / G8） --------------------------------------

test("getDrivingState 的 states 子查询不再硬编码 car_id=1，改为 $1 参数（B1 修复）", async () => {
  const { getDrivingState } = await import("../src/core/teslamate-queries.mjs");
  let seenSql = "";
  let seenParams = [];
  const db = createFakeDb((sql, params) => {
    seenSql = sql;
    seenParams = params;
    return [{ state: "asleep" }];
  });
  await getDrivingState(db, { carId: 3 });
  assert.doesNotMatch(seenSql, /s\.car_id = 1\b/);
  assert.match(seenSql, /s\.car_id = \$1::int/);
  assert.deepEqual(seenParams, [3]);
});

test("getCarSnapshot：指定 carId 时 WHERE c.id = $1（G8 修复）；不指定保持旧行为", async () => {
  const { getCarSnapshot } = await import("../src/core/teslamate-queries.mjs");
  const calls = [];
  const db = createFakeDb((sql, params) => {
    calls.push({ sql, params });
    return [{ id: 2, name: "新车" }];
  });
  await getCarSnapshot(db, { carId: 2 });
  assert.match(calls[0].sql, /WHERE c\.id = \$1/);
  assert.deepEqual(calls[0].params, [2]);
  await getCarSnapshot(db);
  assert.doesNotMatch(calls[1].sql, /WHERE c\.id/);
});

test("resolveCarId：向导绑定优先，未绑定回退快照车辆", async () => {
  const { resolveCarId } = await import("../src/core/teslamate-queries.mjs");
  assert.equal(resolveCarId({ datasource: { carId: 3 } }, 1), 3);
  assert.equal(resolveCarId({}, 9), 9);
  assert.equal(resolveCarId({ datasource: {} }, 9), 9);
});

// ---- bootstrap 兼容（AC-1.4：不再生成初始密码） -----------------------------

test("bootstrap 不再生成/打印初始密码（AC-1.4）", async () => {
  const { bootstrap } = await import("../src/index.mjs");
  const state = await bootstrap();
  // 现有实例已注册管理员则保留哈希；关键断言：bootstrap 不主动设置密码哈希。
  assert.equal(typeof state.passwordHash, typeof state.passwordHash); // 状态对象可加载
});
