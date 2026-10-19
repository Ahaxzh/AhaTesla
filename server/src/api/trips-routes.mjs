// trips routes — list/detail with batch-ledger cost allocation.
import { HttpError } from "./http-kit.mjs";
import { finiteNumber, round, isoFromTeslaMate } from "../core/util.mjs";
import { getFifoLedger } from "../core/fifo-ledger.mjs";
import { resolveAmapLabels } from "../core/geo-geocode.mjs";
import { listDrivesSql, getRoutePoints, getAddresses, getGeofences, geofenceLabelFor } from "../core/teslamate-queries.mjs";
import { carIdFromQuery, carFilterSql } from "./car-scope.mjs";

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
  return a === b ? a : `${a} → ${b}`;
}

function clampPaging(query) {
  const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
  const offset = Math.max(0, Number(query.offset) || 0);
  return { limit, offset };
}

function validateIso(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (Number.isNaN(new Date(value).getTime())) throw new HttpError(400, "bad_request", `invalid ${field} timestamp`);
  return new Date(value).toISOString();
}

// Shared: build trip views with costs from the full-replay FIFO ledger (H1 修复).
// 成本一律取自 getFifoLedger 的全量回放结果（历史行程已扣减批次池，闭包成立）。
// 优先用调用方传入的完整 state（时区/默认价/历史价一体）；仅传 defaultRate/
// history 的旧调用点（如 report-engine 依赖注入）合成等价最小 state。
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
      costCny: allocation?.cost_cny ?? null,
      startAddress: addressLabel(addressMap[drive.start_address_id] || null) || geofenceMap[drive.start_geofence_id] || nearestGeofenceName(geofenceRows, drive.start_lat, drive.start_lng) || amapOf(drive.start_lat, drive.start_lng) || null,
      endAddress: addressLabel(addressMap[drive.end_address_id] || null) || geofenceMap[drive.end_geofence_id] || nearestGeofenceName(geofenceRows, drive.end_lat, drive.end_lng) || amapOf(drive.end_lat, drive.end_lng) || null,
      kwhPer100km: energy !== null && distance > 0 ? round(energy / distance * 100, 2) : null,
      routeKey: routeKey(drive, addressMap, geofenceMap, geofenceRows, amapLabels)
    };
  });
}

async function getDrive(db, id) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) throw new HttpError(400, "bad_request", "invalid trip id");
  const rows = await db.query(`
    SELECT d.id, d.car_id,
           d.start_date AS start_at, d.end_date AS end_at,
           round(d.distance::numeric, 2) AS distance_km,
           d.duration_min,
           d.start_address_id, d.end_address_id,
           c.efficiency,
           greatest(d.start_ideal_range_km - d.end_ideal_range_km, 0) AS ideal_used_km,
           greatest(d.start_rated_range_km - d.end_rated_range_km, 0) AS rated_used_km,
           d.outside_temp_avg AS outside_temp_avg_c, d.start_position_id, d.end_position_id,
           (SELECT p.latitude::float8 FROM positions p WHERE p.id = d.start_position_id) AS start_lat,
           (SELECT p.longitude::float8 FROM positions p WHERE p.id = d.start_position_id) AS start_lng,
           (SELECT p.latitude::float8 FROM positions p WHERE p.id = d.end_position_id) AS end_lat,
           (SELECT p.longitude::float8 FROM positions p WHERE p.id = d.end_position_id) AS end_lng
    FROM drives d
    JOIN cars c ON c.id = d.car_id
    WHERE d.id = $1 AND d.end_date IS NOT NULL
  `, [numId]);
  return rows[0] ?? null;
}

