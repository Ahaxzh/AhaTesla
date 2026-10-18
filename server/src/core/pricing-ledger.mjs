// pricing-ledger.mjs — AhaTesla electricity cost engine.
//
// This module answers one question for the owner: "what did this trip really
// cost me?" It works in two stages:
//
//   1. Price a single charging session, falling back through the documented
//      ladder until a usable figure is found (AC-7.1, 四层回退).
//   2. Pour the electricity bought at each charge into a first-in-first-out
//      pool, then draw travel energy out of it in chronological order, so each
//      drive is billed at the blended price of the power it actually consumed
//      (AC-7.2). When the pool runs dry the remainder falls back to the user's
//      default tariff, and anything still unpriced is surfaced explicitly.
//
// Sources of truth for the rules implemented here: docs/PRD.md §5.3 (US-6/US-7)
// and docs/API_CONTRACT.md §8. This is AhaTesla's own implementation of those
// rules; no third-party source is used.
//
// Timestamp note: TeslaMate persists naive-UTC instants. `timeMs` treats a
// value without an explicit zone as UTC, matching the SQL side which compares
// through `AT TIME ZONE 'UTC'`, so ordering stays correct across timezones.
import { finiteNumber, round, timeMs } from "./util.mjs";

// ---- geofence 分时电价（TOU，AC-7.1③，契约 §8.1）---------------------------

// TOU window: {offPeakStart:"23:00", offPeakEnd:"07:00", offPeakRate, peakRate}。
// 谷段可跨午夜（23:00→07:00）。按充电起止时间在谷/峰段的占比分摊计价：
// cost = Σ(段内时长 × 该段功率折算)。无功率曲线时假设匀功率，按时长比例分摊。
export function isOffPeak(minutesOfDay, window) {
  if (!window) return false;
  const start = parseHm(window.offPeakStart);
  const end = parseHm(window.offPeakEnd);
  if (start === null || end === null) return false;
  if (start === end) return false; // 空窗口
  if (start < end) return minutesOfDay >= start && minutesOfDay < end;
  // 跨午夜：23:00→07:00 → [23:00,24:00) ∪ [00:00,07:00)
  return minutesOfDay >= start || minutesOfDay < end;
}

