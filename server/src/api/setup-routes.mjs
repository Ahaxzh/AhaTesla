// setup-routes.mjs — /api/setup/* 初始化向导后端（PRD §6.3 P1、契约 v2 §1）。
//
// 实例三态：uninitialized（无管理员）→ setup-locked（管理员已建，注册类端点 403）
//           → ready（数据源已配置）。
//
// 关键安全设计（AC-2.4）：只读校验 = has_table_privilege / has_schema_privilege
// 元数据探测，严禁 CREATE TABLE / INSERT 实写探测；连接池每个新会话强制
// SET default_transaction_read_only = on（会话级双保险）。
import pg from "pg";
import { HttpError } from "./http-kit.mjs";
import { signJwt, TOKEN_TTL_S, TOKEN_COOKIE, hashPassword } from "./auth.mjs";
import { encryptSecret } from "../core/secret-box.mjs";

export const SETUP_STATES = Object.freeze({
  UNINITIALIZED: "uninitialized",
  SETUP_LOCKED: "setup-locked",
  READY: "ready"
});

// PRD AC-2.4 的元数据探测 SQL：探测当前账号对 public.drives 的写权限或
// 对 public schema 的建表权限。任一为 true → 危险（可写）配置。
export const READONLY_PROBE_SQL = `
  SELECT has_table_privilege(current_user, 'public.drives', 'INSERT,UPDATE,DELETE,TRUNCATE') AS table_write,
         has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create
`;

export function isInstanceUninitialized(state) {
  return !state.passwordHash;
}

export function instanceSetupState(state) {
  if (!state.passwordHash) return SETUP_STATES.UNINITIALIZED;
  return state.datasource?.configured ? SETUP_STATES.READY : SETUP_STATES.SETUP_LOCKED;
}

/** 把 {host,port,database,user,password} 归一成 pg 连接串（密码仅进 URL，绝不落日志）。 */
export function buildConnectionString({ host, port = 5432, database = "teslamate", user, password }) {
  if (!host || !user || !password) throw new HttpError(400, "bad_request", "host / user / password required");
  const portNum = Number(port) || 5432;
  const db = database || "teslamate";
  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `postgres://${auth}@${host}:${portNum}/${db}`;
}

/**
 * 创建一次性探测连接池（小 max，短超时）。每个新会话强制只读会话锁
 * （SET default_transaction_read_only = on），即 AC-2.4 的会话级双保险。
 * 返回 { pool, query, close }。
 */
export async function createProbePool(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 8_000
  });
  // 会话锁：每个池内新建的连接都先置为只读事务模式。
  pool.on("connect", (client) => {
    client.query("SET default_transaction_read_only = on").catch(() => {});
  });
  return {
    pool,
    async query(sql, params = []) {
      const res = await pool.query(sql, params);
      return res.rows;
    },
    async close() {
      await pool.end().catch(() => {});
    }
  };
}

/**
 * 渐进式四级校验（AC-2.2 / 契约 §1）：
 *   1 reachability 网络可达 → 2 auth 数据库认证（凭据+teslamate 库存在）
 *   → 3 readonly 只读安全（元数据探测，可写=true 即危险）→ 4 cars 车辆发现。
 * 任一步失败即短路返回（后续步骤标记 skipped），绝不实写探测。
 */
