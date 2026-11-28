// maintenance-routes.mjs — /api/maintenance HTTP 层（领域判定在 core/maintenance.mjs）。
import { HttpError } from "./http-kit.mjs";
import { finiteNumber } from "../core/util.mjs";
import { maintenanceStatus, readMaintenanceItems, MAINTENANCE_ITEM_DEFS, MAINTENANCE_KV_KEY } from "../core/maintenance.mjs";

export { maintenanceStatus, MAINTENANCE_KV_KEY };

export function createMaintenanceRoutes({ db, store }) {
  return {
    /** GET /api/maintenance?carId —— 当前里程 + 各保养项到期状态（设置页展示 + 巡检共用） */
    async get(ctx) {
      const carId = ctx.query.carId ? Number(ctx.query.carId) : null;
      return maintenanceStatus(db, store, { carId: Number.isInteger(carId) ? carId : null });
    },

    /** PUT /api/maintenance {items:[{key,intervalKm,lastAtKm}]} —— 只认已知 key，数值钳制校验 */
    async put(ctx) {
      const body = ctx.body?.items;
      if (!Array.isArray(body)) throw new HttpError(400, "bad_request", "items must be an array");
      const known = new Set(MAINTENANCE_ITEM_DEFS.map((d) => d.key));
      const cur = new Map(readMaintenanceItems(store).map((i) => [i.key, i]));
      for (const item of body) {
        if (!item || typeof item.key !== "string" || !known.has(item.key)) continue;
        const merged = { ...cur.get(item.key) };
        if (item.intervalKm !== undefined) {
          const v = finiteNumber(item.intervalKm);
          if (v == null || v < 500 || v > 200_000) throw new HttpError(400, "bad_request", `${item.key}.intervalKm must be 500~200000`);
          merged.intervalKm = Math.round(v);
        }
        if (item.lastAtKm !== undefined) {
          const v = item.lastAtKm === null ? null : finiteNumber(item.lastAtKm);
          if (v != null && (v < 0 || v > 2_000_000)) throw new HttpError(400, "bad_request", `${item.key}.lastAtKm out of range`);
          merged.lastAtKm = v == null ? null : Math.round(v);
        }
        cur.set(item.key, merged);
      }
      const items = MAINTENANCE_ITEM_DEFS.map((d) => cur.get(d.key) ?? { key: d.key, intervalKm: d.defaultIntervalKm, lastAtKm: null });
      store.kvPut?.(MAINTENANCE_KV_KEY, JSON.stringify(items));
      return { ok: true, items };
    },
  };
}
