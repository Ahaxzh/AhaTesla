// maintenance.mjs — 保养里程提醒的领域判定（自 api/maintenance-routes.mjs 迁出）。
// 特斯拉没有保养灯，老车主靠脑子记 —— 基于 odometer 的周期提醒：
// 轮胎换位（默认 1 万 km）/ 轮胎更换（默认 4 万 km）。
// 配置走 SQLite kv（maintenance:items）持久化——state 白名单机制会静默丢新顶层字段。
import { finiteNumber } from "./util.mjs";
import { getCarSnapshot } from "./teslamate-queries.mjs";

export const MAINTENANCE_KV_KEY = "maintenance:items";

/** 保养项定义（固定两项起步；结构留扩展位，后续可加滤芯/雨刮等时间类） */
export const MAINTENANCE_ITEM_DEFS = [
  { key: "tireRotate", label: "轮胎换位", defaultIntervalKm: 10_000 },
  { key: "tireReplace", label: "轮胎更换", defaultIntervalKm: 40_000 },
];

export function readMaintenanceItems(store) {
  try {
    const raw = store.kvGet?.(MAINTENANCE_KV_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return parsed;
  } catch { /* 损坏配置回落默认 */ }
  return MAINTENANCE_ITEM_DEFS.map((d) => ({ key: d.key, intervalKm: d.defaultIntervalKm, lastAtKm: null }));
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
  const items = readMaintenanceItems(store).map((item) => {
    const def = MAINTENANCE_ITEM_DEFS.find((d) => d.key === item.key);
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
