// trips routes — list/detail with batch-ledger cost allocation.
import { HttpError } from "./http-kit.mjs";
import { finiteNumber, round, isoFromTeslaMate } from "../core/util.mjs";
import { driveEnergyKwh, batchesFromChargingSessions, allocateDriveCosts } from "../core/pricing-ledger.mjs";
import { listDrivesSql, getRoutePoints, getAddresses, getGeofences, listChargingForStats } from "../core/teslamate-queries.mjs";

function addressLabel(address) {
  if (!address) return null;
  return address.display_name
    || [address.name, address.road, address.city].filter(Boolean).join(" ")
    || null;
}

function routeKey(drive, addressMap, geofenceMap) {
  const start = drive.start_address_id ? addressMap[drive.start_address_id] : null;
  const end = drive.end_address_id ? addressMap[drive.end_address_id] : null;
  const a = addressLabel(start) || geofenceMap[drive.start_geofence_id] || "未知";
  const b = addressLabel(end) || geofenceMap[drive.end_geofence_id] || "未知";
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

// Shared: build batches from priced charging history + allocate drive costs.
export async function computeTripViews(db, drives, { defaultRate, history, chargingSessions = null }) {
  const addressIds = drives.flatMap((drive) => [drive.start_address_id, drive.end_address_id]);
  const addressMap = await getAddresses(db, addressIds);
  // Fallback labels: reverse-geocoded addresses may be absent (privacy-off setups),
  // while TeslaMate geofence names (e.g. "CND", "HOME") are always set for known spots.
  const geofenceRows = await getGeofences(db);
  const geofenceMap = Object.fromEntries(geofenceRows.map((row) => [row.id, row.name]));
  const charging = chargingSessions ?? await listChargingForStats(db, {});
  const batches = batchesFromChargingSessions(charging);
  const allocationInput = drives.map((drive) => ({
    id: drive.id,
    start_at: drive.start_at,
    estimated_kwh: driveEnergyKwh(drive)
  }));
  const { allocations } = allocateDriveCosts({
    drives: allocationInput,
    batches,
    defaultRate,
    defaultRateHistory: history
  });
  const costById = new Map(allocations.map((allocation) => [String(allocation.drive_id), allocation]));
  return drives.map((drive) => {
    const allocation = costById.get(String(drive.id));
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
      startAddress: addressLabel(addressMap[drive.start_address_id] || null) || geofenceMap[drive.start_geofence_id] || null,
      endAddress: addressLabel(addressMap[drive.end_address_id] || null) || geofenceMap[drive.end_geofence_id] || null,
      kwhPer100km: energy !== null && distance > 0 ? round(energy / distance * 100, 2) : null,
      routeKey: routeKey(drive, addressMap, geofenceMap)
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
           greatest(d.start_rated_range_km - d.end_rated_range_km, 0) AS rated_used_km
    FROM drives d
    JOIN cars c ON c.id = d.car_id
    WHERE d.id = $1 AND d.end_date IS NOT NULL
  `, [numId]);
  return rows[0] ?? null;
}

export function createTripsRoutes({ db, state }) {
  return {
    async list(ctx) {
      const { limit, offset } = clampPaging(ctx.query);
      const from = validateIso(ctx.query.from, "from");
      const to = validateIso(ctx.query.to, "to");
      const { sql, params } = listDrivesSql({ from, to });
      const rows = await db.query(sql, [...params, limit, offset]);
      const totalRow = await db.queryOne(`
        SELECT count(*)::int AS total
        FROM drives d
        WHERE d.end_date IS NOT NULL
        ${from ? `AND d.end_date >= ('${from}'::timestamptz AT TIME ZONE 'UTC')` : ""}
        ${to ? `AND d.end_date <= ('${to}'::timestamptz AT TIME ZONE 'UTC')` : ""}
      `);
      const items = await computeTripViews(db, rows, {
        defaultRate: state.pricing.defaultRateCnyPerKwh,
        history: state.pricing.history
      });
      return { total: totalRow ? totalRow.total : rows.length, items };
    },

    async detail(ctx) {
      const drive = await getDrive(db, ctx.params.id);
      if (!drive) throw new HttpError(404, "not_found", "trip not found");
      const [view] = await computeTripViews(db, [drive], {
        defaultRate: state.pricing.defaultRateCnyPerKwh,
        history: state.pricing.history
      });
      const points = await getRoutePoints(db, drive.id, 500);
      return {
        ...view,
        route: points.map((point) => ({
          t: isoFromTeslaMate(point.date),
          lat: point.lat,
          lng: point.lng
        }))
      };
    }
  };
}
