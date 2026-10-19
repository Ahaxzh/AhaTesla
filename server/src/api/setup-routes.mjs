// setup-routes.mjs — /api/setup/* 初始化向导后端（PRD §6.3 P1、契约 v2 §1）。
//
// 实例三态：uninitialized（无管理员）→ setup-locked（管理员已建，注册类端点 403）
//           → ready（数据源已配置）。
//
// 关键安全设计（AC-2.4）：只读校验 = has_table_privilege / has_schema_privilege
// 元数据探测，严禁 CREATE TABLE / INSERT 实写探测；连接池每个新会话强制
// SET default_transaction_read_only = on（会话级双保险）。
import pg from "pg";
import net from "node:net";
import { randomBytes } from "node:crypto";
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

// ---- m4a 轨道 B：存量 TeslaMate 自动接入（probe-discovery / auto-ro） -------
//
// 目标：把 README 里"手工 psql 建只读账号"吞进向导。用户提供一次性管理凭据，
// 服务端代执行 deploy/SQL/create-ro-user.sql 等价 SQL，建完只读账号即弃凭据。

const RO_USER = "ahatesla_ro";
/** 去掉易混淆字符（0O1lI）的密码字母表；不含引号，注入 SQL 安全。 */
const PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/** 生成 16 位只读账号密码（bytes 参数仅供测试确定性注入）。 */
export function generateRoPassword(bytes = randomBytes(16)) {
  let out = "";
  for (let i = 0; i < 16; i++) out += PW_ALPHABET[bytes[i] % PW_ALPHABET.length];
  return out;
}

/** create-ro-user.sql 的等价 SQL（幂等：角色存在只改密码；只授 SELECT）。 */
export function buildRoUserSql(password, database = "teslamate") {
  const db = String(database || "teslamate").replace(/[^a-zA-Z0-9_]/g, "");
  return `DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RO_USER}') THEN
    CREATE ROLE ${RO_USER} LOGIN PASSWORD '${password}';
  ELSE
    ALTER ROLE ${RO_USER} LOGIN PASSWORD '${password}';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE ${db} TO ${RO_USER};
GRANT USAGE ON SCHEMA public TO ${RO_USER};
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${RO_USER};

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${RO_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE teslamate IN SCHEMA public GRANT SELECT ON TABLES TO ${RO_USER};`;
}

