// pricing-options.mjs — 计价选项装配（四层回退的全链路统一入口）。
//
// overrides（第①层本地补录）+ TOU 窗口（第③层分时）+ 时区（TOU 墙钟口径）
// 曾分散在 ledger/charging/event-enrichment 三处各自装配，口径漂移出过两类真 bug：
//   - charging-routes 读错列名（cpId vs charging_process_id）→ 补录在充电页从未生效；
//   - trips/dashboard/computeTripViews 完全不传 options → 补录/TOU 后行程卡片
//     仍是旧价，与账本页对不上（违反 AC-7.6 重算后口径一致）。
// 此后所有计价路径（charging 列表/详情/统计、trips 列表/详情、dashboard、
// ledger 汇总/重算、推送富化、报表引擎）一律经 pricingOptionsFor 取同一份选项。
import { getStore } from "./state.mjs";
import { getGeofences } from "./teslamate-queries.mjs";

/** 实例时区（TOU 墙钟口径，settings.timezone，默认 Asia/Shanghai） */
export function instanceTimezone(state) {
  return state?.settings?.timezone || "Asia/Shanghai";
}

/** 第①层本地补录：Map<cpId, cost>（容错两种列名形态） */
export function overridesMapFromStore(store = getStore()) {
  const map = new Map();
  for (const row of store?.listChargeCostOverrides?.() ?? []) {
    const cpId = Number(row.cpId ?? row.charging_process_id);
    const cost = Number(row.cost);
    if (Number.isFinite(cpId) && Number.isFinite(cost)) map.set(cpId, cost);
  }
  return map;
}

/** 第③层 TOU 窗口：Map<geofenceId, touWindow>（kv pricing:location-tou:<id>） */
export async function touMapFromDb(db, store = getStore()) {
  const map = new Map();
  let geofences = [];
  try {
    geofences = await getGeofences(db);
  } catch {
    return map; // teslamate 不可达 → 无 TOU 可言，静默降级
  }
  for (const geofence of geofences) {
    const raw = store?.kvGet?.(`pricing:location-tou:${geofence.id}`);
    if (raw) {
      try { map.set(Number(geofence.id), JSON.parse(raw)); } catch { /* 坏数据忽略 */ }
    }
  }
  return map;
}

/** 统一装配：{ overrides, touByGeofenceId?, tz } */
export async function pricingOptionsFor(db, state = null, store = getStore()) {
  const touByGeofenceId = await touMapFromDb(db, store);
  return {
    overrides: overridesMapFromStore(store),
    ...(touByGeofenceId.size ? { touByGeofenceId } : {}),
    tz: instanceTimezone(state)
  };
}
