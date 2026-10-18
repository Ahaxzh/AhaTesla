// teslamate-queries.mjs — every SQL against the TeslaMate DB lives here. READ ONLY.
// Timestamps in TeslaMate are naive UTC; we pass ISO instants as timestamptz
// literals and compare via `AT TIME ZONE 'UTC'` to stay correct regardless of
// the server's session timezone.
import { utcNaiveSqlExpr } from "./util.mjs";

function expr(value, errorMessage) {
  return utcNaiveSqlExpr(value, errorMessage);
}

// ---- car / dashboard ----------------------------------------------------

// 主绑定 car_id（AC-2.3 多车隔离）：优先向导绑定（state.datasource.carId），
// 回退 display_priority 排序的第一辆。所有核心查询经由此参数化过滤，
// 修复原 s.car_id = 1 / LIMIT 1 硬编码（GA-05 / B1 / G8）。
export function resolveCarId(state, fallbackCarId = null) {
  const bound = Number(state?.datasource?.carId);
  if (Number.isInteger(bound) && bound > 0) return bound;
  return fallbackCarId;
}

/** m4e 车辆清单（车切换器/主车选择）。demo 模式由 demo-db 指纹返回双车。 */
export async function getCars(db) {
  return db.query(`
    SELECT c.id, c.name
    FROM cars c
    ORDER BY c.display_priority ASC NULLS LAST, c.id ASC
  `);
}

export async function getCarSnapshot(db, { carId = null } = {}) {
  const filter = carId ? "WHERE c.id = $1" : "";
  const params = carId ? [carId] : [];
  return db.queryOne(`
    SELECT c.id,
           c.name,
           pos.battery_level AS current_battery,
           pos.ideal_battery_range_km AS range_km,
           pos.odometer AS odometer_km,
           pos.date AS position_at,
           (SELECT max(d.end_date) FROM drives d WHERE d.car_id = c.id AND d.end_date IS NOT NULL) AS last_drive_at
    FROM cars c
    ${filter}
    LEFT JOIN LATERAL (
      SELECT p.battery_level, p.ideal_battery_range_km, p.odometer, p.date
      FROM positions p
      WHERE p.car_id = c.id
      ORDER BY p.id DESC
      LIMIT 1
    ) pos ON true
    ORDER BY c.display_priority ASC NULLS LAST, c.id ASC
    LIMIT 1
  `, params);
}

// states 表只记在线性状态（online/offline/asleep），无 driving/charging 行。
// 产品语义值域（PRD §6.2 P2 状态胶囊）：charging / driving / online / offline /
// asleep / asleep_or_parked。charging/driving 由回退链推导；本映射把 states
// 原始值归一到该值域，未知原始值与 NULL 统一归一为 asleep_or_parked。
export function mapVehicleState(raw) {
  const value = raw === null || raw === undefined ? "" : String(raw).trim().toLowerCase();
  if (value === "online" || value === "offline" || value === "asleep") return value;
  return "asleep_or_parked";
}

// Vehicle state: charging > driving > states(在线性，经 mapVehicleState 归一)。
// Charging = unfinished charging_process whose latest charge row is recent (zombie
// sessions with stale data are excluded by the 30-minute recency window).
export async function getDrivingState(db, { carId = null } = {}) {
  const row = await db.queryOne(`
    SELECT CASE
      WHEN ch.id IS NOT NULL THEN 'charging'
      WHEN a.id IS NOT NULL THEN 'driving'
      ELSE COALESCE(s.state::text, 'asleep_or_parked')
    END AS state,
    ch.id AS charging_process_id,
    chg.battery_level AS charging_battery,
    chg.charger_power AS charging_power
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT d.id
      FROM drives d
      WHERE d.end_date IS NULL
        AND ($1::int IS NULL OR d.car_id = $1::int)
        AND EXISTS (
          SELECT 1 FROM positions p
          WHERE p.drive_id = d.id
            AND p.date >= (now() AT TIME ZONE 'UTC') - interval '15 minutes'
        )
      LIMIT 1
    ) a ON true
    LEFT JOIN LATERAL (
      SELECT cp.id
      FROM charging_processes cp
      WHERE cp.end_date IS NULL
        AND ($1::int IS NULL OR cp.car_id = $1::int)
        AND EXISTS (
          SELECT 1 FROM charges c
          WHERE c.charging_process_id = cp.id
            AND c.date >= (now() AT TIME ZONE 'UTC') - interval '30 minutes'
        )
        AND NOT EXISTS (   -- 充电期间不会有未完成行程
          SELECT 1 FROM drives d
          WHERE d.end_date IS NULL
            AND d.start_date > cp.start_date
        )
      ORDER BY cp.start_date DESC
      LIMIT 1
    ) ch ON true
    LEFT JOIN LATERAL (
      SELECT c.battery_level, c.charger_power
      FROM charges c
      WHERE c.charging_process_id = ch.id
      ORDER BY c.date DESC LIMIT 1
    ) chg ON true
    LEFT JOIN LATERAL (
      SELECT s.state FROM states s
      WHERE s.car_id = $1::int AND s.end_date IS NULL
      ORDER BY s.start_date DESC LIMIT 1
    ) s ON true
  `, [carId]);
  if (!row) return { state: "asleep_or_parked" };
  return { ...row, state: row.state === "charging" || row.state === "driving" ? row.state : mapVehicleState(row.state) };
}

