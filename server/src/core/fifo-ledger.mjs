// fifo-ledger.mjs — 全量回放的 FIFO 账本（修 H1：行程电费系统性错配）。
//
// 旧路径的每个调用点（trips 列表/详情、dashboard、推送富化、月度汇总）都只把
// 「当前页/当月/单条」行程喂给 allocateDriveCosts，却面对一份「从未被历史行程
// 扣减过」的满额批次池 —— 抽电永远从最老批次开始，于是在多批次场景下每一趟
// 行程都按"最老批次价"计费，账本闭包（Σ分摊 ≡ 实付，AC-7.2）失效。
//
// 正确语义只有一种：从最老批次起、按时间序回放全部行程（含驻车损耗，AC-7.5）
// 一次性消耗整池，然后取所需子集的分摊结果。本模块把这次回放做成进程内缓存
// （按 carId 分 entry），用水位（max id + max end_date）与计价版本号做失效。
// 100k 行程规模下回放是纯内存操作（几十 ms 级），数据获取有分页。
//
// 失效信号：
//   - drives / charging 的 max(id) 或 max(end_date) 变化（新行或旧行补结算）
//   - bumpPricingVersion()（默认价/围栏价/TOU/补录任何变更时由路由调用）
//   - 实例时区变化（影响 TOU 谷峰归类）
//   - 兜底 TTL（数据源 UPDATE 而 id/end_date 均不变的极端情形）
import { finiteNumber, timeMs } from "./util.mjs";
import {
  batchesFromChargingSessions,
  allocateDriveCosts,
  driveEnergyKwh,
  parkingLossBetween,
  PARKING_LOSS_THRESHOLD_KWH
} from "./pricing-ledger.mjs";
import { pricingOptionsFor, instanceTimezone } from "./pricing-options.mjs";
import { listDrivesLightSql, listChargingForStats } from "./teslamate-queries.mjs";

// 计价版本：任何影响价格配置的写入都 bump 一次，缓存据此整体失效。
let pricingVersion = 0;
export function bumpPricingVersion() {
  pricingVersion += 1;
}

const PAGE_SIZE = 1000;
const REPLAY_TTL_MS = 5 * 60_000;
const WATERMARK_THROTTLE_MS = 15_000;

// ---- 驻车损耗（AC-7.5，事件驱动，纯函数） ------------------------------------
// 事件 = 行程区间 + 充电区间（起止各一次表显读数）；只对「上一事件结束 →
// 下一事件开始」的净差计损（>0.5kWh，负损耗过滤）。表显 → kWh：理想/额定
// 续航 × cars.efficiency（>1 视为 Wh/km）。

function normalizeEfficiency(raw) {
  const v = finiteNumber(raw);
  return v === null ? null : v > 1 ? v / 1000 : v;
}

function rangeKwh(rangeKm, effKwhPerKm) {
  const range = finiteNumber(rangeKm);
  if (range === null || !effKwhPerKm) return null;
  return range * effKwhPerKm;
}

function readingAt(row, atField, idealField, ratedField, eff) {
  return {
    atMs: timeMs(row[atField]),
    kwh: rangeKwh(row[idealField], eff) ?? rangeKwh(row[ratedField], eff)
  };
}

/** 由行程行（含绝对续航列）与充电行推全部驻车损耗事件 [{car_id, at_ms, kwh}]。 */
export function computeParkingLosses(driveRows, chargingRows, carRows) {
  const effByCar = new Map();
  for (const car of Array.isArray(carRows) ? carRows : []) {
    const eff = normalizeEfficiency(car.efficiency);
    if (eff !== null) effByCar.set(Number(car.id), eff);
  }
  const intervals = [];
  for (const drive of Array.isArray(driveRows) ? driveRows : []) {
    const eff = effByCar.get(Number(drive.car_id));
    intervals.push({
      carId: Number(drive.car_id),
      start: readingAt(drive, "start_at", "start_ideal_range_km", "start_rated_range_km", eff),
      end: readingAt(drive, "end_at", "end_ideal_range_km", "end_rated_range_km", eff)
    });
  }
  for (const row of Array.isArray(chargingRows) ? chargingRows : []) {
    const eff = effByCar.get(Number(row.car_id));
    intervals.push({
      carId: Number(row.car_id),
      start: readingAt(row, "start_date", "start_ideal_range_km", "start_rated_range_km", eff),
      end: readingAt(row, "end_date", "end_ideal_range_km", "end_rated_range_km", eff)
    });
  }
  const byCar = new Map();
  for (const interval of intervals) {
    if (!byCar.has(interval.carId)) byCar.set(interval.carId, []);
    byCar.get(interval.carId).push(interval);
  }
  const losses = [];
  for (const carIntervals of byCar.values()) {
    carIntervals.sort((a, b) => (a.start.atMs ?? Infinity) - (b.start.atMs ?? Infinity));
    for (let i = 1; i < carIntervals.length; i++) {
      const prev = carIntervals[i - 1];
      const next = carIntervals[i];
      if (prev.end?.kwh == null || next.start?.kwh == null) continue;
      if (next.start.atMs === null) continue;
      const loss = parkingLossBetween(prev.end.kwh, next.start.kwh, PARKING_LOSS_THRESHOLD_KWH);
      if (loss) losses.push({ car_id: next.carId, at_ms: next.start.atMs, kwh: loss.kwh });
    }
  }
  return losses;
}

