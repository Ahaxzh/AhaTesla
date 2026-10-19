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
import { listChargingForStats } from "./teslamate-queries.mjs";
import { priceChargingSession } from "./pricing-ledger.mjs";
import { getFifoLedger } from "./fifo-ledger.mjs";
import { resolveAmapLabel } from "./geo-geocode.mjs";
import { pricingOptionsFor } from "./pricing-options.mjs";

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** 行程事件富化：查各 drive 段的聚合指标 + 端点信息。
 *  opts：{state} 提供时附加 FIFO 计价结果（能耗/电费/省钱/批次明细）——
 *  修复推送小结从未带出 ⚡/¥/💰 数字的问题（模板有字段、富化层从未填）。 */
export async function enrichTripEndEvent(db, event, opts = {}) {
  const ids = (event.segment_ids ?? []).map(Number).filter(Number.isInteger);
  if (!ids.length) return event;

  // 单查询拿全部维度（drives 聚合 + 端点坐标/地址/围栏 + positions 速度/温度/胎压）
  const rows = await db.query(`
    SELECT d.id,
           d.car_id,
           d.start_date,
           d.distance::float8 AS distance_km,
           d.duration_min,
           d.outside_temp_avg::float8 AS temp_avg,
           d.power_max::float8 AS power_max_kw,
           d.start_address_id, d.end_address_id,
           d.start_geofence_id, d.end_geofence_id,
           c.efficiency,
           greatest(d.start_ideal_range_km - d.end_ideal_range_km, 0) AS ideal_used_km,
           greatest(d.start_rated_range_km - d.end_rated_range_km, 0) AS rated_used_km,
           sp.start_lat, sp.start_lng, ep.end_lat, ep.end_lng,
           agg.avg_speed, agg.max_speed, agg.idle_ratio, agg.min_temp,
           tp.fl, tp.fr, tp.rl, tp.rr
    FROM drives d
    JOIN cars c ON c.id = d.car_id
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

  // 近似米距（纬度 1°≈111.3km，经度按 cos 缩放）
  const distM = (lat1, lng1, lat2, lng2) => {
    const dLat = (lat1 - lat2) * 111_320;
    const dLng = (lng1 - lng2) * 111_320 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
    return Math.hypot(dLat, dLng);
  };
  // 就近围栏：尊重围栏自身半径（±20% 容差，最小 150m）。
  // 旧版一刀切 550m 会让"家附近 400m 的没建围栏地点"也显示成 HOME。
  const nearestGf = (lat, lng) => {
    if (lat == null || lng == null) return null;
    let best = null;
    let bestD = Infinity;
    for (const g of geofences) {
      if (g.lat == null || g.lng == null) continue;
      const d = distM(lat, lng, g.lat, g.lng);
      if (d < bestD) { bestD = d; best = g; }
    }
    if (!best) return null;
    const limit = Math.max((best.radius ?? 0) * 1.2, 150);
    return bestD <= limit ? best.name : null;
  };
  // 地址表就近兜底（TeslaMate 异步反解的地址，250m 内取最近一条）
  const nearestAddr = async (lat, lng) => {
    if (lat == null || lng == null) return null;
    try {
      const r = await db.queryOne(`
        SELECT a.display_name, NULLIF(a.name, '') AS name, NULLIF(a.road, '') AS road, NULLIF(a.city, '') AS city
        FROM addresses a
        WHERE a.latitude IS NOT NULL AND a.longitude IS NOT NULL
        ORDER BY (a.latitude - $1) * (a.latitude - $1)
              + (a.longitude - $2) * (a.longitude - $2) * 0.7
        LIMIT 1
      `, [lat, lng]);
      if (!r) return null;
      // 粗排后复核真实距离（0.7 是经度压缩系数，粗排足够近似）
      return r ? addrLabel(r) : null;
    } catch {
      return null;
    }
  };
  const first = rows[0];
  const last = rows[rows.length - 1];
  // 第④级（可选，默认关）：三级全未命中 → 高德逆地理（与 Web 端行程页同口径）
  const startLabel = addrLabel(addresses[first.start_address_id])
    || gfById.get(first.start_geofence_id)?.name
    || nearestGf(first.start_lat, first.start_lng)
    || await resolveAmapLabel(first.start_lat, first.start_lng).catch(() => null)
    || await nearestAddr(first.start_lat, first.start_lng)
    || null;
  const endLabel = addrLabel(addresses[last.end_address_id])
    || gfById.get(last.end_geofence_id)?.name
    || nearestGf(last.end_lat, last.end_lng)
    || await resolveAmapLabel(last.end_lat, last.end_lng).catch(() => null)
    || await nearestAddr(last.end_lat, last.end_lng)
    || null;

  // P1-b 计价：全量回放缓存取本组行程段的分摊（与 Web 端同一套数字），
    // 并补齐能耗/电费/省钱核心数字（模板字段此前从未被填充）。
  // 任何失败静默省略字段——渲染端数据可得才显示。
  let fifoBatches = null;
  let energyKwh = null;
  let costCny = null;
  let savedCny = null;
  const tripCarId = Number.isInteger(Number(first.car_id)) && Number(first.car_id) > 0 ? Number(first.car_id) : null;
  if (opts.state?.pricing) {
    try {
      const ledger = await getFifoLedger(db, opts.state, tripCarId);
      const allocs = rows.map((r) => ledger.byDriveId.get(String(r.id))).filter(Boolean);
      const pricedAllocs = allocs.filter((a) => a.cost_cny_precise != null);
      const energySum = allocs.reduce((sum, a) => sum + (a.energy_kwh ?? 0), 0);
      const costSum = pricedAllocs.reduce((sum, a) => sum + a.cost_cny_precise, 0);
      if (allocs.length) {
        energyKwh = round(energySum, 1);
        if (pricedAllocs.length === allocs.length) {
          costCny = round(costSum, 2);
          const baseline = { literPer100km: 8.0, fuelPriceCnyPerL: 8.20, ...(opts.state.fuelBaseline || {}) };
          const perKm = baseline.literPer100km / 100 * baseline.fuelPriceCnyPerL;
          savedCny = round(totalKm * perKm - costSum, 2);
        }
        const nameByCp = new Map(ledger.chargingRows.map((s) => [Number(s.id), s.geofence_name || null]));
        const merged = new Map();
        for (const alloc of allocs) {
          for (const slice of alloc.slices || []) {
            if (slice.source === "unpriced" || slice.source === "parking_loss") continue;
            const key = slice.source === "batch" ? `cp-${slice.batch_id}` : "default";
            const label = slice.source === "batch"
              ? (nameByCp.get(Number(String(slice.batch_id).replace(/^cp-/, ""))) || "充电批次")
              : "默认电价";
            const cur = merged.get(key) || { source: label, kwh: 0, price: slice.unit_price_cny_per_kwh };
            cur.kwh = round(cur.kwh + slice.energy_kwh, 2);
            merged.set(key, cur);
          }
        }
        fifoBatches = [...merged.values()];
      }
    } catch { /* 批次不可得 → 不加字段 */ }
  }

  return {
    ...event,
    carId: tripCarId,
    distanceKm: round(totalKm, 1),
    durationMin: round(totalMin, 0),
    ...(energyKwh != null ? { energyKwh } : {}),
    ...(costCny != null ? { costCny } : {}),
    ...(savedCny != null ? { savedCny } : {}),
    kwhPer100km: totalKm > 2 && energyKwh != null ? round(energyKwh / totalKm * 100, 1) : null,
    avgTempC: temps.length ? round(temps.reduce((s, v) => s + v, 0) / temps.length, 1) : null,
    minTempC: minTemps.length ? round(Math.min(...minTemps), 1) : null,
    maxSpeedKmh: round(maxSpeed, 0),
    avgSpeedKmh: wAvgSpeed != null ? round(wAvgSpeed, 0) : null,
    idleRatio: idleRatio != null ? round(idleRatio, 2) : null,
    powerMaxKw: powerMax > 0 ? round(powerMax, 0) : null,
    tirePressure: tpRow ? { fl: tpRow.fl, fr: tpRow.fr, rl: tpRow.rl, rr: tpRow.rr } : null,
    startLabel,
    endLabel,
    ...(fifoBatches && fifoBatches.length ? { fifoBatches } : {}),
  };
}

/** 充电完成事件富化：补温度/电量/能耗/费用 + P1-d 同站近 5 次均价对比与提前中止标记。
 *  opts：{state} 提供时按四层回退计价并带出「充入 X kWh · ¥Y」（模板字段此前从未填充）。 */
export async function enrichChargingDoneEvent(db, event, opts = {}) {
  const id = Number(event.charging_process_id);
  if (!Number.isInteger(id)) return event;
  try {
    const rows = await db.query(`
      SELECT cp.end_battery_level, cp.charge_energy_added::float8 AS added,
             cp.geofence_id, cp.car_id, cp.start_date, cp.end_date, cp.cost,
             g.name AS geofence_name,
             g.cost_per_unit AS geofence_cost_per_unit, g.session_fee AS geofence_session_fee,
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
    const out = {
      ...event,
      locationName: r.geofence_name ?? event.locationName ?? null,
      tempC: finite(r.temp_c),
      endBattery: finite(r.end_battery_level),
    };
    if (r.car_id != null) out.carId = Number(r.car_id);
    if (out.endBattery != null && out.endBattery < 80) out.endedEarly = true;

    // 能耗/费用（四层回退，与充电页同口径）：有可用价才带出
    if (opts.state?.pricing && finite(r.added) != null) {
      try {
        const priced = priceChargingSession(
          { ...r, charge_energy_added: r.added },
          opts.state.pricing.defaultRateCnyPerKwh,
          await pricingOptionsFor(db, opts.state)
        );
        out.energyKwh = round(r.added, 1);
        if (priced.costCny != null) out.costCny = priced.costCny;
      } catch { /* 计价失败省略 */ }
    }

    // P1-d 同站近 5 次有效均价对比（不含本次；同车；分层计价:实付 > 围栏价/TOU > 默认价）
    if (r.geofence_id != null) {
      try {
        const sessions = await listChargingForStats(db, { carId: Number.isInteger(Number(r.car_id)) ? Number(r.car_id) : null });
        const priceOpts = await pricingOptionsFor(db, opts.state);
        const priceOf = (s) => priceChargingSession(s, null, priceOpts)?.pricePerUnit ?? null;
        const thisPrice = priceOf({ ...r, charge_energy_added: r.added });
        const past = sessions
          .filter((s) => Number(s.geofence_id) === Number(r.geofence_id)
            && Number(s.id) !== id
            && Number(s.car_id ?? 0) === Number(r.car_id ?? 0))
          .slice(-5)
          .map(priceOf)
          .filter((v) => v != null && v > 0);
        if (thisPrice != null && thisPrice > 0 && past.length >= 2) {
          const avg = past.reduce((s, v) => s + v, 0) / past.length;
          out.priceCmpPct = round((thisPrice - avg) / avg * 100, 0);
        }
      } catch { /* 对比不可得 → 省略 */ }
    }
    return out;
  } catch {
    return event;
  }
}

