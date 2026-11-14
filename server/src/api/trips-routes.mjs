// trips routes — list/detail with batch-ledger cost allocation.
import { HttpError } from "./http-kit.mjs";
import { finiteNumber, round, isoFromTeslaMate } from "../core/util.mjs";
import { getFifoLedger } from "../core/fifo-ledger.mjs";
import { resolveAmapLabels } from "../core/geo-geocode.mjs";
import { listDrivesSql, getRoutePoints, getAddresses, getGeofences, geofenceLabelFor } from "../core/teslamate-queries.mjs";
import { carIdFromQuery, carFilterSql } from "./car-scope.mjs";
import { shortRouteLabel, shortAddressLabel } from "../core/address-label.mjs";

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

/** 时间分布 v0.4 桶聚合（每日活跃柱状图数据源，替代 v0.3 三段占比条——驻车 ~96% 把占比条压成灰条）。
 *  行驶/充电按结束时刻归日（实例时区，同 heatmap 口径）；区间 ≤150 天按日零填充，
 *  更长自动按周（周一起）聚合，date=桶起始日——长区间点数有界（400 天≈58 桶），柱宽不被稀释。
 *  跨夏令时安全：UTC 正午步进 + Intl 归日（正午偏移 ±1h 不会跨日）。 */
export function dailyActivityPoints({ from, to, tzName, driveRows, chargeRows, nowMs = Date.now() }) {
  const DAY_MS = 86400_000;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tzName || "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  const dayKeyOf = (v) => {
    const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
    return Number.isFinite(ms) ? fmt.format(new Date(ms)) : null;
  };
  const noonOf = (dateStr) => { const [y, m, d] = dateStr.split("-").map(Number); return Date.UTC(y, m - 1, d, 12); };

  const driveByDay = new Map();
  const chargeByDay = new Map();
  let earliest = null;
  const touch = (date) => { if (date && (earliest === null || date < earliest)) earliest = date; };
  for (const r of driveRows) {
    const date = dayKeyOf(r.end_at);
    if (!date) continue;
    const cur = driveByDay.get(date) || { min: 0, trips: 0 };
    cur.min += finiteNumber(r.duration_min) || 0;
    cur.trips += 1;
    driveByDay.set(date, cur);
    touch(date);
  }
  for (const r of chargeRows) {
    const date = dayKeyOf(r.end_at);
    if (!date) continue;
    chargeByDay.set(date, (chargeByDay.get(date) || 0) + (finiteNumber(r.duration_min) || 0));
    touch(date);
  }

  // 桶区间：from（缺省=最早事件日）→ min(to, now)，未来日不零填充
  const startStr = dayKeyOf(from) || earliest;
  const endMs = Math.min(to ? new Date(to).getTime() : nowMs, nowMs);
  const endStr = dayKeyOf(new Date(endMs).toISOString());
  if (!startStr || !endStr || startStr > endStr) return { bucket: "day", points: [] };

  const totalDays = Math.round((noonOf(endStr) - noonOf(startStr)) / DAY_MS) + 1;
  const points = [];
  if (totalDays <= 150) {
    for (let t = noonOf(startStr); ; t += DAY_MS) {
      const date = fmt.format(new Date(t));
      if (date > endStr) break;
      const d = driveByDay.get(date);
      points.push({ date, driveMin: Math.round(d?.min || 0), chargeMin: Math.round(chargeByDay.get(date) || 0), trips: d?.trips || 0 });
    }
    return { bucket: "day", points };
  }
  // 周桶：周一起，桶内 7 天求和；首尾不满一周按实际日截断
  const mondayOf = (dateStr) => fmt.format(new Date(noonOf(dateStr) - ((new Date(noonOf(dateStr)).getUTCDay() + 6) % 7) * DAY_MS));
  for (let t = noonOf(mondayOf(startStr)); ; t += 7 * DAY_MS) {
    const wkStart = fmt.format(new Date(t));
    if (wkStart > endStr) break;
    let driveMin = 0, chargeMin = 0, trips = 0;
    for (let k = 0; k < 7; k++) {
      const date = fmt.format(new Date(t + k * DAY_MS));
      if (date > endStr) break;
      const d = driveByDay.get(date);
      if (d) { driveMin += d.min; trips += d.trips; }
      chargeMin += chargeByDay.get(date) || 0;
    }
    points.push({ date: wkStart, driveMin: Math.round(driveMin), chargeMin: Math.round(chargeMin), trips });
  }
  return { bucket: "week", points };
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
      startAddress: shortAddressLabel(addressLabel(addressMap[drive.start_address_id] || null)) || geofenceMap[drive.start_geofence_id] || nearestGeofenceName(geofenceRows, drive.start_lat, drive.start_lng) || amapOf(drive.start_lat, drive.start_lng) || null,
      endAddress: shortAddressLabel(addressLabel(addressMap[drive.end_address_id] || null)) || geofenceMap[drive.end_geofence_id] || nearestGeofenceName(geofenceRows, drive.end_lat, drive.end_lng) || amapOf(drive.end_lat, drive.end_lng) || null,
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
           (SELECT p.longitude::float8 FROM positions p WHERE p.id = d.end_position_id) AS end_lng,
           tp.tp_fl, tp.tp_fr, tp.tp_rl, tp.tp_rr
    FROM drives d
    JOIN cars c ON c.id = d.car_id
    LEFT JOIN LATERAL (
      -- 行程内最后一个有效 TPMS 读数（与推送行程小结同口径；行程内变化极小）
      SELECT p.tpms_pressure_fl::float8 AS tp_fl, p.tpms_pressure_fr::float8 AS tp_fr,
             p.tpms_pressure_rl::float8 AS tp_rl, p.tpms_pressure_rr::float8 AS tp_rr
      FROM positions p
      WHERE p.drive_id = d.id AND p.tpms_pressure_fl IS NOT NULL
      ORDER BY p.id DESC LIMIT 1
    ) tp ON true
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
    /** GET /api/trips/overview?from&to&carId —— 行程页顶部汇总（Grafana trip.json 提炼）：
     *  KPI（趟数/里程/时长/能耗/电费/最高速）+ 时间分布（v0.4：daily 每日活跃柱状图数据；
     *  stateShare 三段时长保留作图例/小字，驻车占比不再作为主视觉）。
     *  能耗电费走 FIFO 回放与列表同口径；时长为 SUM 近似（非逐段 timeline）。 */
    async overview(ctx) {
      const from = validateIso(ctx.query.from, "from");
      const to = validateIso(ctx.query.to, "to");
      const carId = carIdFromQuery(ctx, state);
      // 注意：carFilterSql 返回带前导 " AND " 的片段（内联用法），拼 where 数组须剥前缀，
      // 否则 join 后产生 "AND AND" 非法 SQL（v0.3 线上翻车点：被 .catch 静默吞成空数据）
      const where = ["d.end_date IS NOT NULL"];
      if (from) where.push(`d.end_date >= ('${from}'::timestamptz AT TIME ZONE 'UTC')`);
      if (to) where.push(`d.end_date <= ('${to}'::timestamptz AT TIME ZONE 'UTC')`);
      const carCond = carFilterSql(carId).replace(/^\s*AND\s+/i, "");
      if (carCond) where.push(carCond);
      const whereSql = where.join(" AND ");

      // 充电/行程取逐条 (end_at, duration_min)：chargeMin 求和替代旧 SUM 单查，行同时喂 daily 桶聚合
      const [aggRow, chargeRows, driveRows] = await Promise.all([
        db.queryOne(`
          SELECT count(*)::int AS n,
                 round(sum(d.distance)::numeric, 1) AS distance_km,
                 round(sum(d.duration_min)::numeric, 0) AS duration_min
          FROM drives d WHERE ${whereSql}
        `).catch(() => null),
        db.query(`
          SELECT cp.end_date AS end_at, cp.duration_min
          FROM charging_processes cp
          WHERE cp.end_date IS NOT NULL
            ${from ? `AND cp.end_date >= ('${from}'::timestamptz AT TIME ZONE 'UTC')` : ""}
            ${to ? `AND cp.end_date <= ('${to}'::timestamptz AT TIME ZONE 'UTC')` : ""}
            ${carFilterSql(carId, "cp.car_id")}
          ORDER BY cp.end_date ASC
        `).catch(() => []),
        db.query(`
          SELECT d.id, d.end_date AS end_at, d.duration_min
          FROM drives d WHERE ${whereSql} ORDER BY d.end_date DESC
        `).catch(() => []),
      ]);
      const drives = driveRows.map((r) => String(r.id));

      // 能耗/电费：FIFO 全量回放后按区间内 drive 求和（与列表卡同口径）
      let energyKwh = null;
      let costCny = null;
      if (drives.length) {
        const idSet = new Set(drives);
        const ledger = await getFifoLedger(db, state, carId).catch(() => null);
        if (ledger) {
          let e = 0, c = 0, any = false;
          for (const [id, alloc] of ledger.byDriveId) {
            if (!idSet.has(String(id))) continue;
            any = true;
            e += alloc.energy_kwh ?? 0;
            c += alloc.cost_cny ?? 0;
          }
          if (any) { energyKwh = round(e, 1); costCny = round(c, 2); }
        }
      }

      // 最高速：区间内 drives 的 positions MAX(speed)（drive_id 索引；区间行数有限）
      let maxSpeedKmh = null;
      if (drives.length) {
        try {
          const row = await db.queryOne(`
            SELECT max(p.speed) AS max_speed
            FROM positions p
            WHERE p.drive_id = ANY($1::int[])
          `, [drives.map(Number)]);
          maxSpeedKmh = finiteNumber(row?.max_speed);
        } catch { /* positions 缺列/超时 → 留空 */ }
      }

      const driveMin = finiteNumber(aggRow?.duration_min) ?? 0;
      const chargeMin = chargeRows.reduce((s, r) => s + (finiteNumber(r.duration_min) || 0), 0);
      const spanMin = Math.max(Math.round((to ? new Date(to).getTime() : Date.now()) - (from ? new Date(from).getTime() : Date.now())) / 60000, driveMin + chargeMin);
      return {
        tripCount: aggRow?.n ?? drives.length,
        distanceKm: finiteNumber(aggRow?.distance_km) ?? 0,
        durationMin: driveMin,
        energyKwh,
        costCny,
        maxSpeedKmh,
        stateShare: {
          driveMin: Math.round(driveMin),
          chargeMin: Math.round(chargeMin),
          parkedMin: Math.max(Math.round(spanMin - driveMin - chargeMin), 0),
        },
        daily: dailyActivityPoints({
          from, to,
          tzName: state.settings?.timezone,
          driveRows, chargeRows,
        }),
      };
    },

    /** GET /api/trips/display-accuracy?months=12&carId —— 表显 vs 实际偏差月趋势（v2.5）。
     *  "表显掉 1 km 实际能跑多少 km"：实际里程 ÷ 表显续航消耗，按月聚合。
     *  ratio>100 = 实际比表显耐跑；<90 = 表显偏乐观（长期走低是电池虚的信号，官方 App 不给这个）。
     *  样本守卫：单月表显消耗合计 <50 km 的月剔除（挪车微行程噪声）。 */
    async displayAccuracy(ctx) {
      const months = Math.max(6, Math.min(24, Number(ctx.query.months) || 12));
      const carId = carIdFromQuery(ctx, state);
      const since = new Date(Date.now() - months * 31 * 86400_000).toISOString();
      const rows = await db.query(`
        SELECT d.end_date AS end_at,
               d.distance::float8 AS distance_km,
               GREATEST(d.start_rated_range_km - d.end_rated_range_km, 0)::float8 AS rated_used_km
        FROM drives d
        WHERE d.end_date IS NOT NULL AND d.end_date >= ('${since}'::timestamptz AT TIME ZONE 'UTC')
          ${carFilterSql(carId)}
      `).catch(() => []);
      const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: state.settings?.timezone || "Asia/Shanghai", year: "numeric", month: "2-digit" });
      const msOfEnd = (v) => {
        if (v instanceof Date) return v.getTime();
        const s = String(v);
        return new Date(/[Z+]|T\d{2}:\d{2}:\d{2}/.test(s) ? s : `${s}Z`).getTime(); // teslamate naive-UTC
      };
      const byMonth = new Map();
      for (const r of rows) {
        const ms = msOfEnd(r.end_at);
        if (!Number.isFinite(ms)) continue;
        const key = fmt.format(new Date(ms));
        const cur = byMonth.get(key) || { actual: 0, rated: 0, trips: 0 };
        cur.actual += finiteNumber(r.distance_km) || 0;
        cur.rated += finiteNumber(r.rated_used_km) || 0;
        cur.trips += 1;
        byMonth.set(key, cur);
      }
      const out = [];
      let totalActual = 0, totalRated = 0;
      for (const [month, v] of [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (v.rated < 50) continue;
        totalActual += v.actual;
        totalRated += v.rated;
        out.push({ month, actualKm: round(v.actual, 1), ratedKm: round(v.rated, 1), trips: v.trips, ratio: round(v.actual / v.rated, 3) });
      }
      return { months: out.slice(-months), avgRatio: totalRated > 0 ? round(totalActual / totalRated, 3) : null };
    },

    /** GET /api/trips/efficiency-profile?days=365&carId —— 能效画像（v2.6，车主第一关注）。
     *  回答两件事：①我的最佳战绩是什么条件（Wh/km 最低的一程 + 当时温度/均速）
     *  ②什么情况下能耗最低——温度/均速分箱的加权平均 Wh/km（冷天热泵、高速风阻一目了然）。
     *  能耗口径与全站一致：表显续航消耗 × 车辆效率；短程(<1km)与离群值(50~400 Wh/km 外)剔除。 */
    async efficiencyProfile(ctx) {
      const days = Math.max(90, Math.min(730, Number(ctx.query.days) || 365));
      const carId = carIdFromQuery(ctx, state);
      const since = new Date(Date.now() - days * 86400_000).toISOString();
      const rows = await db.query(`
        SELECT d.end_date AS end_at, d.distance::float8 AS distance_km, d.duration_min::float8 AS duration_min,
               d.outside_temp_avg::float8 AS temp_c,
               GREATEST(d.start_rated_range_km - d.end_rated_range_km, 0)::float8 AS rated_used_km,
               c.efficiency::float8 AS efficiency
        FROM drives d JOIN cars c ON c.id = d.car_id
        WHERE d.end_date IS NOT NULL AND d.distance >= 1 AND d.end_date >= ('${since}'::timestamptz AT TIME ZONE 'UTC')
          ${carFilterSql(carId).replace(/^\s*AND\s+/i, "AND ")}
      `).catch(() => []);
      const msOf = (v) => (v instanceof Date ? v.getTime() : new Date(/[Z+]/.test(String(v)) ? v : `${v}Z`).getTime());
      const trips = [];
      for (const r of rows) {
        const km = finiteNumber(r.distance_km);
        const eff = finiteNumber(r.efficiency);
        const rated = finiteNumber(r.rated_used_km);
        if (km == null || !eff || rated == null || rated <= 0) continue;
        const whPerKm = rated * eff / km * 1000;
        if (whPerKm < 50 || whPerKm > 400) continue;
        const dur = finiteNumber(r.duration_min);
        const temp = finiteNumber(r.temp_c);
        trips.push({
          whPerKm: Math.round(whPerKm),
          km,
          tempC: temp,
          avgSpeedKmh: dur && dur > 0 ? Math.round(km / (dur / 60)) : null,
          endMs: msOf(r.end_at),
        });
      }
      // 个人最佳：≥5km 的行程里 Wh/km 最低的一程（短程能耗噪声大）
      let best = null;
      for (const t of trips) {
        if (t.km < 5) continue;
        if (!best || t.whPerKm < best.whPerKm) best = t;
      }
      // 分箱（加权平均按里程加权——长途占比更真实）
      const bin = (defs, pick, labelOf) => {
        const acc = defs.map(() => ({ wh: 0, km: 0, n: 0 }));
        for (const t of trips) {
          const v = pick(t);
          if (v == null) continue;
          const i = defs.findIndex(([lo, hi]) => v >= lo && v < hi);
          if (i === -1) continue;
          acc[i].wh += t.whPerKm * t.km;
          acc[i].km += t.km;
          acc[i].n += 1;
        }
        return acc.map((a, i) => ({ label: labelOf(defs[i]), whPerKm: a.km > 0 ? Math.round(a.wh / a.km) : null, count: a.n }));
      };
      const TEMP_BINS = [[-99, 0], [0, 10], [10, 20], [20, 30], [30, 99]];
      const SPEED_BINS = [[0, 40], [40, 60], [60, 80], [80, 999]];
      return {
        days,
        samples: trips.length,
        best: best ? {
          whPerKm: best.whPerKm, distanceKm: round(best.km, 1), tempC: best.tempC,
          avgSpeedKmh: best.avgSpeedKmh, at: Number.isFinite(best.endMs) ? new Date(best.endMs).toISOString() : null,
        } : null,
        tempBins: bin(TEMP_BINS, (t) => t.tempC, ([lo, hi]) => (lo === -99 ? `<${hi}°C` : hi === 99 ? `${lo}°C+` : `${lo}~${hi}°C`)),
        speedBins: bin(SPEED_BINS, (t) => t.avgSpeedKmh, ([lo, hi]) => (hi === 999 ? `${lo}+ km/h` : `${lo}~${hi} km/h`)),
      };
    },

    /** GET /api/trips/route-summary?from&to&carId —— 区间内行驶轨迹汇总（Grafana trip.json 地图提炼）。
     *  v0.3.1 重写：按 drive 分组抽样、每段 ≤10 点（含首尾），返回 segments 由前端逐段画线。
     *  旧版全局取模抽样把不同行程串成一条 polyline → 满屏跨城"飞线"（蜘蛛网），已废。
     *  只取 drive_id 非空的 positions（纯行驶轨迹）；行数按距离取最长 ≤400 段控制扫描量。 */
    async routeSummary(ctx) {
      const from = validateIso(ctx.query.from, "from");
      const to = validateIso(ctx.query.to, "to");
      const carId = carIdFromQuery(ctx, state);
      const where = ["d.end_date IS NOT NULL"];
      if (from) where.push(`d.end_date >= ('${from}'::timestamptz AT TIME ZONE 'UTC')`);
      if (to) where.push(`d.end_date <= ('${to}'::timestamptz AT TIME ZONE 'UTC')`);
      const carCond = carFilterSql(carId).replace(/^\s*AND\s+/i, "");
      if (carCond) where.push(carCond);

      // 1) 区间内最长的 ≤400 段行程（距离优先——挪车微行程画出来只是噪点）
      const drives = await db.query(`
        SELECT d.id FROM drives d WHERE ${where.join(" AND ")}
        ORDER BY d.distance DESC NULLS LAST LIMIT 400
      `).catch(() => []);
      const ids = drives.map((r) => Number(r.id)).filter(Number.isInteger);
      if (!ids.length) return { tripCount: 0, segments: [] };

      // 2) 每段行程均匀取 ≤10 点（窗口计数 + 取模；首尾必含），按 drive 分组返回
      const PER_DRIVE = 10;
      const rows = await db.query(`
        WITH pts AS (
          SELECT p.drive_id,
                 p.latitude::float8 AS lat, p.longitude::float8 AS lng, p.speed::float8 AS speed,
                 row_number() OVER (PARTITION BY p.drive_id ORDER BY p.date, p.id) AS rn,
                 count(*) OVER (PARTITION BY p.drive_id) AS cnt
          FROM positions p
          WHERE p.drive_id = ANY($1::int[]) AND p.latitude IS NOT NULL
        )
        SELECT drive_id, lat, lng, speed FROM pts
        WHERE rn = 1 OR rn = cnt OR rn % GREATEST(FLOOR(cnt / ${PER_DRIVE}.0)::int, 1) = 0
        ORDER BY drive_id, rn
      `, [ids]).catch(() => []);

      const byDrive = new Map();
      for (const r of rows) {
        const key = Number(r.drive_id);
        if (!byDrive.has(key)) byDrive.set(key, []);
        byDrive.get(key).push({ lat: Number(r.lat), lng: Number(r.lng), speed: finiteNumber(r.speed) });
      }
      const segments = [...byDrive.entries()]
        .filter(([, pts]) => pts.length >= 2)
        .map(([driveId, points]) => ({ driveId, points }));
      return { tripCount: ids.length, segments };
    },

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
        .map((p) => ({ x: new Date(String(p.date).endsWith("Z") || /[+-]\d{2}:?\d{2}$/i.test(String(p.date)) ? p.date : `${p.date}Z`).getTime() || 0, y: p.lat, lat: p.lat, lng: p.lng, speed: p.speed ?? null, elevation: p.elevation ?? null }))
        .filter((p) => Number.isFinite(p.x));
      const polyline = lttbDownsample(poly, 300).map((p) => ({ t: new Date(p.x).toISOString(), lat: p.lat, lng: p.lng, speed: p.speed ?? null, elevation: p.elevation ?? null }));

      // SoC 起止（v2.5）："这趟从 78% 开到 31%"是车主本能语言——取行程首/末有效电量读数；
      // 两点索引查询（positions.drive_id 有索引）；缺列/无读数 → null 不渲染
      let soc = null;
      try {
        const [first, last] = await Promise.all([
          db.queryOne(`SELECT p.battery_level::int AS v FROM positions p WHERE p.drive_id = $1 AND p.battery_level IS NOT NULL ORDER BY p.id ASC LIMIT 1`, [drive.id]),
          db.queryOne(`SELECT p.battery_level::int AS v FROM positions p WHERE p.drive_id = $1 AND p.battery_level IS NOT NULL ORDER BY p.id DESC LIMIT 1`, [drive.id]),
        ]);
        if (first?.v != null && last?.v != null) soc = { start: first.v, end: last.v };
      } catch { /* positions 缺列时忽略 */ }

      // 急刹次数 + 行程内胎压变化（v2.6，车主核心关注）：positions 逐点速度差分 +
      // 首/末 TPMS 读数。急刹 = 降速 ≥8 km/h/s（≈2.2 m/s²），同一次刹车多采样去重：
      // 触发后须待减速 <3 km/h/s 才重新武装。速度数据缺失 → null。
      let hardBraking = null;
      let tirePressureChange = null;
      try {
        const rows = await db.query(`
          SELECT p.date, p.speed::float8 AS speed,
                 p.tpms_pressure_fl::float8 AS fl, p.tpms_pressure_fr::float8 AS fr,
                 p.tpms_pressure_rl::float8 AS rl, p.tpms_pressure_rr::float8 AS rr
          FROM positions p WHERE p.drive_id = $1
          ORDER BY p.date ASC, p.id ASC
        `, [drive.id]);
        const msOf = (v) => (v instanceof Date ? v.getTime() : new Date(/[Z+]/.test(String(v)) ? v : `${v}Z`).getTime());
        let armed = true;
        for (let i = 1; i < rows.length; i++) {
          const v1 = finiteNumber(rows[i - 1]?.speed);
          const v2 = finiteNumber(rows[i]?.speed);
          if (v1 == null || v2 == null) continue;
          const dt = (msOf(rows[i].date) - msOf(rows[i - 1].date)) / 1000;
          if (dt <= 0 || dt > 5) continue;
          const decel = (v1 - v2) / dt;
          if (decel >= 8) {
            if (armed) { hardBraking = (hardBraking ?? 0) + 1; armed = false; }
          } else if (decel < 3) {
            armed = true;
          }
        }
        const tpmsAvg = (r) => {
          const vals = [r?.fl, r?.fr, r?.rl, r?.rr].map(finiteNumber).filter((v) => v != null);
          return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        };
        let firstTp = null, lastTp = null;
        for (const r of rows) { if (tpmsAvg(r) != null) { firstTp ??= r; lastTp = r; } }
        if (firstTp && lastTp && rows.length) {
          const startAvg = tpmsAvg(firstTp), endAvg = tpmsAvg(lastTp);
          tirePressureChange = {
            start: { fl: finiteNumber(firstTp.fl), fr: finiteNumber(firstTp.fr), rl: finiteNumber(firstTp.rl), rr: finiteNumber(firstTp.rr) },
            end: { fl: finiteNumber(lastTp.fl), fr: finiteNumber(lastTp.fr), rl: finiteNumber(lastTp.rl), rr: finiteNumber(lastTp.rr) },
            deltaBar: startAvg != null && endAvg != null ? round(endAvg - startAvg, 2) : null,
          };
        }
      } catch { /* positions 缺列时忽略 */ }

      return {
        ...view,
        soc,
        hardBraking,
        tirePressureChange,
        route: polyline.map((p) => ({ t: p.t, lat: p.lat, lng: p.lng, speed: p.speed ?? null, elevation: p.elevation ?? null })),
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
        environment: { avgTempC, acEstimateKwh, avgSpeedKmh: avgSpeed, maxSpeedKmh: maxSpeed },
        // 胎压（bar，四轮）：行程内最后有效读数（与推送行程小结同口径）；无数据 null
        tirePressure: finiteNumber(drive.tp_fl) != null ? {
          fl: finiteNumber(drive.tp_fl), fr: finiteNumber(drive.tp_fr),
          rl: finiteNumber(drive.tp_rl), rr: finiteNumber(drive.tp_rr)
        } : null
      };
    }
  };
}
