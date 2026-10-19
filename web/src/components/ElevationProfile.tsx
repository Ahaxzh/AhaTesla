import { useI18n } from '@/i18n'

/** 行程海拔剖面(Grafana trip.json Elevation 提炼):纯 SVG 面积图,
 *  与路线图同点位序列,数据不足(<3 点或无 elevation)整块隐藏。 */
export function ElevationProfile({ points }: { points: { elevation?: number | null }[] }) {
  const { t } = useI18n()
  const pts = points.filter((p) => p.elevation != null && Number.isFinite(p.elevation))
  if (pts.length < 3) return null

  const W = 600
  const H = 90
  const PAD = 6
  const elevations = pts.map((p) => p.elevation as number)
  const min = Math.min(...elevations)
  const max = Math.max(...elevations)
  const span = Math.max(max - min, 1)
  const x = (i: number) => PAD + (i / (pts.length - 1)) * (W - PAD * 2)
  const y = (e: number) => H - PAD - ((e - min) / span) * (H - PAD * 2)

  // 折线 + 面积
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.elevation as number).toFixed(1)}`).join(' ')
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${H - PAD} L${x(0).toFixed(1)},${H - PAD} Z`
  const gain = pts.reduce((acc, p, i) => (i > 0 && (p.elevation as number) > elevations[i - 1] ? acc + (p.elevation as number) - elevations[i - 1] : acc), 0)

  return (
    <div data-testid="elevation-profile">
      <div className="mb-1.5 flex items-baseline justify-between text-[11px] text-slate-500">
        <span>{t('trip.elevation', '海拔剖面')}</span>
        <span className="num">
          {Math.round(min)}–{Math.round(max)} m
          {gain > 10 ? ` · ${t('trip.elevationGain', '爬升')} ${Math.round(gain)} m` : ''}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[90px] w-full" preserveAspectRatio="none" role="img" aria-label={t('trip.elevation', '海拔剖面')}>
        <defs>
          <linearGradient id="elevFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(56,189,248,0.35)" />
            <stop offset="100%" stopColor="rgba(56,189,248,0.02)" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#elevFill)" />
        <path d={line} fill="none" stroke="rgba(56,189,248,0.8)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}