function parseHm(hm) {
  if (typeof hm !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// 计算充电会话在 TOU 两档之间的费用（无功率曲线 → 匀功率假设，按时长比例）。
export function touSplitSession({ startMs, endMs, energyKwh, window }) {
  const offPeakRate = finiteNumber(window?.offPeakRate);
  const peakRate = finiteNumber(window?.peakRate);
  if (offPeakRate === null || peakRate === null || offPeakRate < 0 || peakRate < 0) return null;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  if (energyKwh === null || energyKwh <= 0) return null;

  // 逐分钟归类（会话最长按天级，成本可忽略；跨日循环自然处理）
  const totalMin = Math.round((endMs - startMs) / 60_000);
  if (totalMin <= 0) return null;
  let offPeakMin = 0;
  const startDate = new Date(startMs);
  for (let i = 0; i < totalMin; i++) {
    const at = new Date(startDate.getTime() + i * 60_000);
    if (isOffPeak(at.getUTCHours() * 60 + at.getUTCMinutes(), window)) offPeakMin += 1;
  }
  const peakMin = totalMin - offPeakMin;
  const offKwh = round(energyKwh * (offPeakMin / totalMin));
  const peakKwh = round(energyKwh * (peakMin / totalMin));
  const cost = round(offKwh * offPeakRate + peakKwh * peakRate, 2);
  return {
    costCny: cost,
    pricePerUnit: round(cost / energyKwh, 4),
    offPeakKwh: offKwh,
    peakKwh: peakKwh,
    source: "geofence-tou"
  };
}

// ---- charging session pricing (AC-7.1 fallback ladder) --------------------

// Layer ①: AhaTesla 本地手动录入（SQLite charge_cost_overrides，AC-7.1/7.6）。
// 调用方注入 overrides：Map<cpId, cost>。实付金额权威，直接入账。
function priceFromLocalOverride(session, energy, _defaultRate, overrides) {
  if (!overrides) return null;
  const key = Number(session.__overrideKey ?? session.id);
  if (!Number.isFinite(key)) return null;
  const paid = finiteNumber(overrides.get(key));
  if (paid === null || paid <= 0) return null;
  return {
    costCny: round(paid, 2),
    pricePerUnit: energy !== null && energy > 0 ? round(paid / energy, 4) : null,
    source: "manual"
  };
}

// Layer ②: TeslaMate already knows what was paid (`charging_processes.cost`).
function priceFromStatedCost(session, energy) {
  const paid = finiteNumber(session.cost);
  if (paid === null || paid <= 0) return null;
  return {
    costCny: round(paid, 2),
    pricePerUnit: energy !== null && energy > 0 ? round(paid / energy, 4) : null,
    source: "stated"
  };
}

// Layer ③: derive the charge from the geofence tariff plus any session fee.
// The effective unit price stays the geofence rate itself (the flat fee is not
// energy, so it must not be divided back into the price).
// 分时模式（priceMode="tou" + tou 窗口）按充电起止跨时段比例计价（契约 §8.1）。
function priceFromGeofence(session, energy, defaultRate, _overrides, touByGeofenceId) {
  // TOU 优先：围栏配置了分时窗口 → 按时段分摊
  const tou = touByGeofenceId?.get(Number(session.geofence_id));
  if (tou) {
    const startMs = timeMs(session.start_at ?? session.start_date);
    const endMs = timeMs(session.end_at ?? session.end_date);
    const split = touSplitSession({ startMs, endMs, energyKwh: energy, window: tou });
    if (split) {
      const sessionFee = finiteNumber(session.geofence_session_fee) ?? 0;
      return sessionFee > 0
        ? { ...split, costCny: round(split.costCny + sessionFee, 2) }
        : split;
    }
  }
  const rate = finiteNumber(session.geofence_cost_per_unit);
  if (rate === null || rate <= 0) return null;
  if (energy === null || energy <= 0) return null;
  const sessionFee = finiteNumber(session.geofence_session_fee) ?? 0;
  return {
    costCny: round(energy * rate + sessionFee, 2),
    pricePerUnit: round(rate, 4),
    source: "geofence"
  };
}

// Layer ④: last resort, the instance-wide default tariff.
function priceFromDefaultTariff(session, energy, defaultRate) {
  const rate = finiteNumber(defaultRate);
  if (rate === null || rate <= 0) return null;
  if (energy === null || energy <= 0) return null;
  return {
    costCny: round(energy * rate, 2),
    pricePerUnit: round(rate, 4),
    source: "default"
  };
}

const CHARGING_PRICE_LAYERS = [priceFromLocalOverride, priceFromStatedCost, priceFromGeofence, priceFromDefaultTariff];

// Resolve one charging session to {costCny, pricePerUnit, source}. Returns an
// `unknown` result (nulls) when no layer can produce a figure — callers must
// treat that as "cannot price", never as zero.
// options.overrides: Map<cpId, cost>（第①层本地补录）；options.touByGeofenceId:
// Map<geofenceId, touWindow>（第③层分时窗口）。
export function priceChargingSession(session = {}, defaultRate = null, options = {}) {
  const energy = finiteNumber(session.charge_energy_added);
  for (const layer of CHARGING_PRICE_LAYERS) {
    const priced = layer(session, energy, defaultRate, options.overrides, options.touByGeofenceId);
    if (priced) return priced;
  }
  return { costCny: null, pricePerUnit: null, source: "unknown" };
}

// ---- turning charges into consumable batches (AC-7.2) ----------------------

// Each priced charge becomes one electricity batch that later drives may draw
// from. The batch carries the battery-side energy (`charge_energy_added`) and a
// unit price equal to the amount paid divided by that energy, which folds in
// charging losses: once the batch is fully drained, the sum of what drives were
// billed equals what the owner actually paid for it (ledger closure).
//
// A batch only opens once the charge has finished (or, for an in-progress
// charge, from its start); batches are emitted sorted by availability so FIFO
// consumption is a straight walk.
export function batchesFromChargingSessions(sessions, options = {}) {
  const batches = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const energy = finiteNumber(session.charge_energy_added);
    if (energy === null || energy <= 0) continue;

    const priced = priceChargingSession(session, session.__defaultRate ?? null, options);
    if (priced.costCny === null || priced.pricePerUnit === null) continue;

    const availableMs = timeMs(session.end_at ?? session.end_date)
      ?? timeMs(session.start_at ?? session.start_date);
    if (availableMs === null) continue;

    batches.push({
      batch_id: `cp-${session.id}`,
      charging_process_id: Number(session.id),
      car_id: Number.isInteger(Number(session.car_id)) && Number(session.car_id) > 0 ? Number(session.car_id) : null,
      available_at_ms: availableMs,
      energy_kwh: round(energy),
      unit_price_cny_per_kwh: round(priced.pricePerUnit, 6),
      amount_cny: priced.costCny,
      source: priced.source
    });
  }
  return batches.sort((a, b) => a.available_at_ms - b.available_at_ms || a.batch_id.localeCompare(b.batch_id));
}

// ---- default tariff history ------------------------------------------------

// The default tariff is versioned: when the owner changes it, only drives
// started afterwards should see the new rate (AC-7.3). Replay every change that
// took effect at or before `atMs`, in order, and the last one wins.
function tariffAt(currentRate, history, atMs) {
  let effective = finiteNumber(currentRate);
  const changes = (Array.isArray(history) ? history : [])
    .map((entry) => ({ at: timeMs(entry.changedAt), to: finiteNumber(entry.to) }))
    .filter((entry) => entry.at !== null && entry.to !== null)
    .sort((a, b) => a.at - b.at);
  for (const change of changes) {
    if (change.at > atMs) break;
    effective = change.to;
  }
  return effective;
}

// ---- drive energy ----------------------------------------------------------

// Travel energy comes from the battery-side range drop times the pack
// efficiency (AC-6.3): `(start − end) × cars.efficiency`, preferring the ideal
// range and falling back to the rated range. TeslaMate reports efficiency as
// kWh/km on current models but legacy rows may hold Wh/km; values above 1 are
// therefore treated as Wh/km and scaled down.
export function driveEnergyKwh(drive = {}) {
  const raw = finiteNumber(drive.efficiency);
  const kwhPerKm = raw === null ? null : raw > 1 ? raw / 1000 : raw;
  const idealUsed = finiteNumber(drive.ideal_used_km);
  const ratedUsed = finiteNumber(drive.rated_used_km);
  if (kwhPerKm && idealUsed !== null) return round(idealUsed * kwhPerKm);
  if (kwhPerKm && ratedUsed !== null) return round(ratedUsed * kwhPerKm);
  return null;
}

// ---- FIFO allocation -------------------------------------------------------

// Bring arbitrary batch input into the internal queue shape used during
// allocation: numeric availability, a remaining balance, and a resolvable unit
// price. Batches without a usable price or time are dropped; ordering is by
// availability then id so equal-time batches drain deterministically.
function buildBatchQueue(batches) {
  return (Array.isArray(batches) ? batches : [])
    .map((batch) => ({
      ...batch,
      available_at_ms: finiteNumber(batch.available_at_ms) ?? timeMs(batch.available_at),
      unit_price_cny_per_kwh: finiteNumber(batch.price_cny_per_kwh ?? batch.unit_price_cny_per_kwh),
      remaining_kwh: Math.max(0, finiteNumber(batch.energy_kwh) ?? 0)
    }))
    .filter((batch) =>
      batch.available_at_ms !== null
      && batch.unit_price_cny_per_kwh !== null
      && batch.unit_price_cny_per_kwh >= 0
    )
    .sort((a, b) =>
      a.available_at_ms - b.available_at_ms
      || String(a.batch_id).localeCompare(String(b.batch_id))
    );
}

// Pull `energy` kWh for a drive starting at `driveAtMs` out of the FIFO queue.
// Only batches already available when the drive began, and still holding a
// balance, may contribute. Every deduction is recorded as a slice so the UI can
// show exactly which charges paid for the trip.
function drawFromBatches(queue, energy, driveAtMs) {
  let remaining = energy;
  let drawnKwh = 0;
  let cost = 0;
  const slices = [];
  for (const batch of queue) {
    if (remaining <= 0) break;
    if (batch.available_at_ms > driveAtMs || batch.remaining_kwh <= 0) continue;
    const consumed = Math.min(remaining, batch.remaining_kwh);
    batch.remaining_kwh = round(batch.remaining_kwh - consumed);
    remaining = round(remaining - consumed);
    drawnKwh += consumed;
    cost += consumed * batch.unit_price_cny_per_kwh;
    slices.push({
      source: "batch",
      batch_id: batch.batch_id,
      energy_kwh: round(consumed),
      unit_price_cny_per_kwh: batch.unit_price_cny_per_kwh,
      cost_cny: round(consumed * batch.unit_price_cny_per_kwh, 2)
    });
  }
  return { remaining, drawnKwh, cost, slices };
}

// Bill whatever the batches could not cover at the tariff in force when the
// drive began. A missing or nonsensical tariff marks the leftover as unpriced
// rather than guessing.
function drawFromDefaultTariff(queueResult, defaultRate, defaultRateHistory, driveAtMs) {
  const { remaining, slices } = queueResult;
  if (remaining <= 0) {
    return { defaultKwh: 0, unpricedKwh: 0, cost: 0, slices };
  }
  const rate = tariffAt(defaultRate, defaultRateHistory, driveAtMs);
  if (rate === null || rate < 0) {
    return {
      defaultKwh: 0,
      unpricedKwh: remaining,
      cost: 0,
      slices: [...slices, { source: "unpriced", energy_kwh: round(remaining), unit_price_cny_per_kwh: null, cost_cny: null }]
    };
  }
  return {
    defaultKwh: remaining,
    unpricedKwh: 0,
    cost: remaining * rate,
    slices: [...slices, {
      source: "default",
      energy_kwh: round(remaining),
      unit_price_cny_per_kwh: rate,
      cost_cny: round(remaining * rate, 2)
    }]
  };
}

// Distribute a chronological series of drives over the batch pool.
//
// m4e 多车分池：批次与行程都按 car_id 分池 —— A 车充电的批次只抵 A 车行程
// （电能不跨车转移）。car_id 缺失（null/undefined）的行共用一个"无主池"，
// 单车数据（或存量调用点不带 car_id）因此保持与历史完全一致的行为。
//
// Returns {allocations, remaining_batches}. Each allocation carries the drive's
// energy split across its sources (batch / default / unpriced), the trip cost as
// shown to the user (`cost_cny`, 2dp) and a high-precision internal twin
// (`cost_cny_precise`, 10dp) that later aggregation may sum without drift
// (PRD §7.3). A drive is `allocation_reliable` only when it has both a start
// time and a non-negative energy figure; `cost_complete` is false whenever any
// of its energy could not be priced.
export function allocateDriveCosts({ drives, batches, defaultRate, defaultRateHistory = [] } = {}) {
  const poolKey = (row) => {
    const id = Number(row?.car_id);
    return Number.isInteger(id) && id > 0 ? id : null;
  };

  // 按车分池建队列；同一池内保持时间序 FIFO 语义不变
  const pools = new Map();
  const poolFor = (key) => {
    if (!pools.has(key)) pools.set(key, { queue: [], drives: [] });
    return pools.get(key);
  };
  const queueRows = buildBatchQueue(batches);
  for (const batch of queueRows) poolFor(poolKey(batch)).queue.push(batch);

  const orderedDrives = (Array.isArray(drives) ? drives : [])
    .map((drive, index) => ({ ...drive, index, drive_at_ms: timeMs(drive.start_at ?? drive.start_date) }))
    .sort((a, b) =>
      (a.drive_at_ms ?? Number.POSITIVE_INFINITY) - (b.drive_at_ms ?? Number.POSITIVE_INFINITY)
      || a.index - b.index
    );
  for (const drive of orderedDrives) poolFor(poolKey(drive)).drives.push(drive);

  const allocations = [];
  for (const { queue, drives: poolDrives } of pools.values()) {
    for (const drive of poolDrives) {
      const energy = finiteNumber(drive.estimated_kwh ?? drive.energy_kwh);

      // A drive with no usable time or energy cannot be billed at all.
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

      const drawn = drawFromBatches(queue, energy, drive.drive_at_ms);
      const tail = drawFromDefaultTariff(drawn, defaultRate, defaultRateHistory, drive.drive_at_ms);
      const totalCost = drawn.cost + tail.cost;

      allocations.push({
        drive_id: drive.id,
        energy_kwh: round(energy),
        batch_kwh: round(drawn.drawnKwh),
        default_kwh: round(tail.defaultKwh),
        unpriced_kwh: round(tail.unpricedKwh),
        cost_cny: tail.unpricedKwh > 0 ? null : round(totalCost, 2),
        cost_cny_precise: tail.unpricedKwh > 0 ? null : round(totalCost, 10),
        allocation_reliable: true,
        cost_complete: tail.unpricedKwh === 0,
        slices: tail.slices
      });
    }
  }

  return {
    allocations,
    remaining_batches: [...pools.values()].flatMap(({ queue }) => queue.map((batch) => ({
      batch_id: batch.batch_id,
      car_id: poolKey(batch),
      remaining_kwh: round(batch.remaining_kwh)
    })))
  };
}

// ---- 驻车损耗（AC-7.5，事件驱动扣减）----------------------------------------

// 每次新事件（新行程/新充电开始）对比「上一事件结束时表显电量」与「当前事件开始时
// 表显电量」，差值 > PARKING_LOSS_THRESHOLD_KWH 立即生成一条驻车能耗支出冲抵当前
// FIFO 批次（不等下次充电，避免滞后错价）；差值 ≤ 阈值（含 BMS 温漂导致的负数）
// 忽略——负损耗一律过滤。
export const PARKING_LOSS_THRESHOLD_KWH = 0.5;

// 计算两次表显读数之间的驻车损耗。返回 {kwh} 或 null（不可计算/低于阈值/负损耗）。
// socKwh：表显电量折算值（battery_level% × 包容量，或直接 kWh 读数）。
export function parkingLossBetween(prevKwh, currentKwh, thresholdKwh = PARKING_LOSS_THRESHOLD_KWH) {
  const prev = finiteNumber(prevKwh);
  const curr = finiteNumber(currentKwh);
  if (prev === null || curr === null) return null;
  const delta = curr - prev; // 表显减少为负
  const loss = -delta;       // 损耗为正数
  if (loss <= thresholdKwh) return null; // 负损耗（温漂回升）与 ≤0.5kWh 都过滤
  return { kwh: round(loss) };
}

// 把驻车损耗冲抵进 FIFO 队列（从最老批次开始扣）。返回消耗明细 slices。
// 队列结构同 buildBatchQueue（remaining_kwh / unit_price_cny_per_kwh）。
export function applyParkingLossToBatches(queue, lossKwh, atMs) {
  const slices = [];
  let remaining = finiteNumber(lossKwh) ?? 0;
  if (remaining <= 0) return { absorbedKwh: 0, unabsorbedKwh: 0, slices };
  let absorbed = 0;
  for (const batch of queue) {
    if (remaining <= 0) break;
    if (batch.available_at_ms > atMs || batch.remaining_kwh <= 0) continue;
    const consumed = Math.min(remaining, batch.remaining_kwh);
    batch.remaining_kwh = round(batch.remaining_kwh - consumed);
    remaining = round(remaining - consumed);
    absorbed += consumed;
    slices.push({
      source: "parking_loss",
      batch_id: batch.batch_id,
      energy_kwh: round(consumed),
      unit_price_cny_per_kwh: batch.unit_price_cny_per_kwh,
      cost_cny: round(consumed * batch.unit_price_cny_per_kwh, 2)
    });
  }
  return { absorbedKwh: round(absorbed), unabsorbedKwh: round(remaining), slices };
}