export async function runConnectionChecks({ host, port, database, user, password }, { pgPoolFactory = createProbePool } = {}) {
  const steps = [
    { name: "reachability", ok: false, detail: "" },
    { name: "auth", ok: false, detail: "" },
    { name: "readonly", ok: false, detail: "" },
    { name: "cars", ok: false, detail: "" }
  ];
  const by = (name) => steps.find((s) => s.name === name);
  let pool = null;

  try {
    let connectionString;
    try {
      connectionString = buildConnectionString({ host, port, database, user, password });
    } catch (error) {
      by("reachability").detail = error.message;
      return { ok: false, steps };
    }

    // Step 1+2: 连接本身同时验证可达性与凭据/库存在，用错误码区分归因。
    try {
      pool = await pgPoolFactory(connectionString);
      await pool.query("SELECT 1");
    } catch (error) {
      const classified = classifyConnectError(error, host, port);
      // 网络级错误（ECONNREFUSED 等）→ 不可达；认证/库不存在 → 可达但凭据失败。
      const networkDown = /^(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|EAI_AGAIN)$/.test(error?.code || "");
      by("reachability").ok = !networkDown;
      by("reachability").detail = classified.reachability;
      by("auth").detail = classified.auth;
      return { ok: false, steps };
    }
    by("reachability").ok = true;
    by("reachability").detail = "数据库可达";
    by("auth").ok = true;
    by("auth").detail = "认证通过，数据库存在";

    // Step 3: 元数据只读探测（AC-2.4）。
    let probe;
    try {
      probe = (await pool.query(READONLY_PROBE_SQL))[0] || {};
    } catch (error) {
      by("readonly").detail = `只读探测查询失败：${sanitizeDbError(error)}`;
      return { ok: false, steps };
    }
    const dangerous = probe.table_write === true || probe.schema_create === true;
    if (dangerous) {
      by("readonly").detail = "当前账号具备写入权限，存在数据安全风险；请改用只读账号后重试（AC-2.4）";
      return { ok: false, steps };
    }
    by("readonly").ok = true;
    by("readonly").detail = "只读权限校验通过（元数据探测）";

    // Step 4: 车辆发现（cars 表）。
    let cars = [];
    try {
      cars = await pool.query(`
        SELECT c.id, c.name, c.model, c.vin IS NOT NULL AS has_vin,
               (SELECT max(d.end_date) FROM drives d WHERE d.car_id = c.id AND d.end_date IS NOT NULL) AS last_drive_at
        FROM cars c ORDER BY last_drive_at DESC NULLS LAST, c.id ASC
      `);
    } catch (error) {
      by("cars").detail = `cars 表查询失败：${sanitizeDbError(error)}`;
      return { ok: false, steps };
    }
    by("cars").ok = true;
    by("cars").detail = cars.length > 0 ? `发现 ${cars.length} 辆车` : "cars 表为空（请先在 TeslaMate 完成车机授权）";
    return { ok: true, steps, cars };
  } finally {
    await pool?.close();
  }
}

function classifyConnectError(error, host, port) {
  const message = sanitizeDbError(error);
  const code = error?.code || "";
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "EAI_AGAIN") {
    return {
      reachability: `无法连接 ${host}:${port ?? 5432}（${code}）`,
      auth: "未执行（网络不可达）"
    };
  }
  if (code === "28P01") return { reachability: "数据库可达", auth: `用户名或密码错误（${message}）` };
  if (code === "28000") return { reachability: "数据库可达", auth: `认证被拒绝：${message}` };
  if (code === "3D000") return { reachability: "数据库可达", auth: `数据库不存在：${message}` };
  return { reachability: "数据库可达", auth: `认证失败：${message}` };
}

/** 连接错误信息脱敏：去掉可能携带连接串/密码的括号部分。 */
function sanitizeDbError(error) {
  let message = String(error?.message || error || "unknown error");
  try {
    message = message.replace(/\bpostgres(?:ql)?:\/\/[^\s)]+/gi, "[connection-string]");
    message = message.replace(/password[^\s)]*/gi, "password=[redacted]");
  } catch { /* keep original */ }
  return message;
}

/** 多车默认选择：最近有行程（end_date 最大）的 car_id（AC-2.3）。 */
export function pickDefaultCarId(cars) {
  if (!Array.isArray(cars) || cars.length === 0) return null;
  let best = null;
  let bestAt = null;
  for (const car of cars) {
    const at = car.last_drive_at || car.lastDriveAt || null;
    if (at && (bestAt === null || String(at) > String(bestAt))) {
      best = car;
      bestAt = at;
    }
  }
  return (best || cars[0]).id;
}