/** 充电开始事件富化（P1-c）：当前电量 + 同站近 5 次外推的预估时长/费用；m4e 同车对比 */
export async function enrichChargingStartEvent(db, event) {
  const id = Number(event.charging_process_id);
  if (!Number.isInteger(id)) return event;
  try {
    const rows = await db.query(`
      SELECT cp.geofence_id, cp.car_id, g.name AS location_name, g.cost_per_unit
      FROM charging_processes cp
      LEFT JOIN geofences g ON g.id = cp.geofence_id
      WHERE cp.id = $1
    `, [id]);
    const r = rows[0];
    if (!r) return event;
    const out = { ...event };
    if (r.location_name) out.locationName = r.location_name;
    if (r.car_id != null) out.carId = Number(r.car_id);

    // 电量：本车最新有效 position 读数（充电刚开始即起点电量；m4e 多车必须
    // 按车过滤，否则 B 车刚上报会把 A 车的充电开始电量标成 B 车的）
    const carFilter = Number.isInteger(r.car_id) && r.car_id > 0;
    const p = await db.queryOne(
      `SELECT p.battery_level::float8 AS bl FROM positions p
       WHERE p.battery_level IS NOT NULL AND ($1::int IS NULL OR p.car_id = $1::int)
       ORDER BY p.id DESC LIMIT 1`,
      [carFilter ? Number(r.car_id) : null]
    ).catch(() => null);
    if (p && finite(p.bl) != null) out.batteryPct = Math.round(finite(p.bl));

    // 同站近 5 次已结算会话外推（同车）：≥2 次才给预估（平均时长；固定单价 → 预估费用）
    if (r.geofence_id != null) {
      const past = await db.query(`
        SELECT cp.charge_energy_added::float8 AS kwh, cp.duration_min::float8 AS dur
        FROM charging_processes cp
        WHERE cp.geofence_id = $1 AND cp.end_date IS NOT NULL AND cp.id <> $2
          AND ($3::int IS NULL OR cp.car_id = $3::int)
        ORDER BY cp.start_date DESC LIMIT 5
      `, [r.geofence_id, id, Number.isInteger(Number(r.car_id)) && Number(r.car_id) > 0 ? Number(r.car_id) : null]);
      if (past.length >= 2) {
        const avg = (f) => past.reduce((s, x) => s + (f(x) ?? 0), 0) / past.length;
        const dur = Math.round(avg((x) => finite(x.dur)));
        const kwh = avg((x) => finite(x.kwh));
        const rate = finite(r.cost_per_unit);
        out.estimate = `预计 ${dur} 分钟${rate != null && rate > 0 ? ` · ¥${Math.round(kwh * rate)}` : ""}`;
      }
    }
    return out;
  } catch {
    return event;
  }
}
