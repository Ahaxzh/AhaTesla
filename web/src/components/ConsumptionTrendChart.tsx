import { useRef, useState } from 'react'
import { useI18n } from '@/i18n'
import { fmtKm } from '@/utils/format'

/**
 * 逐趟能耗曲线（能耗页，v2.7）—— 车机能耗 App「按时间」的网页版：
 * x = 行程结束时间，y = 该趟 Wh/km，点色相对区间平均（绿=更省 琥珀=更费，
 * 同 EfficiencyCard Δ 口径），虚线 = 区间平均。悬停/点按/键盘 focus 三通道 tooltip。
 * 主编码是点位相对平均线的高低，颜色只做冗余强化——色弱下结论不丢。
 */

export interface TrendPoint {
  id: number
  /** 行程结束时刻 ISO */
  endAt: string
  /** 该趟 Wh/km（= kWh/100km × 10，表显口径能耗 ÷ 里程） */
  whPerKm: number
  distanceKm: number
}

/** 紧凑日期 10/17（手工切串避免时区解析陷阱，同 DailyActivityChart） */
function fmtShort(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split('-')
  return `${Number(m)}/${Number(d)}`
}

export function ConsumptionTrendChart({ points, avgWhPerKm }: { points: TrendPoint[]; avgWhPerKm: number | null }) {
  const { t } = useI18n()
  const [tip, setTip] = useState<{ x: number; i: number } | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)

  if (points.length < 2) return null

  const vals = points.map((p) => p.whPerKm)
  const max = Math.max(...vals, avgWhPerKm ?? 0)
  const min = Math.min(...vals, avgWhPerKm ?? max)
  // 点图不必零基线（柱状图才必须），上下各留 15% 余量让差异可读；退化区间兜底 ±10
  const span = max - min
  const lo = min - (span || 10) * 0.15
  const hi = max + (span || 10) * 0.15
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100

  /** tooltip x 定位：跟随点真实位置，左右缘钳制防溢出（同 DailyActivityChart；jsdom 零矩形时落 70px） */
  const clampX = (el: HTMLButtonElement): number => {
    const host = hostRef.current
    if (!host) return 70
    const hr = host.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const cx = r.left - hr.left + r.width / 2
    return Math.min(Math.max(cx, 70), Math.max(hr.width - 70, 70))
  }
  const showTip = (el: HTMLButtonElement, i: number) => setTip({ x: clampX(el), i })

  const active = tip != null ? points[tip.i] : null
  const gap = points.length > 48 ? 0 : points.length > 24 ? 1 : 3
  const ticks = [points[0], points[Math.floor((points.length - 1) / 2)], points[points.length - 1]]

  return (
    <div data-testid="energy-trend">
      <div className="relative">
        <div ref={hostRef} className="relative h-28 sm:h-32" data-testid="energy-trend-track" role="presentation">
          {/* 区间平均参考线（虚线 + 右缘小标签） */}
          {avgWhPerKm != null && (
            <div
              className="absolute inset-x-0 border-t border-dashed border-white/25"
              style={{ bottom: `${pct(avgWhPerKm)}%` }}
              data-testid="energy-trend-avg-line"
              aria-hidden="true"
            >
              <span className="num absolute right-0 top-0.5 text-[10px] text-slate-500">{t('energy.trend.avg', '平均')} {avgWhPerKm}</span>
            </div>
          )}
          <div className="flex h-full" style={{ gap: `${gap}px` }}>
            {points.map((p, i) => {
              const better = avgWhPerKm != null && p.whPerKm <= avgWhPerKm
              return (
                <button
                  key={p.id}
                  type="button"
                  className="relative h-full min-w-[2px] flex-1 cursor-pointer"
                  aria-label={`${fmtShort(p.endAt)} · ${p.whPerKm} Wh/km · ${fmtKm(p.distanceKm)} km`}
                  data-testid="energy-trend-point"
                  data-better={better ? 'true' : 'false'}
                  onMouseEnter={(e) => showTip(e.currentTarget, i)}
                  onMouseLeave={() => setTip(null)}
                  onFocus={(e) => showTip(e.currentTarget, i)}
                  onBlur={() => setTip(null)}
                  onClick={(e) => setTip((prev) => (prev?.i === i ? null : { x: clampX(e.currentTarget), i }))}
                >
                  <span
                    className={`absolute left-1/2 h-2 w-2 -translate-x-1/2 rounded-full ${
                      better ? 'bg-emerald-500' : 'bg-amber-500'
                    }`}
                    style={{ bottom: `calc(${Math.max(Math.min(pct(p.whPerKm), 97), 3)}% - 4px)` }}
                  />
                </button>
              )
            })}
          </div>
        </div>
        {/* x 轴刻度：首/中/尾 */}
        <div className="mt-1.5 flex justify-between text-[11px] text-slate-400" data-testid="energy-trend-x-labels">
          <span className="num">{fmtShort(ticks[0].endAt)}</span>
          <span className="num">{fmtShort(ticks[1].endAt)}</span>
          <span className="num">{fmtShort(ticks[2].endAt)}</span>
        </div>
        {/* Tooltip（悬停/触控/键盘三通道） */}
        {active && tip && (
          <div
            className="pointer-events-none absolute -top-1.5 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-white/10 bg-base-900/95 px-3 py-2 text-xs shadow-lg"
            style={{ left: `${tip.x}px` }}
            data-testid="energy-trend-tooltip"
            role="tooltip"
          >
            <span className="num font-medium text-slate-200">{fmtShort(active.endAt)}</span>
            <span className="num ml-2 text-slate-300">{active.whPerKm} Wh/km</span>
            <span className="num ml-2 text-slate-400">{fmtKm(active.distanceKm)} km</span>
          </div>
        )}
      </div>

      {/* 图例：极性双色说明（单序列 + 参考线，颜色语义必须讲清） */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
          {t('energy.trend.below', '低于平均（更省）')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
          {t('energy.trend.above', '高于平均（更费）')}
        </span>
        <span className="num ml-auto text-slate-500">
          {t('energy.trend.samples', '{n} 趟').replace('{n}', String(points.length))}
        </span>
      </div>
    </div>
  )
}
