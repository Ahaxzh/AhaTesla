// alerts.mjs — P2 告警巡检:胎压过低(独立于行程富化,车静置时也能发现)。
//
// 数据源:teslamate 只读库 positions 表最新一条带 tpms 的记录;
// 阈值默认 2.6 bar,建议值取同车近 200 条读数的 P90(数据不足回落 2.9)。
// 节流由调用方(index.mjs 巡检循环)按 24h 窗口控制,本模块只做纯判定。

const TIRE_THRESHOLD_BAR = 2.6;
const TIRE_DEFAULT_SUGGEST = 2.9;

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 巡检最新四轮胎压。
 * 返回 null(无数据/未越限)或 { fl, fr, rl, rr, min, suggest }。
 */
export async function checkTirePressure(db, { thresholdBar = TIRE_THRESHOLD_BAR } = {}) {
  let latest = null;
  let suggest = TIRE_DEFAULT_SUGGEST;
  try {
    const rows = await db.query(`
      SELECT p.tpms_pressure_fl::float8 AS fl, p.tpms_pressure_fr::float8 AS fr,
             p.tpms_pressure_rl::float8 AS rl, p.tpms_pressure_rr::float8 AS rr
      FROM positions p
      WHERE p.tpms_pressure_fl IS NOT NULL
      ORDER BY p.id DESC
      LIMIT 1
    `);
    latest = rows?.[0] ?? null;
    // 建议值:同车近 200 条读数的 P90(数据不足 20 条回落默认)
    const p90 = await db.queryOne(`
      SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY v.val) AS p90
      FROM (
        SELECT p.tpms_pressure_fl::float8 AS val
        FROM positions p
        WHERE p.tpms_pressure_fl IS NOT NULL
        ORDER BY p.id DESC
        LIMIT 200
      ) v
    `);
    if (p90?.p90 != null && Number(p90.p90) >= thresholdBar) suggest = Math.round(p90.p90 * 10) / 10;
  } catch {
    return null; // 巡检失败静默(断联告警另有 outage 事件负责)
  }
  if (!latest) return null;
  const tp = {
    fl: finite(latest.fl), fr: finite(latest.fr), rl: finite(latest.rl), rr: finite(latest.rr)
  };
  const vals = Object.values(tp).filter((v) => v != null);
  if (vals.length < 3) return null; // 至少三轮有效才判定
  const min = Math.min(...vals);
  if (min >= thresholdBar) return null;
  return { ...tp, min: Math.round(min * 100) / 100, suggest };
}