export async function getSystemStats(db, carId = null) {
  return db.queryOne(`
    SELECT (SELECT count(*) FROM drives d WHERE d.end_date IS NOT NULL
              AND ($1::int IS NULL OR d.car_id = $1::int))::int AS drive_count,
           (SELECT max(d.end_date) FROM drives d WHERE d.end_date IS NOT NULL
              AND ($1::int IS NULL OR d.car_id = $1::int)) AS last_drive_at
  `, [Number.isInteger(Number(carId)) && Number(carId) > 0 ? Number(carId) : null]);
}

export async function getMonthStats(db, since, carId = null) {
  return db.queryOne(`
    SELECT COALESCE(sum(d.distance), 0) AS distance_km,
           count(*)::int AS drive_count,
           COALESCE(sum(d.duration_min), 0)::int AS drive_minutes
    FROM drives d
    WHERE d.end_date IS NOT NULL
      AND d.end_date >= ${expr(since, "invalid month start")}
      AND ($1::int IS NULL OR d.car_id = $1::int)
  `, [Number.isInteger(Number(carId)) && Number(carId) > 0 ? Number(carId) : null]);
}

/** 自然月起点（北京时间月初 00:00），Dashboard「本月」统计口径 */
export function monthStartIso(now = new Date(), tz = "Asia/Shanghai") {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(now);
    // en-CA → YYYY-MM-DD；截年月拼 01 号，北京时间月初 00:00
    return new Date(`${parts.slice(0, 7)}-01T00:00:00+08:00`).toISOString();
  } catch {
    const d = new Date(now);
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }
}

export async function getWeekStats(db, since, carId = null) {
  return db.queryOne(`
    SELECT COALESCE(sum(d.distance), 0) AS distance_km
    FROM drives d
    WHERE d.end_date IS NOT NULL
      AND d.end_date >= ${expr(since, "invalid week start")}
      AND ($1::int IS NULL OR d.car_id = $1::int)
  `, [Number.isInteger(Number(carId)) && Number(carId) > 0 ? Number(carId) : null]);
}

// ---- drives / trips ------------------------------------------------------