/** 默认 TCP 探测：800ms 超时内连上即认为有服务在监听（不猜协议/库名）。 */
export function defaultTcpProbe(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

/** 从连接串提取 host:port（凭据一律不外带）。 */
function parseDbUrlTarget(url) {
  try {
    const u = new URL(url);
    return u.hostname ? { host: u.hostname, port: Number(u.port) || 5432 } : null;
  } catch {
    return null;
  }
}

/** 候选地址清单：容器服务名 + docker 网关 + AHATESLA_PROBE_HOSTS 展开 + 已配 DB_URL 目标。 */
export function probeCandidates(probeEnv = "", currentDbUrl = null) {
  const list = [];
  const target = currentDbUrl ? parseDbUrlTarget(currentDbUrl) : null;
  if (target) list.push(target);
  list.push(
    { host: "database", port: 5432 },
    { host: "teslamate-database", port: 5432 },
    { host: "postgres", port: 5432 },
    { host: "172.17.0.1", port: 5432 },
    { host: "172.18.0.1", port: 5432 },
  );
  for (const raw of String(probeEnv || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [host, port] = raw.split(":");
    if (host) list.push({ host, port: Number(port) || 5432 });
  }
  const seen = new Set();
  return list.filter((c) => {
    const key = `${c.host}:${c.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 管理员连接池（auto-ro 专用）：**不加**只读会话锁 —— 本端点就是要执行
 * CREATE ROLE / GRANT（AC-2.4 的实写禁区仅针对探测；这里是显式的管理操作，
 * 且只对角色/权限元数据生效，不碰业务表数据）。用完即关，凭据不落盘。
 */
export async function createAdminPool(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  return {
    pool,
    async query(sql, params = []) {
      const res = await pool.query(sql, params);
      return res.rows;
    },
    async close() {
      await pool.end().catch(() => {});
    },
  };
}

/**
 * 自动建只读账号（m4a 轨道 B）：
 *   admin 凭据连库（用完即关）→ 幂等执行 RO 建号 SQL → RO 账号回连验证
 *   （SELECT 1 + 只读元数据探测，确认为无写权限）→ 返回一次性明文密码。
 * 失败路径：stage=auth（管理员认证失败）/ permission（SQL 权限不足，附可
 * 复制执行的 fallbackSql）/ verify（RO 回连验证失败）。凭据绝不进错误信息。
 */
export async function runAutoRo(
  { host, port, database = "teslamate", adminUser, adminPassword },
  { pgAdminPoolFactory = createAdminPool, pgProbePoolFactory = createProbePool, generatePassword = generateRoPassword } = {},
) {
  if (!host || !adminUser || !adminPassword) {
    throw new HttpError(400, "bad_request", "host / adminUser / adminPassword required");
  }
  const portNum = Number(port) || 5432;
  const dbName = String(database || "teslamate");
  const roPassword = generatePassword();

  // 1) 管理员连库 + 执行建号 SQL（管理凭据仅存于本函数栈内，用完即关）。
  const adminCs = buildConnectionString({ host, port: portNum, database: dbName, user: adminUser, password: adminPassword });
  const roSql = buildRoUserSql(roPassword, dbName);
  let adminPool = null;
  try {
    try {
      adminPool = await pgAdminPoolFactory(adminCs);
      await adminPool.query("SELECT 1");
    } catch (error) {
      return { ok: false, stage: "auth", error: `管理员凭据连接失败：${sanitizeDbError(error)}` };
    }
    try {
      await adminPool.query(roSql);
    } catch (error) {
      return { ok: false, stage: "permission", error: `建号 SQL 执行失败：${sanitizeDbError(error)}`, fallbackSql: roSql };
    }
  } finally {
    await adminPool?.close();
  }

  // 2) RO 账号回连验证：连接 OK + 元数据探测确认无写权限。
  const roCs = buildConnectionString({ host, port: portNum, database: dbName, user: RO_USER, password: roPassword });
  let roPool = null;
  try {
    try {
      roPool = await pgProbePoolFactory(roCs);
      await roPool.query("SELECT 1");
      const probe = (await roPool.query(READONLY_PROBE_SQL))[0] || {};
      if (probe.table_write === true || probe.schema_create === true) {
        return { ok: false, stage: "verify", error: "只读账号验证失败：账号仍具备写权限" };
      }
    } catch (error) {
      return { ok: false, stage: "verify", error: `只读账号回连验证失败：${sanitizeDbError(error)}` };
    }
  } finally {
    await roPool?.close();
  }

  return {
    ok: true,
    dsn: `postgres://${RO_USER}:***@${host}:${portNum}/${dbName}`,
    password: roPassword,
  };
}


export function createSetupRoutes({
  state, db, getSecret, saveStateFn, eventLog,
  tcpProbe = defaultTcpProbe, pgAdminPoolFactory = createAdminPool, pgProbePoolFactory = createProbePool, currentDbUrl = null,
}) {
  function ensureUninitialized() {
    if (state.passwordHash) {
      throw new HttpError(403, "setup_locked", "管理员已注册，初始化入口已关闭（AC-1.4）");
    }
  }

  // 注册竞态占位（check-then-await-then-write 窗口内并发注册后写者胜）
  let registerInProgress = false;

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
      // 竞态防御：hashPassword 的 await 会让并发的第二个注册请求也通过
      // ensureUninitialized（后写者胜）。同步占位后二次校验。
      if (registerInProgress || state.passwordHash) throw new HttpError(409, "conflict", "setup already in progress");
      registerInProgress = true;
      try {
        state.username = name;
        state.passwordHash = await hashPassword(password);
        state.role = "admin";
        saveStateFn(state);
        eventLog?.log("setup.admin_registered", { username: name });
        issueAdminToken(ctx); // 注册后自动登录（P1 Step1）
        return { ok: true, user: { username: name, role: "admin" } };
      } finally {
        registerInProgress = false;
      }
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
    },

    // POST /api/setup/probe-discovery —— 管理员；存量接入候选地址 TCP 探测（m4a 轨道 B）。
    async probeDiscovery(ctx) {
      requireAdmin(ctx);
      const candidates = probeCandidates(process.env.AHATESLA_PROBE_HOSTS, currentDbUrl);
      const results = await Promise.all(
        candidates.map(async (c) => ({ host: c.host, port: c.port, reachable: await tcpProbe(c.host, c.port, 800) })),
      );
      return { candidates: results };
    },

    // POST /api/setup/auto-ro —— 管理员；一次性管理凭据自动建只读账号（m4a 轨道 B）。
    // adminPassword 仅在请求内存内使用，绝不落盘/入日志；成功返回一次性明文密码由前端组装 DSN。
    async autoRo(ctx) {
      requireAdmin(ctx);
      const { host, port, database, adminUser, adminPassword } = ctx.body || {};
      const result = await runAutoRo({ host, port, database, adminUser, adminPassword }, { pgAdminPoolFactory, pgProbePoolFactory });
      eventLog?.log("setup.auto_ro", { ok: result.ok, stage: result.stage ?? null, host: String(host ?? "") });
      return result;
    }
  };
}
