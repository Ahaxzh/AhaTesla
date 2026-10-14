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