// LTTB（Largest-Triangle-Three-Buckets）降采样（§6.5-3）：保形状，≤300 点。
export function lttbDownsample(points, threshold = 300) {
  if (!Array.isArray(points) || points.length <= threshold) return points || [];
  const sampled = [];
  const every = (points.length - 2) / (threshold - 2);
  sampled.push(points[0]);
  let a = 0;
  for (let i = 1; i < threshold - 1; i++) {
    const rangeStart = Math.floor((i + 1) * every) + 1;
    const rangeEnd = Math.min(Math.floor((i + 2) * every) + 1, points.length);
    // 计算 a..a+1 区间平均
    let avgX = 0, avgY = 0;
    const avgRangeLen = rangeEnd - rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) { avgX += points[j].x; avgY += points[j].y; }
    avgX /= avgRangeLen || 1; avgY /= avgRangeLen || 1;
    // 在下一区间选离“前点→均值线”三角形面积最大的点
    const rangeOff = Math.floor((i - 1) * every) + 1;
    const rangeTo = Math.floor(i * every) + 1;
    const px = points[a].x, py = points[a].y;
    let maxArea = -1, nextA = rangeOff;
    for (let j = rangeOff; j < rangeTo && j < points.length; j++) {
      const area = Math.abs((px - avgX) * (points[j].y - py) - (px - points[j].x) * (avgY - py)) * 0.5;
      if (area > maxArea) { maxArea = area; nextA = j; }
    }
    sampled.push(points[nextA]);
    a = nextA;
  }
  sampled.push(points[points.length - 1]);
  return sampled;
}

