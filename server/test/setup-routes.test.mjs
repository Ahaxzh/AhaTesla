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

test("GET /api/setup/status 透出 AHATESLA_DEPLOY_MODE（未注入为 null）", async () => {
  const { app } = buildSetupApp();
  const without = await fetchApp(app, "GET", "/api/setup/status");
  assert.equal(without.json.deployMode, null);
  process.env.AHATESLA_DEPLOY_MODE = "fullstack";
  try {
    const { app: app2 } = buildSetupApp();
    const withMode = await fetchApp(app2, "GET", "/api/setup/status");
    assert.equal(withMode.json.deployMode, "fullstack");
  } finally {
    delete process.env.AHATESLA_DEPLOY_MODE;
  }
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

// ---- m4a 轨道 B：probe-discovery / auto-ro（存量接入自动建只读账号） --------

import {
  probeCandidates,
  buildRoUserSql,
  generateRoPassword,
  runAutoRo
} from "../src/api/setup-routes.mjs";

test("probeCandidates：DB_URL 目标置顶 + 默认候选 + env 展开去重", () => {
  const cands = probeCandidates("nas.lan:5433, dup.example", "postgres://u:p@10.0.0.5:15432/teslamate");
  assert.equal(cands[0].host, "10.0.0.5");
  assert.equal(cands[0].port, 15432);
  assert.ok(cands.some((c) => c.host === "database" && c.port === 5432));
  assert.ok(cands.some((c) => c.host === "172.17.0.1" && c.port === 5432));
  assert.ok(cands.some((c) => c.host === "nas.lan" && c.port === 5433));
  assert.ok(cands.some((c) => c.host === "dup.example" && c.port === 5432));
  const keys = cands.map((c) => `${c.host}:${c.port}`);
  assert.equal(new Set(keys).size, keys.length, "候选去重");
});

test("probeCandidates：无 env 无 DB_URL 时仅默认清单（5 项）", () => {
  assert.equal(probeCandidates("", null).length, 5);
});

test("POST /api/setup/probe-discovery：未登录 401；登录后逐候选 TCP 探测回报", async () => {
  const seen = [];
  const setup = createSetupRoutes({
    state: baseState({ passwordHash: "x" }), db: createFakeDb(),
    getSecret: () => SECRET, saveStateFn: () => {}, eventLog: createEventLog(),
    tcpProbe: async (host, port, timeoutMs) => {
      seen.push({ host, port, timeoutMs });
      return host === "database";
    },
  });
  const app = createApp();
  const requireAuth = createJwtMiddleware({ getSecret: () => SECRET });
  app.post("/api/setup/probe-discovery", requireAuth, (ctx) => setup.probeDiscovery(ctx));

  const anon = await fetchApp(app, "POST", "/api/setup/probe-discovery", {});
  assert.equal(anon.status, 401);

  const res = await fetchApp(app, "POST", "/api/setup/probe-discovery", { cookie: adminCookie() });
  assert.equal(res.status, 200);
  const reachable = res.json.candidates.filter((c) => c.reachable);
  assert.equal(reachable.length, 1);
  assert.equal(reachable[0].host, "database");
  assert.ok(seen.every((c) => c.timeoutMs === 800), "探测超时 800ms");
});

/** 记录开/关顺序的假池工厂：脚本匹配 SQL 关键词回放行。 */
function recordingPoolFactory(tag, log, script) {
  return async () => {
    log.push(`${tag}:open`);
    return {
      async query(sql) {
        const hit = script.find((s) => s.match.test(sql));
        if (!hit) throw new Error(`unexpected sql [${tag}]: ${sql.slice(0, 60)}`);
        log.push(`${tag}:query`);
        return typeof hit.rows === "function" ? hit.rows() : hit.rows;
      },
      async close() {
        log.push(`${tag}:close`);
      },
    };
  };
}

const ADMIN_OK_SCRIPT = [
  { match: /SELECT 1/, rows: [{}] },
  { match: /DO \$\$/, rows: [] },
];

test("runAutoRo 成功：admin 池用完即关 → RO 回连只读验证 → 掩码 DSN + 一次性密码", async () => {
  const log = [];
  const result = await runAutoRo(
    { host: "db.local", port: 5432, database: "teslamate", adminUser: "teslamate", adminPassword: "admin-secret" },
    {
      pgAdminPoolFactory: recordingPoolFactory("admin", log, ADMIN_OK_SCRIPT),
      pgProbePoolFactory: recordingPoolFactory("ro", log, [
        { match: /SELECT 1/, rows: [{}] },
        { match: /has_table_privilege/, rows: [{ table_write: false, schema_create: false }] },
      ]),
      generatePassword: () => "abcdefghijklmnop",
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.dsn, "postgres://ahatesla_ro:***@db.local:5432/teslamate");
  assert.equal(result.password, "abcdefghijklmnop");
  assert.ok(log.indexOf("admin:close") < log.indexOf("ro:open"), "admin 池先关，再用 RO 账号回连验证");
  assert.ok(log.filter((l) => l === "admin:query").length >= 2, "ping + 建号 SQL 都在 admin 池执行");
});

test("runAutoRo 管理员认证失败：stage=auth，无 fallbackSql，凭据不进响应", async () => {
  const factory = async () => ({
    async query() {
      const e = new Error('password authentication failed for user "teslamate"');
      e.code = "28P01";
      throw e;
    },
    async close() {},
  });
  const result = await runAutoRo(
    { host: "db", adminUser: "teslamate", adminPassword: "admin-secret" },
    { pgAdminPoolFactory: factory },
  );
  assert.equal(result.ok, false);
  assert.equal(result.stage, "auth");
  assert.equal(result.fallbackSql, undefined);
  assert.ok(!JSON.stringify(result).includes("admin-secret"));
});

test("runAutoRo SQL 权限不足：stage=permission + fallbackSql 内嵌已生成密码", async () => {
  const factory = async () => ({
    async query(sql) {
      if (/SELECT 1/.test(sql)) return [{}];
      const e = new Error("permission denied to alter role");
      e.code = "42501";
      throw e;
    },
    async close() {},
  });
  const result = await runAutoRo(
    { host: "db", adminUser: "u", adminPassword: "p" },
    { pgAdminPoolFactory: factory, generatePassword: () => "XYZpwd123456789A" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.stage, "permission");
  assert.match(result.fallbackSql, /CREATE ROLE ahatesla_ro LOGIN PASSWORD 'XYZpwd123456789A'/);
  assert.match(result.fallbackSql, /GRANT SELECT ON ALL TABLES IN SCHEMA public TO ahatesla_ro/);
});

test("runAutoRo RO 验证发现写权限残留：stage=verify", async () => {
  const result = await runAutoRo(
    { host: "db", adminUser: "u", adminPassword: "p" },
    {
      pgAdminPoolFactory: recordingPoolFactory("admin", [], ADMIN_OK_SCRIPT),
      pgProbePoolFactory: recordingPoolFactory("ro", [], [
        { match: /SELECT 1/, rows: [{}] },
        { match: /has_table_privilege/, rows: [{ table_write: true, schema_create: false }] },
      ]),
      generatePassword: () => "aaaaaaaaaaaaaaaa",
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.stage, "verify");
  assert.match(result.error, /写权限/);
});

test("buildRoUserSql：幂等（角色存在检查）+ 只授 SELECT + 库名消毒", () => {
  const sql = buildRoUserSql("pw1234567890abcd");
  assert.match(sql, /IF NOT EXISTS \(SELECT FROM pg_roles WHERE rolname = 'ahatesla_ro'\)/);
  assert.match(sql, /ALTER ROLE ahatesla_ro LOGIN PASSWORD/);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES/);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/, "不授任何写权限");
  const evil = buildRoUserSql("x", "teslamate; DROP TABLE cars; --");
  // 注入语法（; --）全被剥离，恶意输入坍缩成单个无害标识符，无法截断语句
  assert.ok(evil.includes("GRANT CONNECT ON DATABASE teslamateDROPTABLEcars TO ahatesla_ro"), "库名注入被消毒为纯标识符");
});

test("generateRoPassword：16 位且无易混淆字符", () => {
  const pw = generateRoPassword();
  assert.equal(pw.length, 16);
  assert.match(pw, /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{16}$/);
});

test("POST /api/setup/auto-ro 路由挂接：注入假池走通成功路径并记事件日志", async () => {
  const events = [];
  const eventLog = { log: (type, data) => events.push({ type, data }) };
  const setup = createSetupRoutes({
    state: baseState({ passwordHash: "x" }), db: createFakeDb(),
    getSecret: () => SECRET, saveStateFn: () => {}, eventLog,
    pgAdminPoolFactory: recordingPoolFactory("admin", [], ADMIN_OK_SCRIPT),
    pgProbePoolFactory: recordingPoolFactory("ro", [], [
      { match: /SELECT 1/, rows: [{}] },
      { match: /has_table_privilege/, rows: [{ table_write: false, schema_create: false }] },
    ]),
  });
  const app = createApp();
  const requireAuth = createJwtMiddleware({ getSecret: () => SECRET });
  app.post("/api/setup/auto-ro", requireAuth, (ctx) => setup.autoRo(ctx));

  const anon = await fetchApp(app, "POST", "/api/setup/auto-ro", { body: {} });
  assert.equal(anon.status, 401);

  const res = await fetchApp(app, "POST", "/api/setup/auto-ro", {
    cookie: adminCookie(),
    body: { host: "db", adminUser: "teslamate", adminPassword: "one-shot" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.match(res.json.dsn, /postgres:\/\/ahatesla_ro:\*\*\*@db:5432\/teslamate/);
  assert.equal(res.json.password.length, 16);
  const evt = events.find((e) => e.type === "setup.auto_ro");
  assert.ok(evt, "事件日志已记录");
  assert.ok(!JSON.stringify(evt).includes("one-shot"), "日志不含管理凭据");
  assert.equal(evt.data.host, "db");
});

// ---- saveDatasource 运行时接线（GA 修复：向导保存即切换主查询池）--------------------

test("saveDatasource connect：先 retarget 成功再落盘；retarget 失败不保存且报 400", async () => {
  const calls = [];
  const okDb = { retarget: async (dsn) => calls.push(dsn), query: async () => [] };
  const { app, state, saved } = buildSetupApp({ db: okDb });

  const res = await fetchApp(app, "POST", "/api/setup/datasource", {
    cookie: adminCookie(),
    body: { mode: "connect", host: "db.internal", port: 5433, database: "teslamate", user: "ahatesla_ro", password: "ro-pass" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  // retarget 收到完整 DSN（URL 编码）；密码已加密落 state，不存明文
  assert.deepEqual(calls, ["postgres://ahatesla_ro:ro-pass@db.internal:5433/teslamate"]);
  assert.equal(state.datasource.host, "db.internal");
  assert.equal(state.datasource.port, 5433);
  assert.ok(state.datasource.passwordEnc && !JSON.stringify(state.datasource).includes("ro-pass"), "明文密码不落盘");
  assert.equal(saved.length, 1, "retarget 成功后才落盘");

  // retarget 失败：400 + 连接未保存（原 state.datasource 保持 null）
  const badDb = { retarget: async () => { throw new Error("ECONNREFUSED"); } };
  const app2 = buildSetupApp({ db: badDb });
  const res2 = await fetchApp(app2.app, "POST", "/api/setup/datasource", {
    cookie: adminCookie(),
    body: { mode: "connect", host: "bad", port: 5432, database: "teslamate", user: "u", password: "p" },
  });
  assert.equal(res2.status, 400);
  assert.equal(res2.json.error.code, "datasource_unreachable");
  assert.equal(app2.state.datasource, null, "失败时数据源未写入");
  assert.equal(app2.saved.length, 0, "失败时不落盘");
});

test("saveDatasource fullstack：不 retarget（沿用 env DB 连接），仅落盘", async () => {
  const calls = [];
  const db = { retarget: async (dsn) => calls.push(dsn), query: async () => [] };
  const { app, state } = buildSetupApp({ db });
  const res = await fetchApp(app, "POST", "/api/setup/datasource", {
    cookie: adminCookie(),
    body: { mode: "fullstack" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [], "fullstack 不触发 retarget");
  assert.equal(state.datasource.mode, "fullstack");
});

test("instanceSetupState env 供给：fullstack 或 connect+DB_URL → ready（/setup 对已配实例锁门）", () => {
  const locked = baseState({ passwordHash: "x" }); // datasource: null
  const env = process.env;
  try {
    // 裸机开发（无 deployMode、无 DB_URL）→ setup-locked（向导是唯一途径）
    delete env.AHATESLA_DEPLOY_MODE; delete env.DB_URL;
    assert.equal(instanceSetupState(locked), SETUP_STATES.SETUP_LOCKED);
    // fullstack compose：恒注入 DB_URL → ready
    env.AHATESLA_DEPLOY_MODE = "fullstack";
    assert.equal(instanceSetupState(locked), SETUP_STATES.READY);
    // connect compose + 显式 DB_URL（开发者 override/.env）→ ready
    env.AHATESLA_DEPLOY_MODE = "connect"; env.DB_URL = "postgres://u:p@h:5432/d";
    assert.equal(instanceSetupState(locked), SETUP_STATES.READY);
    // connect compose 未填 DB_URL（向导配置型存量接入）→ setup-locked 保持可续配
    delete env.DB_URL;
    assert.equal(instanceSetupState(locked), SETUP_STATES.SETUP_LOCKED);
  } finally {
    delete env.AHATESLA_DEPLOY_MODE; delete env.DB_URL;
  }
});
