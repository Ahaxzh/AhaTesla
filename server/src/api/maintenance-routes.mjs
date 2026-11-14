// maintenance-routes.mjs — 保养里程提醒（v2.5）：特斯拉没有保养灯，老车主靠脑子记。
// 基于 odometer 的周期提醒：轮胎换位（默认 1 万 km）/ 轮胎更换（默认 4 万 km）。
// 配置走 SQLite kv（maintenance:items）持久化——state 白名单机制会静默丢新顶层字段。
// 巡检推送（7 天节流）在 index.mjs，复用本文件的 maintenanceStatus 判定。

import { HttpError } from "./http-kit.mjs";
import { finiteNumber } from "../core/util.mjs";
import { getCarSnapshot } from "../core/teslamate-queries.mjs";

export const MAINTENANCE_KV_KEY = "maintenance:items";

/** 保养项定义（固定两项起步；结构留扩展位，后续可加滤芯/雨刮等时间类） */
const ITEM_DEFS = [
  { key: "tireRotate", label: "轮胎换位", defaultIntervalKm: 10_000 },
  { key: "tireReplace", label: "轮胎更换", defaultIntervalKm: 40_000 },
];

function readItems(store) {
  try {
    const raw = store.kvGet?.(MAINTENANCE_KV_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return parsed;
  } catch { /* 损坏配置回落默认 */ }
  return ITEM_DEFS.map((d) => ({ key: d.key, intervalKm: d.defaultIntervalKm, lastAtKm: null }));
}

/** 共享判定：当前里程 + 各项 {key,label,intervalKm,lastAtKm,dueInKm,due}。
 *  dueInKm = 周期 −（当前里程 − 上次保养里程）；≤0 = 已到期（负数=已超 |n| km）。
 *  odometer 不可得（teslamate 断连）→ items 仍返回但 dueInKm=null。 */
export async function maintenanceStatus(db, store, { carId = null } = {}) {
  let odometerKm = null;
  try {
    const snap = await getCarSnapshot(db, { carId });
    odometerKm = finiteNumber(snap?.odometer_km);
  } catch { /* 断连不影响配置读写 */ }
  const items = readItems(store).map((item) => {
    const def = ITEM_DEFS.find((d) => d.key === item.key);
    const intervalKm = finiteNumber(item.intervalKm) ?? def?.defaultIntervalKm ?? 10_000;
    const lastAtKm = finiteNumber(item.lastAtKm);
    const dueInKm = odometerKm != null && lastAtKm != null ? Math.round(intervalKm - (odometerKm - lastAtKm)) : null;
    return {
      key: item.key,
      label: def?.label ?? item.key,
      intervalKm,
      lastAtKm,
      dueInKm,
      due: dueInKm != null && dueInKm <= 0,
    };
  });
  return { odometerKm, items };
}

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
      const known = new Set(ITEM_DEFS.map((d) => d.key));
      const cur = new Map(readItems(store).map((i) => [i.key, i]));
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
      const items = ITEM_DEFS.map((d) => cur.get(d.key) ?? { key: d.key, intervalKm: d.defaultIntervalKm, lastAtKm: null });
      store.kvPut?.(MAINTENANCE_KV_KEY, JSON.stringify(items));
      return { ok: true, items };
    },
  };
}
