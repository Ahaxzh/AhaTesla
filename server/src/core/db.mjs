// db.mjs — PostgreSQL (pg) read-only connection pool to the TeslaMate database.
import pg from "pg";

export const DEFAULT_DB_URL = process.env.DB_URL || "postgres://teslamate@127.0.0.1:15432/teslamate";

export function createDb(dbUrl = DEFAULT_DB_URL) {
  const pool = new pg.Pool({
    connectionString: dbUrl,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000
  });

  async function query(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows;
  }

  async function queryOne(sql, params = []) {
    const rows = await query(sql, params);
    return rows[0] ?? null;
  }

  return {
    pool,
    query,
    queryOne,
    async ping() {
      await pool.query("SELECT 1");
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
