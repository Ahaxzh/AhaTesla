// trip-views.mjs — 行程视图装配（领域层，自 api/trips-routes 迁出）。
//
// 单一职责：TeslaMate drive 行 → 前端/推送/报表消费的 Trip 视图
// （时间/里程/能耗/FIFO 电费/起终点标签/路线键）。全部计价路径
// （trips 列表/详情、dashboard、export、报表引擎、推送富化）共用这一份
// 装配逻辑 —— 每公里成本、标签口径处处一致（AC-7.6）。
//
// 迁移动机：此前住 api/trips-routes.mjs 并经 index.mjs buildDeps 注入
// core/report-engine —— 领域逻辑住错层 + api 层反向成为 core 的依赖提供方
// （ADR-0001：core 不得依赖 api，依赖注入只是绕过检查的旁路）。
import { finiteNumber, round, isoFromTeslaMate } from "./util.mjs";
import { getFifoLedger } from "./fifo-ledger.mjs";
import { resolveAmapLabels } from "./geo-geocode.mjs";
import { getAddresses, getGeofences, geofenceLabelFor } from "./teslamate-queries.mjs";
import { shortRouteLabel, shortAddressLabel } from "./address-label.mjs";

function addressLabel(address) {
  if (!address) return null;
  return address.display_name
    || [address.name, address.road, address.city].filter(Boolean).join(" ")
    || null;
}

/** 第三级地点兜底：半径感知三级标签（围栏内→确定名；1.5km→"XX 附近"；更远→null）。
 *  纯本地数据计算，不调用任何外部逆地理 API（红线）。与推送富化同口径。 */
function nearestGeofenceName(geofenceRows, lat, lng) {
  return geofenceLabelFor(geofenceRows, lat, lng);
}

function routeKey(drive, addressMap, geofenceMap, geofenceRows, amapLabels) {
  const start = drive.start_address_id ? addressMap[drive.start_address_id] : null;
  const end = drive.end_address_id ? addressMap[drive.end_address_id] : null;
  const amap = (lat, lng) => (lat == null || lng == null ? null : amapLabels?.get(`${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`) ?? null);
  const a = addressLabel(start) || geofenceMap[drive.start_geofence_id] || nearestGeofenceName(geofenceRows, drive.start_lat, drive.start_lng) || amap(drive.start_lat, drive.start_lng) || "未知";
  const b = addressLabel(end) || geofenceMap[drive.end_geofence_id] || nearestGeofenceName(geofenceRows, drive.end_lat, drive.end_lng) || amap(drive.end_lat, drive.end_lng) || "未知";
  if (a === "未知" && b === "未知") return "未知";
  return shortRouteLabel(a, b);
}

/**
 * drive 行（listDrivesSql 形状）→ Trip 视图数组。
 * 电费 = FIFO 全量回放分摊；能耗缺失容忍 null；标签四级回退
 * （addresses 表 → geofence 命中 → 半径感知围栏 → 可选高德逆地理 → 未知）。
 */
export async function computeTripViews(db, drives, { defaultRate, history, state = null, carId = null } = {}) {
  const addressIds = drives.flatMap((drive) => [drive.start_address_id, drive.end_address_id]);
  const addressMap = await getAddresses(db, addressIds);
  // Fallback labels: reverse-geocoded addresses may be absent (privacy-off setups),
  // while TeslaMate geofence names (e.g. "CND", "HOME") are always set for known spots.
  const geofenceRows = await getGeofences(db);
  const geofenceMap = Object.fromEntries(geofenceRows.map((row) => [row.id, row.name]));
  const ledgerState = state ?? {
    pricing: { defaultRateCnyPerKwh: defaultRate, history: history ?? [] }
  };
  const ledger = await getFifoLedger(db, ledgerState, carId);

  // 第④级（可选，默认关）：三级标签全未命中的端点 → 高德逆地理批量解析
  // （同网格去重并发；未启用/失败静默回退"未知"）
  const unknownPoints = [];
  for (const drive of drives) {
    const endpoints = [
      { gf: drive.start_geofence_id, addr: drive.start_address_id, lat: drive.start_lat, lng: drive.start_lng },
      { gf: drive.end_geofence_id, addr: drive.end_address_id, lat: drive.end_lat, lng: drive.end_lng }
    ];
    for (const ep of endpoints) {
      if (ep.lat == null || ep.lng == null) continue;
      if (ep.addr != null || ep.gf != null || geofenceLabelFor(geofenceRows, ep.lat, ep.lng) != null) continue;
      unknownPoints.push({ lat: ep.lat, lng: ep.lng });
    }
  }
  let amapLabels = new Map();
  if (unknownPoints.length) {
    try { amapLabels = await resolveAmapLabels(unknownPoints); } catch { /* 保持未知 */ }
  }
  const amapOf = (lat, lng) => (lat == null || lng == null ? null : amapLabels.get(`${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`) ?? null);

  return drives.map((drive) => {
    const allocation = ledger.byDriveId.get(String(drive.id));
    const energy = allocation?.energy_kwh ?? null;
    const distance = finiteNumber(drive.distance_km);
    return {
      id: drive.id,
      startAt: isoFromTeslaMate(drive.start_at),
      endAt: isoFromTeslaMate(drive.end_at),
      distanceKm: distance,
      durationMin: Number(drive.duration_min) || 0,
      energyKWh: energy,
      cost: allocation?.cost_cny ?? null,
      startAddress: shortAddressLabel(addressLabel(addressMap[drive.start_address_id] || null)) || geofenceMap[drive.start_geofence_id] || nearestGeofenceName(geofenceRows, drive.start_lat, drive.start_lng) || amapOf(drive.start_lat, drive.start_lng) || null,
      endAddress: shortAddressLabel(addressLabel(addressMap[drive.end_address_id] || null)) || geofenceMap[drive.end_geofence_id] || nearestGeofenceName(geofenceRows, drive.end_lat, drive.end_lng) || amapOf(drive.end_lat, drive.end_lng) || null,
      kwhPer100km: energy !== null && distance > 0 ? round(energy / distance * 100, 2) : null,
      routeKey: routeKey(drive, addressMap, geofenceMap, geofenceRows, amapLabels)
    };
  });
}
