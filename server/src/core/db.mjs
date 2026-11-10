// db.mjs — PostgreSQL (pg) read-only connection pool to the TeslaMate database.
import pg from "pg";

export const DEFAULT_DB_URL = process.env.DB_URL || "postgres://teslamate@127.0.0.1:15432/teslamate";

// 慢查询观测：超过阈值（默认 2s，AHA_SLOW_QUERY_MS 可调）打一行首部 SQL 到 stdout
const SLOW_QUERY_LOG_MS = Number(process.env.AHA_SLOW_QUERY_MS) || 2000;

export function createDb(dbUrl = DEFAULT_DB_URL) {
  // pool 用 let 而非 const：retarget（向导保存数据源后运行时换池）需要整体替换，
  // 外部持有的 db 对象身份不变 —— 所有路由闭包无感知地切到新池。
  let pool = newPool(dbUrl);

  function newPool(connectionString) {
    return new pg.Pool({
      connectionString,
      // dashboard 并发首屏（快照/状态/月周统计/行程/充电/回放）6+ 路，
      // 监控循环常驻再占 1-2 —— max 5 会让第 6 路撞 5s 连接超时直接 500
      max: 10,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
      // 红线 1 深度防御（契约 §1）：每个新会话强制只读（经启动参数下发，无竞态）。
      // 此前只有 setup 探测池做了 —— 若 DB_URL 误配成可写账号（如全栈模式的
      // teslamate 超级用户），应用层将无任何写入阻断。
      options: "-c default_transaction_read_only=on"
    });
  }

  async function query(sql, params = []) {
    const t0 = Date.now();
    const result = await pool.query(sql, params);
    const ms = Date.now() - t0;
    if (ms > SLOW_QUERY_LOG_MS) {
      process.stdout.write(`[slow-query ${ms}ms] ${String(sql).replace(/\s+/g, " ").slice(0, 160)}\n`);
    }
    return result.rows;
  }

  async function queryOne(sql, params = []) {
    const rows = await query(sql, params);
    return rows[0] ?? null;
  }

  return {
    get pool() { return pool; },
    query,
    queryOne,
    async ping() {
      await pool.query("SELECT 1");
      return true;
    },
    // 运行时切换数据源（POST /api/setup/datasource 消费）：新池 ping 通过才算成功，
    // 失败则原池原封不动保留 —— 向导「测试并保存」失败不会打断现有连接。
    async retarget(dbUrl) {
      const next = newPool(dbUrl);
      try {
        await next.query("SELECT 1");
      } catch (error) {
        await next.end().catch(() => {});
        throw error;
      }
      const prev = pool;
      pool = next;
      await prev.end().catch(() => {});
      return true;
    },
    async close() {
      await pool.end();
    }
  };
}

// Fake db for unit tests: routeBySql receives (sql, params) and returns rows.
export function createFakeDb(routeBySql = () => []) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    const rows = await routeBySql(sql, params);
    return Array.isArray(rows) ? rows : [];
  };
  return {
    calls,
    query,
    async queryOne(sql, params = []) {
      const rows = await query(sql, params);
      return rows[0] ?? null;
    },
    ping: async () => true,
    close: async () => {}
  };
}
