/** 车辆电量环形图（纯 SVG）。percent 为 null（车辆睡眠/数据缺失）时显示
 *  中性灰环 + "--"，不再伪装成红色 0% 电量吓人。 */
export function BatteryRing({
  percent,
  size = 168,
  label,
}: {
  percent: number | null
  size?: number
  label?: string
}) {
  const hasValue = percent != null && Number.isFinite(percent)
  const clamped = hasValue ? Math.max(0, Math.min(100, percent as number)) : 0
  const stroke = 12
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const offset = c * (1 - clamped / 100)
  const color = !hasValue ? 'rgba(148,163,184,0.35)' : clamped >= 50 ? '#34D399' : clamped >= 20 ? '#FBBF24' : '#E82127'

  return (
    <div className="relative inline-flex items-center justify-center" data-testid="battery-ring">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.07)" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.4,0,0.2,1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="num text-4xl font-bold text-white">
          {hasValue ? Math.round(clamped) : '--'}
          <span className="text-xl font-medium text-slate-400">%</span>
        </div>
        {label && <div className="mt-1 text-xs text-slate-400">{label}</div>}
      </div>
    </div>
  )
}