export function createSetupRoutes({ state, db, getSecret, saveStateFn, eventLog }) {
  function ensureUninitialized() {
    if (state.passwordHash) {
      throw new HttpError(403, "setup_locked", "管理员已注册，初始化入口已关闭（AC-1.4）");
    }
  }

  function requireAdmin(ctx) {
    if (!ctx.user) throw new HttpError(401, "unauthorized", "authentication required");
  }

  function issueAdminToken(ctx) {
    const token = signJwt({ sub: state.username }, getSecret(), { ttlS: TOKEN_TTL_S });
    ctx.setCookie(TOKEN_COOKIE, token, { maxAge: TOKEN_TTL_S, httpOnly: true, path: "/", sameSite: "Lax" });
    return token;
  }

  return {
    // GET /api/setup/status —— 匿名可查：实例初始化状态 + https + 是否已发现车辆。
    async status(ctx) {
      return {
        state: instanceSetupState(state),
        https: ctx.req?.headers?.["x-forwarded-proto"] === "https" || String(ctx.req?.socket?.encrypted) === "true",
        carFound: Array.isArray(state.datasource?.cars) && state.datasource.cars.length > 0
      };
    },

    // POST /api/setup/admin —— 仅 uninitialized；首位注册即管理员，随后 403 锁死。
    async registerAdmin(ctx) {
      ensureUninitialized();
      const { username, password } = ctx.body || {};
      const name = String(username ?? "").trim();
      if (!name || name.length < 3) throw new HttpError(400, "bad_request", "用户名至少 3 个字符");
      if (typeof password !== "string" || password.length < 8) throw new HttpError(400, "weak_password", "密码至少 8 位（P1 Step1 强度校验）");
      state.username = name;
      state.passwordHash = await hashPassword(password);
      state.role = "admin";
      saveStateFn(state);
      eventLog?.log("setup.admin_registered", { username: name });
      issueAdminToken(ctx); // 注册后自动登录（P1 Step1）
      return { ok: true, user: { username: name, role: "admin" } };
    },

    // POST /api/setup/test-connection —— 管理员；四级校验（探测，不落盘）。
    async testConnection(ctx) {
      requireAdmin(ctx);
      const { host, port, database, user, password } = ctx.body || {};
      const result = await runConnectionChecks({ host, port, database, user, password });
      return {
        ok: result.ok,
        steps: result.steps,
        cars: result.cars
          ? result.cars.map((c) => ({ id: c.id, name: c.name, model: c.model, lastDriveAt: c.last_drive_at }))
          : []
      };
    },

    // POST /api/setup/datasource —— 管理员；保存连接（密码 AES-GCM 加密）。
    async saveDatasource(ctx) {
      requireAdmin(ctx);
      const { mode, host, port, database, user, password, carId } = ctx.body || {};
      if (mode !== "connect" && mode !== "fullstack") throw new HttpError(400, "bad_request", "mode 必须为 connect 或 fullstack");
      if (mode === "connect") {
        if (!host || !user || !password) throw new HttpError(400, "bad_request", "host / user / password required");
        state.datasource = {
          mode,
          host: String(host),
          port: Number(port) || 5432,
          database: String(database || "teslamate"),
          user: String(user),
          passwordEnc: encryptSecret(String(password)),
          configured: true,
          configuredAt: new Date().toISOString()
        };
      } else {
        // 全栈模式：同栈部署，直接沿用进程 DB 连接（.env DB_URL）。
        state.datasource = { mode, configured: true, configuredAt: new Date().toISOString() };
      }
      saveStateFn(state);
      eventLog?.log("setup.datasource_saved", { mode });
      return { ok: true };
    },

    // GET /api/setup/car-discovery —— 管理员；cars 表车辆发现（前端 2s 轮询，60s SLA）。
    async carDiscovery(ctx) {
      requireAdmin(ctx);
      let cars = [];
      try {
        cars = await db.query(`
          SELECT c.id, c.name, c.model,
                 (SELECT max(d.end_date) FROM drives d WHERE d.car_id = c.id AND d.end_date IS NOT NULL) AS last_drive_at
          FROM cars c ORDER BY last_drive_at DESC NULLS LAST, c.id ASC
        `);
      } catch (error) {
        return { found: false, cars: [], error: "cars 表查询失败" };
      }
      const view = cars.map((c) => ({ id: c.id, name: c.name, model: c.model, lastDriveAt: c.last_drive_at }));
      return {
        found: view.length > 0,
        cars: view,
        car: view[0] || null, // 单车：直接返回；多车：前端展示选择器（AC-2.3）
        suggestedCarId: pickDefaultCarId(view)
      };
    },

    // POST /api/setup/select-car —— 管理员；多车时绑定主 car_id（AC-2.3）。
    async selectCar(ctx) {
      requireAdmin(ctx);
      const carId = Number(ctx.body?.carId);
      if (!Number.isInteger(carId) || carId <= 0) throw new HttpError(400, "bad_request", "carId 必须为正整数");
      if (!state.datasource?.configured) throw new HttpError(400, "bad_request", "请先保存数据源配置");
      state.datasource.carId = carId;
      saveStateFn(state);
      eventLog?.log("setup.car_selected", { carId });
      return { ok: true, carId };
    }
  };
}