// Base drive rows with energy estimate (power integration with efficiency fallback).
// $1..$n params: [carId?], limit, offset（carId 为 null 时不过滤，单车用户零变化）
export function listDrivesSql({ from, to, carId } = {}) {
  const where = ["d.end_date IS NOT NULL"];
  if (from !== undefined && from !== null) {
    where.push(`d.end_date >= (${expr(from, "invalid from")} )`);
  }
  if (to !== undefined && to !== null) {
    where.push(`d.end_date <= (${expr(to, "invalid to")} )`);
  }
  where.push(`($1::int IS NULL OR d.car_id = $1::int)`);
  return {
    sql: `
      WITH matched AS (
        SELECT d.id, d.end_date
        FROM drives d
        WHERE ${where.join(" AND ")}
        ORDER BY d.end_date DESC
        LIMIT $2 OFFSET $3
      )
      SELECT d.id, d.car_id,
             d.start_date AS start_at, d.end_date AS end_at,
             round(d.distance::numeric, 2) AS distance_km,
             d.duration_min,
             d.start_address_id, d.end_address_id,
             d.start_geofence_id, d.end_geofence_id,
             c.efficiency,
             greatest(d.start_ideal_range_km - d.end_ideal_range_km, 0) AS ideal_used_km,
             greatest(d.start_rated_range_km - d.end_rated_range_km, 0) AS rated_used_km,
             ep.start_lat, ep.start_lng, ep2.end_lat, ep2.end_lng, ep2.end_odometer, ep2.position_count
      FROM matched m
      JOIN drives d ON d.id = m.id
      JOIN cars c ON c.id = d.car_id
      LEFT JOIN LATERAL (
        SELECT p.latitude::float8 AS start_lat, p.longitude::float8 AS start_lng
        FROM positions p WHERE p.drive_id = d.id ORDER BY p.date ASC, p.id ASC LIMIT 1
      ) ep ON true
      LEFT JOIN LATERAL (
        SELECT p.latitude::float8 AS end_lat, p.longitude::float8 AS end_lng,
               p.odometer AS end_odometer,
               (SELECT count(*)::int FROM positions p2 WHERE p2.drive_id = d.id) AS position_count
        FROM positions p WHERE p.drive_id = d.id ORDER BY p.date DESC, p.id DESC LIMIT 1
      ) ep2 ON true
      ORDER BY d.end_date DESC
    `,
    params: [Number.isInteger(Number(carId)) && Number(carId) > 0 ? Number(carId) : null]
  };
}

export const countDrivesSql = `
  SELECT count(*)::int AS total
  FROM drives d
  WHERE d.end_date IS NOT NULL
`;

export async function getDriveByIdSql(db, id, carId = null) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) throw new Error("invalid drive id");
  const car = Number.isInteger(Number(carId)) && Number(carId) > 0 ? Number(carId) : null;
  const rows = await db.query(`
    SELECT d.id, d.car_id,
           d.start_date AS start_at, d.end_date AS end_at,
           round(d.distance::numeric, 2) AS distance_km,
           d.duration_min,
           d.start_address_id, d.end_address_id,
           d.start_geofence_id, d.end_geofence_id,
           c.efficiency,
           greatest(d.start_ideal_range_km - d.end_ideal_range_km, 0) AS ideal_used_km,
           greatest(d.start_rated_range_km - d.end_rated_range_km, 0) AS rated_used_km
    FROM drives d
    JOIN cars c ON c.id = d.car_id
    WHERE d.id = $1 AND d.end_date IS NOT NULL
      AND ($2::int IS NULL OR d.car_id = $2::int)
  `, [numId, car]);
  return rows[0] ?? null;
}

export async function getRoutePoints(db, driveId, maxPoints = 500) {
  const rows = await db.query(`
    SELECT p.date, p.latitude::float8 AS lat, p.longitude::float8 AS lng, p.odometer, p.speed::float8 AS speed
    FROM positions p
    WHERE p.drive_id = $1
    ORDER BY p.date ASC, p.id ASC
  `, [Number(driveId)]);
  return downsamplePoints(rows, maxPoints);
}

export function downsamplePoints(rows, maxPoints) {
  if (!Array.isArray(rows) || rows.length <= maxPoints) return rows || [];
  const step = (rows.length - 1) / (maxPoints - 1);
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(rows[Math.round(i * step)]);
  return out;
}

export async function getAddresses(db, ids) {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(Number(id)) && Number(id) > 0).map(Number))];
  if (unique.length === 0) return {};
  const rows = await db.query(`
    SELECT a.id, a.display_name, NULLIF(a.name, '') AS name, NULLIF(a.road, '') AS road,
           NULLIF(a.city, '') AS city, NULLIF(a.neighbourhood, '') AS neighbourhood
    FROM addresses a
    WHERE a.id = ANY($1::int[])
  `, [unique]);
  const map = {};
  for (const row of rows) map[row.id] = row;
  return map;
}

export async function getGeofences(db) {
  return db.query(`
    SELECT g.id, g.name,
           g.cost_per_unit AS price_per_unit,
           g.session_fee,
           g.billing_type::text AS billing_type,
           g.latitude::float8 AS lat, g.longitude::float8 AS lng,
           g.radius::float8 AS radius
    FROM geofences g
    ORDER BY g.name ASC
  `);
}

// ---- charging ------------------------------------------------------------