// ---- 回放 + 缓存 --------------------------------------------------------------

async function fetchWatermarks(db, carId) {
  // 两条小聚合即失效信号；demo/异常库返回 [] → null（退化为 TTL 失效）
  const car = Number.isInteger(Number(carId)) && Number(carId) > 0 ? Number(carId) : null;
  const filter = "AND ($1::int IS NULL OR car_id = $1::int)";
  const [d, c] = await Promise.all([
    db.query(`SELECT max(id) AS max_id, max(end_date) AS max_end FROM drives WHERE end_date IS NOT NULL ${filter}`, [car]).catch(() => []),
    db.query(`SELECT max(id) AS max_id, max(end_date) AS max_end FROM charging_processes WHERE end_date IS NOT NULL ${filter}`, [car]).catch(() => [])
  ]);
  if (!d.length || !c.length) return null;
  return `${d[0].max_id}/${String(d[0].max_end)}/${c[0].max_id}/${String(c[0].max_end)}`;
}

async function fetchAllDriveRows(db, carId) {
  // 轻量列（无 LATERAL 坐标）：全量回放对 positions 大表做端点坐标子查询
  // 会直接打爆 15s 语句超时 —— 回放只算钱，不需要地图。
  const rows = [];
  for (let offset = 0; offset < 500_000; offset += PAGE_SIZE) {
    const { sql, params } = listDrivesLightSql({ carId });
    const page = await db.query(sql, [...params, PAGE_SIZE, offset]);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

const cache = new Map(); // key: String(carId ?? "all")
const inflight = new Map(); // key: Promise（并发去重：dashboard 一次请求 3 处触发回放，冷库下避免 3×磁盘压力）

/**
 * 全量回放并取分摊结果（带缓存 + 并发去重）。
 * @returns {{ byDriveId: Map<string, object>, parking: object[], remaining: object[],
 *             driveRows: object[], chargingRows: object[] }}
 */
export async function getFifoLedger(db, state, carId = null) {
  const key = String(Number.isInteger(Number(carId)) && Number(carId) > 0 ? Number(carId) : "all");
  const tz = instanceTimezone(state);
  const now = Date.now();
  const entry = cache.get(key);

  let watermark = null;
  if (!entry || now - entry.checkedAt > WATERMARK_THROTTLE_MS) {
    watermark = await fetchWatermarks(db, carId);
  }
  if (
    entry
    && entry.pricingVersion === pricingVersion
    && entry.tz === tz
    && (watermark === null || entry.watermark === watermark)
    && now - entry.computedAt < REPLAY_TTL_MS
  ) {
    return entry.value;
  }

  // 同 key 回放已在途 → 共享同一次计算（结果一致性由缓存层保证）
  if (inflight.has(key)) return inflight.get(key);
  const computing = computeReplay(db, state, carId, key, tz, watermark, entry).finally(() => inflight.delete(key));
  inflight.set(key, computing);
  return computing;
}

async function computeReplay(db, state, carId, key, tz, watermark, entry) {
  const now = Date.now();

  const car = key === "all" ? null : Number(key);
  const options = await pricingOptionsFor(db, state);
  const chargingRows = await listChargingForStats(db, { carId: car });
  const batches = batchesFromChargingSessions(chargingRows, {
    ...options,
    defaultRate: state?.pricing?.defaultRateCnyPerKwh ?? null
  });
  const driveRows = await fetchAllDriveRows(db, car);
  const carRows = await db.query(`SELECT id, efficiency FROM cars`).catch(() => []);
  const parkingLosses = computeParkingLosses(driveRows, chargingRows, carRows);
  const { allocations, parking_allocations: parking = [], remaining_batches: remaining = [] } = allocateDriveCosts({
    drives: driveRows.map((drive) => ({
      id: drive.id,
      car_id: drive.car_id,
      start_at: drive.start_at ?? drive.start_date,
      estimated_kwh: driveEnergyKwh(drive)
    })),
    batches,
    defaultRate: state?.pricing?.defaultRateCnyPerKwh ?? null,
    defaultRateHistory: state?.pricing?.history ?? [],
    parkingLosses
  });
  const value = {
    byDriveId: new Map(allocations.map((a) => [String(a.drive_id), a])),
    parking,
    remaining,
    batches,
    driveRows,
    chargingRows
  };
  // 水位不可知（demo 库 / 异常库 / 测试 fake db）→ 不落缓存，每次现算：
  // 避免在无法探测数据变化时把过期回放喂给后续请求。
  if (watermark !== null) {
    cache.set(key, {
      value,
      pricingVersion,
      tz,
      watermark,
      computedAt: now,
      checkedAt: now
    });
  } else {
    cache.delete(key);
  }
  return value;
}

/** 账本失效钩子：测试与热重载场景清空缓存。 */
export function clearFifoLedgerCache() {
  cache.clear();
}
