/** 数字/日期格式化工具 */
export function fmtKm(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return '--'
  return v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function fmtCny(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return '--'
  return `¥${v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

/** 单价 3~4 位小数（PRD §7.3 精度规范） */
export function fmtPrice(v: number | null | undefined, digits = 3): string {
  if (v == null || Number.isNaN(v)) return '--'
  return v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: 4 })
}

export function fmtKwh(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return '--'
  return `${v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })} kWh`
}

export function fmtDuration(min: number | null | undefined): string {
  if (min == null || Number.isNaN(min)) return '--'
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return h > 0 ? `${h}小时${m}分` : `${m}分钟`
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '--'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '--'
  return fmtDateTime(iso).slice(0, 10)
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '--'
  const d = new Date(iso).getTime()
  if (Number.isNaN(d)) return '--'
  const diff = Date.now() - d
  if (diff < 0) return fmtDateTime(iso)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const day = Math.floor(h / 24)
  if (day < 30) return `${day} 天前`
  return fmtDate(iso)
}

/** ISO 日期（本地时区）用于 input[type=date] */
export function toInputDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
