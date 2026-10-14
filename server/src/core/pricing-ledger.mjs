// pricing-ledger.mjs — cost model per API_CONTRACT §4.
//
// Charging session cost:
//   1. charging_processes.cost non-null -> use as-is (TeslaMate already priced it
//      from the geofence unit price).
//   2. cost null but geofence has cost_per_unit -> energy × price + session_fee.
//   3. neither -> fall back to the local default rate (pricing.defaultRate).
//
// Trip (drive) cost: drives consume "purchased electricity price batches" in
// chronological order; when batches are exhausted the remainder is priced at the
// default rate. Batches are auto-imported from TeslaMate charging records.
//
// Algorithm semantics inherited from tesla-butler electricity-accounting.mjs
// (github.com/manwithshit/tesla-butler): FIFO batch queue, per-drive slices
// (batch / default / unpriced), reliability marking when input is incomplete.
import { finiteNumber, round, timeMs } from "./util.mjs";

// ---- charging session pricing -------------------------------------------

export function priceChargingSession(session, defaultRate) {
  // session: {charge_energy_added, cost, geofence_cost_per_unit, geofence_session_fee, ...}
  const energy = finiteNumber(session.charge_energy_added);
  const statedCost = finiteNumber(session.cost);
  if (statedCost !== null && statedCost > 0) {
    return {
      costCny: round(statedCost, 2),
      pricePerUnit: energy && energy > 0 ? round(statedCost / energy, 4) : null,
      source: "stated"
    };
  }
  const geofencePrice = finiteNumber(session.geofence_cost_per_unit);
  if (geofencePrice !== null && geofencePrice > 0 && energy !== null && energy > 0) {
    const fee = finiteNumber(session.geofence_session_fee) ?? 0;
    const cost = energy * geofencePrice + fee;
    return {
      costCny: round(cost, 2),
      pricePerUnit: round(geofencePrice, 4),
      source: "geofence"
    };
  }
  const fallback = finiteNumber(defaultRate);
  if (fallback !== null && fallback > 0 && energy !== null && energy > 0) {
    return {
      costCny: round(energy * fallback, 2),
      pricePerUnit: round(fallback, 4),
      source: "default"
    };
  }
  return { costCny: null, pricePerUnit: null, source: "unknown" };
}

// ---- batches from charging sessions ---------------------------------------

// Convert priced charging sessions into electricity batches available for
// later drives. availableAt = charging end (or start when still ongoing).
export function batchesFromChargingSessions(sessions) {
  const out = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const energy = finiteNumber(session.charge_energy_added);
    const priced = priceChargingSession(session, session.__defaultRate ?? null);
    if (energy === null || energy <= 0) continue;
    if (priced.costCny === null || priced.pricePerUnit === null) continue;
    const availableMs = timeMs(session.end_at ?? session.end_date) ?? timeMs(session.start_at ?? session.start_date);
    if (availableMs === null) continue;
    out.push({
      batch_id: `cp-${session.id}`,
      charging_process_id: Number(session.id),
      available_at_ms: availableMs,
      energy_kwh: round(energy),
      unit_price_cny_per_kwh: round(priced.pricePerUnit, 6),
      amount_cny: priced.costCny,
      source: priced.source
    });
  }
  out.sort((a, b) => a.available_at_ms - b.available_at_ms || a.batch_id.localeCompare(b.batch_id));
  return out;
}

// ---- drive energy + batch allocation --------------------------------------

// Default-rate history: [{changedAt, from, to}] -> effective rate at time t.
function defaultRateAt(defaultRate, history, atMs) {
  const current = finiteNumber(defaultRate);
  let result = null;
  for (const entry of Array.isArray(history) ? history : []) {
    const changedMs = timeMs(entry.changedAt);
    if (changedMs === null) continue;
    if (changedMs > atMs) break;
    const to = finiteNumber(entry.to);
    if (to !== null) result = to;
  }
  if (result === null) result = current;
  return result;
}

export function driveEnergyKwh(drive) {
  // TeslaMate cars.efficiency for Model 3 is ~0.1274 kWh/km (not Wh/km).
  // Normalize: values > 1 are Wh/km (legacy), values < 1 are kWh/km.
  const raw = finiteNumber(drive.efficiency);
  const efficiencyKwhPerKm = raw === null ? null : raw > 1 ? raw / 1000 : raw;
  const ideal = finiteNumber(drive.ideal_used_km);
  const rated = finiteNumber(drive.rated_used_km);
  if (efficiencyKwhPerKm && ideal !== null) return round(ideal * efficiencyKwhPerKm);
  if (efficiencyKwhPerKm && rated !== null) return round(rated * efficiencyKwhPerKm);
  return null;
}

