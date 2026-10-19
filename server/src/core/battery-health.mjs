// battery-health.mjs — 电池健康聚合（参考 TeslaMate BatteryHealthV2 的思路重写）。
//
// 数据源只取 charging_processes（几百行,毫秒级）,不扫 positions 大表:
//   - 每次有效充电可折算一次"满电表显续航投影": end_range × 100 / end_level
//   - 也可折算一次"可用容量": 100 × charge_energy_added / Δlevel
// 健康度 = 近期投影 ÷ 早期投影(取前 30 次有效充电为"新车基线")。
// 判定有效充电: charge_energy_added ≥ 10 kWh 且 Δlevel ≥ 10%(噪声大、
// 桩端计量和表显漂移都会放大误差;样本不足时相应字段降级为 null,UI 隐藏)。
import { finiteNumber, timeMs } from "./util.mjs";

const MIN_ADDED_KWH = 10;
const MIN_LEVEL_DELTA = 10;
const BASELINE_WINDOW = 30;   // 早期 N 次有效充电 = 新车基线
const CURRENT_WINDOW = 30;    // 近期 N 次 = 当前状态
const CAPACITY_WINDOW_DAYS = 365;

function validSessions(rows) {
  return rows
    .map((r) => {
      const added = finiteNumber(r.charge_energy_added);
      const dLevel = finiteNumber(r.end_battery_level) - finiteNumber(r.start_battery_level);
      const endRange = finiteNumber(r.end_rated_range_km) ?? finiteNumber(r.end_ideal_range_km);
      const endLevel = finiteNumber(r.end_battery_level);
      return { added, dLevel, endRange, endLevel, endAt: r.end_date };
    })
    .filter((s) =>
      s.added != null && s.added >= MIN_ADDED_KWH
      && s.dLevel != null && s.dLevel >= MIN_LEVEL_DELTA
    );
}

/**
 * 电池健康快照。
 * 返回字段任一都可能为 null(样本不足),调用方/UI 按"数据可得才显示"渲染。
 */
export function computeBatteryHealth(rows, { nowMs = Date.now() } = {}) {
  const sessions = validSessions(rows);
  if (sessions.length < 5) return { sampleCount: sessions.length, insufficient: true };

  // ---- 满电表显续航投影(每会话一个点,顺序即时间序) ----
  const proj = sessions
    .filter((s) => s.endRange != null && s.endLevel >= 30)
    .map((s) => ({ at: s.endAt, km: s.endRange * 100 / s.endLevel }))
    .filter((p) => Number.isFinite(p.km));
  if (proj.length < 5) return { sampleCount: sessions.length, insufficient: true };

  const avg = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  const baselineKm = avg(proj.slice(0, Math.min(BASELINE_WINDOW, Math.max(5, Math.floor(proj.length / 4)))).map((p) => p.km));
  // 近期窗口:样本少时至少排除基线段(总样本 20 时取近 10,而非混入早期)
  const currentWindow = Math.min(CURRENT_WINDOW, Math.max(5, Math.ceil(proj.length / 2)));
  const currentKm = avg(proj.slice(-currentWindow).map((p) => p.km));
  const healthPct = baselineKm > 0 ? Math.round((currentKm / baselineKm) * 1000) / 10 : null;

  // ---- 可用容量估计: 近一年 Δlevel 较大的会话,P90 抗噪 ----
  const yearAgoMs = nowMs - CAPACITY_WINDOW_DAYS * 86400_000;
  const capSamples = sessions
    .filter((s) => {
      const t = timeMs(s.endAt);
      return t !== null && t >= yearAgoMs && s.dLevel >= 20;
    })
    .map((s) => 100 * s.added / s.dLevel)
    .sort((a, b) => a - b);
  let capacityKwh = null;
  if (capSamples.length >= 5) {
    capacityKwh = Math.round(capSamples[Math.floor(capSamples.length * 0.9)] * 10) / 10;
  }

  // ---- 循环次数 / 充电效率 ----
  const totalAdded = sessions.reduce((a, s) => a + s.added, 0);
  const cycles = capacityKwh ? Math.round((totalAdded / capacityKwh) * 10) / 10 : null;
  let rechargeEfficiency = null;
  const usedSum = rows.reduce((a, r) => a + (finiteNumber(r.charge_energy_used) ?? 0), 0);
  const addedSum = rows.reduce((a, r) => a + (finiteNumber(r.charge_energy_added) ?? 0), 0);
  if (usedSum > 0 && addedSum > 0) rechargeEfficiency = Math.round((addedSum / usedSum) * 1000) / 10;

  // ---- 月度趋势: 每月投影均值(近 24 个月,月内 ≥1 点) ----
  const byMonth = new Map();
  for (const p of proj) {
    const t = timeMs(p.at);
    if (t === null) continue;
    const d = new Date(t);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(p.km);
  }
  const trend = [...byMonth.entries()]
    .slice(-24)
    .map(([month, kms]) => ({ month, maxRangeKm: Math.round(avg(kms) * 10) / 10 }));

  return {
    sampleCount: sessions.length,
    healthPct,
    baselineMaxRangeKm: Math.round(baselineKm * 10) / 10,
    currentMaxRangeKm: Math.round(currentKm * 10) / 10,
    capacityKwh,
    cycles,
    rechargeEfficiency,
    totalAddedKwh: Math.round(totalAdded * 10) / 10,
    trend,
    insufficient: false
  };
}

/** GET /api/battery-health 用的只读查询(全部充电会话的起止 SOC/续航/能耗) */
export async function getBatteryHealth(db, { carId = null } = {}) {
  const car = Number.isInteger(Number(carId)) && Number(carId) > 0 ? Number(carId) : null;
  const rows = await db.query(`
    SELECT cp.end_date,
           cp.charge_energy_added::float8, cp.charge_energy_used::float8,
           cp.start_battery_level, cp.end_battery_level,
           cp.start_rated_range_km, cp.end_rated_range_km,
           cp.start_ideal_range_km, cp.end_ideal_range_km
    FROM charging_processes cp
    WHERE cp.end_date IS NOT NULL
      AND cp.charge_energy_added IS NOT NULL
      AND ($1::int IS NULL OR cp.car_id = $1::int)
    ORDER BY cp.end_date ASC
  `, [car]);
  return computeBatteryHealth(rows);
}
