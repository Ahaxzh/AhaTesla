// system-routes.mjs — /api/system/*（状态/事件/匿名探活）。
// createSystemRoutes 自 dashboard-routes.mjs 迁出、createHealthLiteRoutes 自
// dashboard-extra-routes.mjs 迁出（系统域一处一域）。
import { getSystemStats } from "../core/teslamate-queries.mjs";
import { isoFromTeslaMate } from "../core/util.mjs";
import { isDemo } from "../core/demo-data.mjs";
import { healthState } from "../core/health.mjs";
import { VERSION } from "../version.mjs";

export function createSystemRoutes({ db, mqtt, eventLog, startedAt = () => Date.now() }) {
  return {
    async status(ctx) {
      let dbOk = false;
      let stats = null;
      let latencyMs = null;
      let readonlyVerified = null;
      try {
        const t0 = Date.now();
        await db.ping();
        latencyMs = Date.now() - t0;
        dbOk = true;
        stats = await getSystemStats(db);
        // 只读校验（GA-31）：元数据探测（同 /setup 四级校验第3步逻辑）
        try {
          const probe = await db.queryOne(`
            SELECT has_table_privilege(current_user, 'public.drives', 'INSERT,UPDATE,DELETE,TRUNCATE') AS table_write,
                   has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create
          `);
          readonlyVerified = !(probe?.table_write === true || probe?.schema_create === true);
        } catch { readonlyVerified = null; }
      } catch { /* teslamate down */ }
      const teslamate = {
        dbOk,
        latencyMs,
        readonlyVerified,
        lastDriveAt: isoFromTeslaMate(stats?.last_drive_at),
        driveCount: stats?.drive_count ?? null
      };
      // AC-5.1 / §7.1：MQTT 为可选增强，仅在已配置时返回 mqtt 块；
      // 未配置时状态页不显示 MQTT 项（字段整体缺省，而非 false）。
      if (mqtt?.isConfigured?.()) {
        teslamate.mqtt = { ok: mqtt.isConnected?.() ?? false };
      }
      return {
        teslamate,
        ...(isDemo() ? { demo: true } : {}), // m4d：演示模式标记（前端可显示 Demo 徽标）
        uptime: Math.round((Date.now() - (typeof startedAt === "function" ? startedAt() : startedAt)) / 1000),
        version: VERSION
      };
    },

    async events(ctx) {
      const limit = Math.max(1, Math.min(500, Number(ctx.query.limit) || 100));
      return { items: eventLog.list({ limit }) };
    }
  };
}

export function createHealthLiteRoutes({ healthRef }) {
  return {
    async healthLite(ctx) {
      // 匿名：仅返回 dbOk + 横幅级别，无任何车辆/账号信息
      const h = healthState();
      return { dbOk: h.dbOk, bannerLevel: h.bannerLevel, outageMs: h.outageMs };
    }
  };
}