// The core allocation, mirroring tesla-butler's allocateDriveEnergy semantics:
// FIFO batches → default rate → unpriced; slices record every contribution.
export function allocateDriveCosts({ drives, batches, defaultRate, defaultRateHistory = [] } = {}) {
  const queue = (Array.isArray(batches) ? batches : []).map((batch) => ({
    ...batch,
    available_at_ms: finiteNumber(batch.available_at_ms) ?? timeMs(batch.available_at),
    remaining_kwh: Math.max(0, finiteNumber(batch.energy_kwh) ?? 0),
    unit_price_cny_per_kwh: finiteNumber(batch.price_cny_per_kwh ?? batch.unit_price_cny_per_kwh)
  })).filter((batch) =>
    batch.available_at_ms !== null
    && batch.unit_price_cny_per_kwh !== null
    && batch.unit_price_cny_per_kwh >= 0
  ).sort((a, b) =>
    a.available_at_ms - b.available_at_ms
    || String(a.batch_id).localeCompare(String(b.batch_id))
  );

  const orderedDrives = (Array.isArray(drives) ? drives : [])
    .map((drive, index) => ({ ...drive, index, drive_at_ms: timeMs(drive.start_at ?? drive.start_date) }))
    .sort((a, b) =>
      (a.drive_at_ms ?? Number.POSITIVE_INFINITY) - (b.drive_at_ms ?? Number.POSITIVE_INFINITY)
      || a.index - b.index
    );

  const allocations = [];
  for (const drive of orderedDrives) {
    const energy = finiteNumber(drive.estimated_kwh ?? drive.energy_kwh);
    if (drive.drive_at_ms === null || energy === null || energy < 0) {
      allocations.push({
        drive_id: drive.id,
        energy_kwh: null,
        batch_kwh: 0,
        default_kwh: 0,
        unpriced_kwh: 0,
        cost_cny: null,
        allocation_reliable: false,
        cost_complete: false,
        slices: []
      });
      continue;
    }
    let remaining = energy;
    let batchKwh = 0;
    let defaultKwh = 0;
    let unpricedKwh = 0;
    let cost = 0;
    const slices = [];
    for (const batch of queue) {
      if (remaining <= 0) break;
      if (batch.available_at_ms > drive.drive_at_ms || batch.remaining_kwh <= 0) continue;
      const consumed = Math.min(remaining, batch.remaining_kwh);
      batch.remaining_kwh = round(batch.remaining_kwh - consumed);
      remaining = round(remaining - consumed);
      batchKwh += consumed;
      cost += consumed * batch.unit_price_cny_per_kwh;
      slices.push({
        source: "batch",
        batch_id: batch.batch_id,
        energy_kwh: round(consumed),
        unit_price_cny_per_kwh: batch.unit_price_cny_per_kwh,
        cost_cny: round(consumed * batch.unit_price_cny_per_kwh, 2)
      });
    }
    if (remaining > 0) {
      const rate = defaultRateAt(defaultRate, defaultRateHistory, drive.drive_at_ms);
      if (rate === null || rate < 0) {
        unpricedKwh = remaining;
        slices.push({ source: "unpriced", energy_kwh: round(remaining), unit_price_cny_per_kwh: null, cost_cny: null });
      } else {
        defaultKwh = remaining;
        cost += remaining * rate;
        slices.push({
          source: "default",
          energy_kwh: round(remaining),
          unit_price_cny_per_kwh: rate,
          cost_cny: round(remaining * rate, 2)
        });
      }
    }
    allocations.push({
      drive_id: drive.id,
      energy_kwh: round(energy),
      batch_kwh: round(batchKwh),
      default_kwh: round(defaultKwh),
      unpriced_kwh: round(unpricedKwh),
      cost_cny: unpricedKwh > 0 ? null : round(cost, 2),
      cost_cny_precise: unpricedKwh > 0 ? null : round(cost, 10),
      allocation_reliable: true,
      cost_complete: unpricedKwh === 0,
      slices
    });
  }

  return {
    allocations,
    remaining_batches: queue.map((batch) => ({
      batch_id: batch.batch_id,
      remaining_kwh: round(batch.remaining_kwh)
    }))
  };
}