export function createTripsRoutes({ db, state }) {
  return {
    async list(ctx) {
      const { limit, offset } = clampPaging(ctx.query);
      const from = validateIso(ctx.query.from, "from");
      const to = validateIso(ctx.query.to, "to");
      const carId = carIdFromQuery(ctx, state); // m4e:?carId= > 主车 > 不限
      const { sql, params } = listDrivesSql({ from, to, carId });
      const rows = await db.query(sql, [...params, limit, offset]);
      const totalRow = await db.queryOne(`
        SELECT count(*)::int AS total
        FROM drives d
        WHERE d.end_date IS NOT NULL
        ${from ? `AND d.end_date >= ('${from}'::timestamptz AT TIME ZONE 'UTC')` : ""}
        ${to ? `AND d.end_date <= ('${to}'::timestamptz AT TIME ZONE 'UTC')` : ""}
        ${carFilterSql(carId)}
      `);
      const items = await computeTripViews(db, rows, { state, carId });
      return { total: totalRow ? totalRow.total : rows.length, items };
    },

    async detail(ctx) {
      const drive = await getDrive(db, ctx.params.id);
      if (!drive) throw new HttpError(404, "not_found", "trip not found");
      const [view] = await computeTripViews(db, [drive], {
        state,
        carId: drive.car_id ?? null
      });

      // FIFO 扣减明细（GA-23/24）：直接取全量回放中该行程的分配 slices
      // （批次池已被更早行程扣减 —— 与列表/账本同一次回放，同一套数字）
      const ledger = await getFifoLedger(db, state, drive.car_id ?? null);
      const alloc = ledger.byDriveId.get(String(drive.id)) ?? {};
      const charging = ledger.chargingRows;
      const geofenceRows = await getGeofences(db);
      const geofenceById = new Map(geofenceRows.map((g) => [g.id, g.name]));
      const batchLabel = (batchId) => {
        const cpId = Number(String(batchId).replace("cp-", ""));
        const session = charging.find((c) => Number(c.id) === cpId);
        const name = session ? (session.geofence_name || session.address_name || `会话 #${cpId}`) : `会话 #${cpId}`;
        const date = session ? String(session.end_at ?? session.end_date ?? "").slice(0, 10) : "";
        return date ? `${date} ${name}` : name;
      };
      const fifoBatches = (alloc.slices || [])
        .filter((s) => s.source === "batch")
        .map((s) => ({
          source: batchLabel(s.batch_id),
          kwh: s.energy_kwh,
          price: s.unit_price_cny_per_kwh,
          amount: s.cost_cny
        }));
      const defaultSlice = (alloc.slices || []).find((s) => s.source === "default");
      if (defaultSlice) {
        fifoBatches.push({ source: "默认电价", kwh: defaultSlice.energy_kwh, price: defaultSlice.unit_price_cny_per_kwh, amount: defaultSlice.cost_cny });
      }
      const fifoTotal = alloc.cost_cny ?? null;
      const energy = alloc.energy_kwh ?? null;
      const blendedPrice = energy && energy > 0 && fifoTotal !== null ? round(fifoTotal / energy, 4) : null;

      // 油车对比（AC-7.4 可配置基准）
      const baseline = { literPer100km: 8.0, fuelPriceCnyPerL: 8.20, ...(state.fuelBaseline || {}) };
      const perKm = baseline.literPer100km / 100 * baseline.fuelPriceCnyPerL;
      const distance = finiteNumber(drive.distance_km) ?? 0;
      const fuelCost = round(distance * perKm, 2);
      const saved = fifoTotal !== null ? round(fuelCost - fifoTotal, 2) : null;

      // 能效达成率（P3 模块1）：额定预估耗电 = distance × cars.efficiency
      const rawEff = finiteNumber(drive.efficiency);
      const kwhPerKm = rawEff === null ? null : rawEff > 1 ? rawEff / 1000 : rawEff;
      const ratedKwh = kwhPerKm !== null && distance > 0 ? round(distance * kwhPerKm, 2) : null;
      const ratio = ratedKwh !== null && energy !== null && energy > 0 ? round(ratedKwh / energy, 3) : null;

      // 环境剖析（P3 模块3）
      const avgSpeed = drive.duration_min > 0 ? round(distance / (drive.duration_min / 60), 1) : null;
      // 最高时速 + 空调估算（温度差近似）：取 positions 聚合
      let maxSpeed = null;
      let avgTempC = finiteNumber(drive.outside_temp_avg_c);
      try {
        const agg = await db.queryOne(`
          SELECT max(p.speed) AS max_speed, avg(p.outside_temp) AS avg_temp
          FROM positions p WHERE p.drive_id = $1
        `, [Number(drive.id)]);
        maxSpeed = finiteNumber(agg?.max_speed);
        if (avgTempC === null) avgTempC = finiteNumber(agg?.avg_temp);
      } catch { /* positions 缺列时忽略 */ }
      // AC 估算：环境温度偏离 20°C 每 5 度 +0.5 kWh/100km 的粗口径（仅展示参考）
      let acEstimateKwh = null;
      if (avgTempC !== null && energy !== null && distance > 0) {
        const deviation = Math.abs(avgTempC - 20);
        acEstimateKwh = round((deviation / 5) * 0.5 * (distance / 100), 2);
      }

      // 路线点（LTTB ≤300，GA-26）
      const points = await getRoutePoints(db, drive.id, 1200);
      const poly = points
        .map((p) => ({ x: new Date(String(p.date).endsWith("Z") || /[+-]\d{2}:?\d{2}$/i.test(String(p.date)) ? p.date : `${p.date}Z`).getTime() || 0, y: p.lat, lat: p.lat, lng: p.lng, speed: p.speed ?? null }))
        .filter((p) => Number.isFinite(p.x));
      const polyline = lttbDownsample(poly, 300).map((p) => ({ t: new Date(p.x).toISOString(), lat: p.lat, lng: p.lng, speed: p.speed ?? null }));

      return {
        ...view,
        route: polyline.map((p) => ({ t: p.t, lat: p.lat, lng: p.lng, speed: p.speed ?? null })),
        positionCount: points.length,
        fifo: {
          batches: fifoBatches,
          totalCost: fifoTotal,
          blendedPrice,
          exhaustedNote: (alloc.unpriced_kwh ?? 0) > 0
            ? `历史充电批次已耗尽，超出 ${(alloc.unpriced_kwh).toFixed(1)} kWh 无法计价`
            : null
        },
        fuelComparison: {
          baseline: `对比基准 ${baseline.literPer100km}L/100km @ ¥${baseline.fuelPriceCnyPerL}/L（¥${perKm.toFixed(3)}/km）`,
          fuelCost,
          saved,
          savedPct: saved !== null && fuelCost > 0 ? round((saved / fuelCost) * 100, 1) : null
        },
        efficiency: { ratedKwh, actualKwh: energy, ratio },
        environment: { avgTempC, acEstimateKwh, avgSpeedKmh: avgSpeed, maxSpeedKmh: maxSpeed }
      };
    }
  };
}
