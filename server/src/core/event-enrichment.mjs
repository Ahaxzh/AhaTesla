// event-enrichment.mjs — 推送事件富化：从 teslamate 只读库补全驾驶洞察维度。
// 数据全部来自本地 TeslaMate 库（温度/胎压/速度/功率已有 33 万+ 行历史），
// 不调用任何外部天气 API（温度用车内/车外传感器实测值，比气象站更准）。
//
// 富化字段（trip_end 事件）：
//   distanceKm / durationMin / energyKwh / costCny / savedCny（既有）
//   + avgTempC / minTempC（车外实测）      —— 天气维度
//   + tirePressure {fl,fr,rl,rr}           —— 胎压维度（bar，行程最后一个有效值）
//   + avgSpeedKmh / maxSpeedKmh            —— 速度维度
//   + drivingTimeMin / idleTimeMin         —— 堵车维度（速度<5km/h 的采样占比）
//   + kwhPer100km / efficiencyPct          —— 能耗与效率达成率
//   + startLabel / endLabel                —— 起终点围栏名
//   + powerMaxKw                           —— 峰值功率（激烈驾驶指标）

import { getGeofences } from "./teslamate-queries.mjs";
import { getAddresses } from "./teslamate-queries.mjs";

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** 行程事件富化：查各 drive 段的聚合指标 + 端点信息 */
export async function enrichTripEndEvent(db, event) {
  const ids = (event.segment_ids ?? []).map(Number).filter(Number.isInteger);
  if (!ids.length) return event;

  // 单查询拿全部维度（drives 聚合 + 端点坐标/地址/围栏 + positions 速度/温度/胎压）
  const rows = await db.query(`
    SELECT d.id,
           d.distance::float8 AS distance_km,
           d.duration_min,
           d.outside_temp_avg::float8 AS temp_avg,
           d.power_max::float8 AS power_max_kw,
           d.start_address_id, d.end_address_id,
           d.start_geofence_id, d.end_geofence_id,
           sp.start_lat, sp.start_lng, ep.end_lat, ep.end_lng,
           agg.avg_speed, agg.max_speed, agg.idle_ratio, agg.min_temp,
           tp.fl, tp.fr, tp.rl, tp.rr
    FROM drives d
    LEFT JOIN LATERAL (
      SELECT p.latitude::float8 AS start_lat, p.longitude::float8 AS start_lng
      FROM positions p WHERE p.drive_id = d.id ORDER BY p.date ASC, p.id ASC LIMIT 1
    ) sp ON true
    LEFT JOIN LATERAL (
      SELECT p.latitude::float8 AS end_lat, p.longitude::float8 AS end_lng
      FROM positions p WHERE p.drive_id = d.id ORDER BY p.date DESC, p.id DESC LIMIT 1
    ) ep ON true
    LEFT JOIN LATERAL (
      SELECT avg(p.speed)::float8 AS avg_speed,
             max(p.speed)::float8 AS max_speed,
             (count(*) FILTER (WHERE p.speed < 5))::float8 / greatest(count(*), 1) AS idle_ratio,
             min(p.outside_temp)::float8 AS min_temp
      FROM positions p WHERE p.drive_id = d.id
    ) agg ON true
    LEFT JOIN LATERAL (
      SELECT p.tpms_pressure_fl::float8 AS fl, p.tpms_pressure_fr::float8 AS fr,
             p.tpms_pressure_rl::float8 AS rl, p.tpms_pressure_rr::float8 AS rr
      FROM positions p
      WHERE p.drive_id = d.id AND p.tpms_pressure_fl IS NOT NULL
      ORDER BY p.date DESC LIMIT 1
    ) tp ON true
    WHERE d.id = ANY($1::int[])
  `, [ids]);

  if (!rows.length) return event;

  const totalKm = rows.reduce((s, r) => s + (finite(r.distance_km) ?? 0), 0);
  const totalMin = rows.reduce((s, r) => s + (finite(r.duration_min) ?? 0), 0);
  const temps = rows.map((r) => finite(r.temp_avg)).filter((v) => v != null);
  const minTemps = rows.map((r) => finite(r.min_temp)).filter((v) => v != null);
  const maxSpeed = Math.max(...rows.map((r) => finite(r.max_speed) ?? 0), 0);
  const powerMax = Math.max(...rows.map((r) => finite(r.power_max_kw) ?? 0), 0);
  // 加权平均速度与怠速占比（按段里程加权近似）
  const wAvgSpeed = totalKm > 0
    ? rows.reduce((s, r) => s + (finite(r.avg_speed) ?? 0) * (finite(r.distance_km) ?? 0), 0) / totalKm
    : null;
  const idleRatio = totalMin > 0
    ? rows.reduce((s, r) => s + (finite(r.idle_ratio) ?? 0) * (finite(r.duration_min) ?? 0), 0) / totalMin
    : null;

  // 胎压：取任一段的最后一个有效读数（单次行程内变化极小）
  const tpRow = rows.find((r) => r.fl != null);

  // 端点标签
  const [geofences, addresses] = await Promise.all([
    getGeofences(db).catch(() => []),
    getAddresses(db, rows.flatMap((r) => [r.start_address_id, r.end_address_id]).filter(Boolean)).catch(() => ({})),
  ]);
  const gfById = new Map(geofences.map((g) => [g.id, g]));
  const addrLabel = (a) => (a ? [a.name, a.road, a.city].filter(Boolean).join(" ") || a.display_name || null : null);
  const nearestGf = (lat, lng) => {
    if (lat == null || lng == null) return null;
    let best = null;
    let bestD = Infinity;
    for (const g of geofences) {
      if (g.lat == null || g.lng == null) continue;
      const dLat = lat - g.lat;
      const dLng = (lng - g.lng) * Math.cos(((lat + g.lat) / 2) * Math.PI / 180);
      const d = dLat * dLat + dLng * dLng;
      if (d < bestD) { bestD = d; best = g; }
    }
    return best && Math.sqrt(bestD) <= 0.005 ? best.name : null;
  };
  const first = rows[0];
  const last = rows[rows.length - 1];
  const startLabel = addrLabel(addresses[first.start_address_id]) || gfById.get(first.start_geofence_id)?.name || nearestGf(first.start_lat, first.start_lng) || "起点";
  const endLabel = addrLabel(addresses[last.end_address_id]) || gfById.get(last.end_geofence_id)?.name || nearestGf(last.end_lat, last.end_lng) || "终点";

  return {
    ...event,
    distanceKm: round(totalKm, 1),
    durationMin: round(totalMin, 0),
    kwhPer100km: totalKm > 2 ? round((event.energyKwh ?? 0) / totalKm * 100, 1) : null,
    avgTempC: temps.length ? round(temps.reduce((s, v) => s + v, 0) / temps.length, 1) : null,
    minTempC: minTemps.length ? round(Math.min(...minTemps), 1) : null,
    maxSpeedKmh: round(maxSpeed, 0),
    avgSpeedKmh: wAvgSpeed != null ? round(wAvgSpeed, 0) : null,
    idleRatio: idleRatio != null ? round(idleRatio, 2) : null,
    powerMaxKw: powerMax > 0 ? round(powerMax, 0) : null,
    tirePressure: tpRow ? { fl: tpRow.fl, fr: tpRow.fr, rl: tpRow.rl, rr: tpRow.rr } : null,
    startLabel,
    endLabel,
  };
}

/** 充电完成事件富化：补温度/时段电价 */
export async function enrichChargingDoneEvent(db, event) {
  const id = Number(event.charging_process_id);
  if (!Number.isInteger(id)) return event;
  try {
    const rows = await db.query(`
      SELECT c.end_battery_level, c.charge_energy_added::float8 AS added,
             g.name AS geofence_name,
             (SELECT p.outside_temp::float8 FROM positions p
              WHERE p.date >= cp.start_date AND p.date <= cp.end_date
                AND p.outside_temp IS NOT NULL ORDER BY p.id DESC LIMIT 1) AS temp_c
      FROM charging_processes cp
      JOIN cars c ON c.id = cp.car_id
      LEFT JOIN geofences g ON g.id = cp.geofence_id
      WHERE cp.id = $1
    `, [id]);
    const r = rows[0];
    if (!r) return event;
    return {
      ...event,
      locationName: r.geofence_name ?? event.locationName ?? null,
      tempC: finite(r.temp_c),
      endBattery: finite(r.end_battery_level),
    };
  } catch {
    return event;
  }
}
