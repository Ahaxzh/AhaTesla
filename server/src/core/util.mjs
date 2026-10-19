// Shared helpers.
export function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

export function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean" || typeof value === "object") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// TeslaMate stores naive-UTC timestamps; treat missing TZ as UTC.
export function timeMs(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function isoFromTeslaMate(value) {
  const ms = timeMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

export function utcNaiveSqlExpr(value, errorMessage = "invalid timestamp") {
  const ms = timeMs(value);
  if (ms === null) throw new Error(errorMessage);
  return `('${new Date(ms).toISOString()}'::timestamptz AT TIME ZONE 'UTC')`;
}

// ---- tz 感知的墙钟 → 瞬时换算 -----------------------------------------------
// 背景：实例时区可配置（settings.timezone），但 Date 的本地方法只认服务器
// 进程时区（Docker 常为 UTC）。所有"某时区墙钟零点/某时区 8 点"的边界计算
// 都必须走这里，不能用 setHours/new Date(y,m,d)。

function wallClockParts(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date(ms));
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/** tz 时区墙钟 y-m-d hh:mm 对应的 UTC 瞬时（ms）。两轮迭代消除 DST 偏差
 *  （每轮以目标墙钟为基准重算，非累积修正）。 */
export function wallClockToUtcMs(tz, year, month, day, hour = 0, minute = 0) {
  const base = Date.UTC(year, month - 1, day, hour, minute);
  let guess = base;
  for (let i = 0; i < 2; i++) {
    const p = wallClockParts(guess, tz);
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour === "24" ? "0" : p.hour), Number(p.minute));
    const offset = asUtc - guess; // 该时刻 tz 相对 UTC 的偏移
    if (guess === base - offset) break; // 已收敛
    guess = base - offset;
  }
  return guess;
}

/** "YYYY-MM" → 该时区自然月 [startIso, endIso)（北京时间月初，非 UTC 月初）。 */
export function monthWindowIso(month, tz = "Asia/Shanghai") {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  const startMs = wallClockToUtcMs(tz, year, mon, 1);
  const endMs = mon === 12
    ? wallClockToUtcMs(tz, year + 1, 1, 1)
    : wallClockToUtcMs(tz, year, mon + 1, 1);
  return { startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() };
}
