// teslamate-queries.mjs — every SQL against the TeslaMate DB lives here. READ ONLY.
// Timestamps in TeslaMate are naive UTC; we pass ISO instants as timestamptz
// literals and compare via `AT TIME ZONE 'UTC'` to stay correct regardless of
// the server's session timezone.
import { utcNaiveSqlExpr } from "./util.mjs";

function expr(value, errorMessage) {
  return utcNaiveSqlExpr(value, errorMessage);
}

// ---- car / dashboard ----------------------------------------------------

export async function getCarSnapshot(db) {
  return db.queryOne(`
    SELECT c.id,
           c.name,
           pos.battery_level AS current_battery,
           pos.ideal_battery_range_km AS range_km,
           pos.odometer AS odometer_km,
           pos.date AS position_at,
           (SELECT max(d.end_date) FROM drives d WHERE d.car_id = c.id AND d.end_date IS NOT NULL) AS last_drive_at
    FROM cars c
    LEFT JOIN LATERAL (
      SELECT p.battery_level, p.ideal_battery_range_km, p.odometer, p.date
      FROM positions p
      WHERE p.car_id = c.id
      ORDER BY p.date DESC, p.id DESC
      LIMIT 1
    ) pos ON true
    ORDER BY c.display_priority ASC NULLS LAST, c.id ASC
    LIMIT 1
  `);
}

// Vehicle state: charging > driving > online/asleep.
// Charging = unfinished charging_process whose latest charge row is recent (zombie
// sessions with stale data are excluded by the 30-minute recency window).
export async function getDrivingState(db) {
  return db.queryOne(`
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
      WHERE s.car_id = 1 AND s.end_date IS NULL
      ORDER BY s.start_date DESC LIMIT 1
    ) s ON true
  `);
}

export async function getSystemStats(db) {
  return db.queryOne(`
    SELECT (SELECT count(*) FROM drives WHERE end_date IS NOT NULL)::int AS drive_count,
           (SELECT max(end_date) FROM drives WHERE end_date IS NOT NULL) AS last_drive_at
  `);
}

export async function getMonthStats(db, since) {
  return db.queryOne(`
    SELECT COALESCE(sum(d.distance), 0) AS distance_km,
           count(*)::int AS drive_count,
           COALESCE(sum(d.duration_min), 0)::int AS drive_minutes
    FROM drives d
    WHERE d.end_date IS NOT NULL
      AND d.end_date >= ${expr(since, "invalid month start")}
  `);
}

export async function getWeekStats(db, since) {
  return db.queryOne(`
    SELECT COALESCE(sum(d.distance), 0) AS distance_km
    FROM drives d
    WHERE d.end_date IS NOT NULL
      AND d.end_date >= ${expr(since, "invalid week start")}
  `);
}

// ---- drives / trips ------------------------------------------------------

// Base drive rows with energy estimate (power integration with efficiency fallback).
// $1..$n params: [sinceIso?], limit, offset
export function listDrivesSql({ from, to } = {}) {
  const where = ["d.end_date IS NOT NULL"];
  if (from !== undefined && from !== null) {
    where.push(`d.end_date >= (${expr(from, "invalid from")} )`);
  }
  if (to !== undefined && to !== null) {
    where.push(`d.end_date <= (${expr(to, "invalid to")} )`);
  }
  return {
    sql: `
      WITH matched AS (
        SELECT d.id, d.end_date
        FROM drives d
        WHERE ${where.join(" AND ")}
        ORDER BY d.end_date DESC
        LIMIT $1 OFFSET $2
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
             (SELECT p.odometer FROM positions p WHERE p.drive_id = d.id ORDER BY p.date DESC, p.id DESC LIMIT 1) AS end_odometer,
             (SELECT count(*)::int FROM positions p WHERE p.drive_id = d.id) AS position_count
      FROM matched m
      JOIN drives d ON d.id = m.id
      JOIN cars c ON c.id = d.car_id
      ORDER BY d.end_date DESC
    `,
    params: []
  };
}

export const countDrivesSql = `
  SELECT count(*)::int AS total
  FROM drives d
  WHERE d.end_date IS NOT NULL
`;

export async function getDriveByIdSql(id) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) throw new Error("invalid drive id");
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
  `, [numId]);
  return rows[0] ?? null;
}

export async function getRoutePoints(db, driveId, maxPoints = 500) {
  const rows = await db.query(`
    SELECT p.date, p.latitude::float8 AS lat, p.longitude::float8 AS lng, p.odometer
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
           g.billing_type::text AS billing_type
    FROM geofences g
    ORDER BY g.name ASC
  `);
}

// ---- charging ------------------------------------------------------------

export async function listCharging(db, { limit = 50, offset = 0 } = {}) {
  return db.query(`
    SELECT cp.id,
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
    WHERE cp.end_date IS NOT NULL
    ORDER BY cp.end_date DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
}

export async function countCharging(db) {
  const row = await db.queryOne(`
    SELECT count(*)::int AS total FROM charging_processes WHERE end_date IS NOT NULL
  `);
  return row ? row.total : 0;
}

export async function listChargingForStats(db, { sinceIso = null } = {}) {
  return db.query(`
    SELECT cp.id, cp.end_date, cp.charge_energy_added, cp.cost, cp.duration_min,
           cp.geofence_id, cp.address_id,
           g.name AS geofence_name, g.cost_per_unit AS geofence_cost_per_unit, g.session_fee AS geofence_session_fee,
           a.display_name AS address_name
    FROM charging_processes cp
    LEFT JOIN geofences g ON g.id = cp.geofence_id
    LEFT JOIN addresses a ON a.id = cp.address_id
    WHERE cp.end_date IS NOT NULL ${sinceIso ? `AND cp.end_date >= (${expr(sinceIso, "invalid stats since")})` : ""}
    ORDER BY cp.end_date ASC
  `);
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