export async function listCharging(db, { limit = 50, offset = 0, month = null, carId = null } = {}) {
  // month "YYYY-MM" → 该自然月内开始/结束的会话（UTC 口径，与列表页一致）
  const monthFilter = month
    ? `AND cp.start_date >= (('${month}-01'::date)::timestamptz AT TIME ZONE 'UTC') AND cp.start_date < (('${month}-01'::date + interval '1 month')::timestamptz AT TIME ZONE 'UTC')`
    : "";
  const car = Number.isInteger(Number(carId)) && Number(carId) > 0 ? Number(carId) : null;
  return db.query(`
    SELECT cp.id, cp.car_id,
           cp.start_date AS start_at, cp.end_date AS end_at,
           cp.charge_energy_added, cp.cost, cp.duration_min,
           cp.start_battery_level, cp.end_battery_level,
           cp.geofence_id, cp.address_id,
           g.name AS geofence_name, g.cost_per_unit AS geofence_cost_per_unit, g.session_fee AS geofence_session_fee,
           a.display_name AS address_name,
           (SELECT max(c.charger_power) FROM charges c WHERE c.charging_process_id = cp.id) AS power_max_kw,
           (SELECT count(*)::int FROM charges c WHERE c.charging_process_id = cp.id) AS charge_sample_count
    FROM charging_processes cp
    LEFT JOIN geofences g ON g.id = cp.geofence_id
    LEFT JOIN addresses a ON a.id = cp.address_id
    WHERE cp.end_date IS NOT NULL ${monthFilter}
      AND ($3::int IS NULL OR cp.car_id = $3::int)
    ORDER BY cp.end_date DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset, car]);
}

export async function countCharging(db, { month = null, carId = null } = {}) {
  const monthFilter = month
    ? `AND cp.start_date >= (('${month}-01'::date)::timestamptz AT TIME ZONE 'UTC') AND cp.start_date < (('${month}-01'::date + interval '1 month')::timestamptz AT TIME ZONE 'UTC')`
    : "";
  const car = Number.isInteger(Number(carId)) && Number(carId) > 0 ? Number(carId) : null;
  const row = await db.queryOne(`
    SELECT count(*)::int AS total FROM charging_processes cp WHERE cp.end_date IS NOT NULL ${monthFilter}
      AND ($1::int IS NULL OR cp.car_id = $1::int)
  `, [car]);
  return row ? row.total : 0;
}

// 单条充电会话（含 charge_energy_used 桩端注入，P4 效率模块）。
export async function getChargingProcessById(db, id, carId = null) {
  const car = Number.isInteger(Number(carId)) && Number(carId) > 0 ? Number(carId) : null;
  return db.queryOne(`
    SELECT cp.id, cp.car_id,
           cp.start_date AS start_at, cp.end_date AS end_at,
           cp.charge_energy_added, cp.charge_energy_used, cp.cost, cp.duration_min,
           cp.start_battery_level, cp.end_battery_level,
           cp.geofence_id, cp.address_id,
           g.name AS geofence_name, g.cost_per_unit AS geofence_cost_per_unit, g.session_fee AS geofence_session_fee,
           a.display_name AS address_name,
           (SELECT max(c.charger_power) FROM charges c WHERE c.charging_process_id = cp.id) AS power_max_kw
    FROM charging_processes cp
    LEFT JOIN geofences g ON g.id = cp.geofence_id
    LEFT JOIN addresses a ON a.id = cp.address_id
    WHERE cp.id = $1 AND cp.end_date IS NOT NULL
      AND ($2::int IS NULL OR cp.car_id = $2::int)
  `, [Number(id), car]);
}

// 充电功率曲线采样（charges 表，SoC × 功率）。
export async function getChargesCurve(db, chargingProcessId) {
  return db.query(`
    SELECT c.date, c.battery_level, c.charger_power
    FROM charges c
    WHERE c.charging_process_id = $1
    ORDER BY c.date ASC, c.id ASC
  `, [Number(chargingProcessId)]);
}

export async function listChargingForStats(db, { sinceIso = null, untilIso = null, carId = null } = {}) {
  const untilFilter = untilIso ? `AND cp.end_date < (${expr(untilIso, "invalid stats until")})` : "";
  const car = Number.isInteger(Number(carId)) && Number(carId) > 0 ? Number(carId) : null;
  return db.query(`
    SELECT cp.id, cp.car_id, cp.end_date, cp.charge_energy_added, cp.cost, cp.duration_min,
           cp.geofence_id, cp.address_id,
           g.name AS geofence_name, g.cost_per_unit AS geofence_cost_per_unit, g.session_fee AS geofence_session_fee,
           a.display_name AS address_name
    FROM charging_processes cp
    LEFT JOIN geofences g ON g.id = cp.geofence_id
    LEFT JOIN addresses a ON a.id = cp.address_id
    WHERE cp.end_date IS NOT NULL ${sinceIso ? `AND cp.end_date >= (${expr(sinceIso, "invalid stats since")})` : ""} ${untilFilter}
      AND ($1::int IS NULL OR cp.car_id = $1::int)
    ORDER BY cp.end_date ASC
  `, [car]);
}

export async function getLatestChargingProcess(db) {
  return db.queryOne(`
    SELECT cp.id, cp.start_date AS start_at, cp.end_date AS end_at,
           cp.charge_energy_added, cp.cost, cp.geofence_id
    FROM charging_processes cp
    ORDER BY cp.id DESC
    LIMIT 1
  `);
}

// ---- 增量轮询（AC-12.1b 事件捕获基线）--------------------------------------
// 全部为只读 SELECT；以自增 id 为游标（id > $1），探针实测 1-3ms。冷启动时由
// TripMonitor.reconcile 首帧写入水线（max id），水线之前的历史仅静默建档。

export async function getMaxDriveId(db) {
  const row = await db.queryOne(`SELECT COALESCE(max(d.id), 0)::int AS max_id FROM drives d`);
  return Number(row?.max_id) || 0;
}

// 已结算行程增量（end_date 非空 = TeslaMate 完成结算落库，AC-12.3 起算点）。
export async function getDrivesIncremental(db, sinceId, limit = 50) {
  return db.query(`
    SELECT d.id, d.start_date AS start_at, d.end_date AS end_at
    FROM drives d
    WHERE d.id > $1 AND d.end_date IS NOT NULL
    ORDER BY d.id ASC
    LIMIT $2
  `,
    [Number(sinceId) || 0, Math.max(1, Math.min(200, Number(limit) || 50))]
  );
}

export async function getActiveDrive(db) {
  // 僵尸行防御：TeslaMate 流断连会在 drives 留下 end_date 永远为 NULL 的历史行
  // （实测库中 431 条，最老 2022 年）。若按"最新未关闭"直取，僵尸会伪装成
  // "正在开车"，把闲置超时结算永远压住 → 行程小结迟到数小时甚至隔天。
  // 真实行程不会超过数小时，12h 窗口足够宽裕。
  const cutoff = new Date(Date.now() - 12 * 3600_000).toISOString().slice(0, 19);
  const row = await db.queryOne(`
    SELECT d.id, d.start_date AS start_at
    FROM drives d
    WHERE d.end_date IS NULL
      AND d.start_date >= $1::timestamp
    ORDER BY d.start_date DESC
    LIMIT 1
  `, [cutoff]);
  return row ? { id: row.id, start_at: row.start_at } : null;
}

// 充电会话增量（新行，含未结束与已结算；未结束 = 进行中，已结算 = charging_done 候选）。
// 调用侧游标取 max(last_charging_id, last_charging_done_id)。
export async function getChargingIncremental(db, sinceId, limit = 50) {
  return db.query(`
    SELECT cp.id, cp.start_date AS start_at, cp.end_date AS end_at
    FROM charging_processes cp
    WHERE cp.id > $1
    ORDER BY cp.id ASC
    LIMIT $2
  `,
    [Number(sinceId) || 0, Math.max(1, Math.min(200, Number(limit) || 50))]
  );
}

// 已结算充电行增量（end_date 非空 = TeslaMate 完成结算落库，AC-12.3 起算点）。
// 捕捉「先 open 后结算」的行：这类行 id 不变，上面的新行查询扫不到它的关闭，
// 必须以 done 游标单独增量扫描（单车站点会话按 id 顺序结算，游标安全）。
export async function getChargingClosedIncremental(db, sinceId, limit = 50) {
  return db.query(`
    SELECT cp.id, cp.start_date AS start_at, cp.end_date AS end_at
    FROM charging_processes cp
    WHERE cp.id > $1 AND cp.end_date IS NOT NULL
    ORDER BY cp.id ASC
    LIMIT $2
  `,
    [Number(sinceId) || 0, Math.max(1, Math.min(200, Number(limit) || 50))]
  );
}
