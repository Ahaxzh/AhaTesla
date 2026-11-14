import { useMemo, useRef, useState } from 'react'
import type { TripsOverview } from '@/types'
import { useI18n } from '@/i18n'
import { fmtDuration } from '@/utils/format'

/**
 * 时间分布 v0.4 —— 每日活跃柱状图（替代 v0.3 三段占比条）。
 * 旧版问题：分母=区间总时长，驻车 ~96% 把条压成灰条、行驶/充电成亚像素细缝，信息量趋零。
 * 改版思路（TeslaMate 时间轴的降粒度版）：x 轴=天/周（跟随日期筛选；区间 >150 天后端
 * 自动切周桶，点数有界防长区间柱宽被稀释），每根细柱=当天 行驶(天蓝)+充电(翠绿) 分钟堆叠，
 * y 轴按区间峰值定标——驻车不进坐标系，降级为底部小字（"驻车 96.4% · 日均活跃 X"）。
 * 悬停/点按/键盘 focus 柱子 → tooltip（三通道，同 HeatmapCalendar 口径，左右缘钳制）。
 */

/** 紧凑日期 10/17（手工切串避免时区解析陷阱） */
function fmtShort(date: string): string {
  const [, m, d] = date.split('-')
  return `${Number(m)}/${Number(d)}`
}

/** 紧凑小时（峰值/汇总用；分钟级精度留给 tooltip 的 fmtDuration） */
function fmtHours(min: number): string {
  return min > 0 && min < 60 ? `${Math.round(min)}min` : `${(min / 60).toFixed(1).replace(/\.0$/, '')}h`
}

export function DailyActivityChart({ overview }: { overview: TripsOverview }) {
  const { t, lang } = useI18n()
  const [tip, setTip] = useState<{ x: number; i: number } | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)

  const { bucket, points } = overview.daily

  const stats = useMemo(() => {
    const maxAct = Math.max(...points.map((p) => p.driveMin + p.chargeMin), 30)
    let peak: { date: string; act: number } | null = null
    let actMin = 0
    for (const p of points) {
      const act = p.driveMin + p.chargeMin
      actMin += act
      if (!peak || act > peak.act) peak = { date: p.date, act }
    }
    const spanMin = points.length * (bucket === 'day' ? 1440 : 10080)
    return {
      maxAct,
      peak,
      actMin,
      parkedPct: points.length ? Math.max(0, (1 - actMin / spanMin) * 100) : 0,
      dailyAvg: points.length ? actMin / points.length : 0,
    }
  }, [points, bucket])

  const active = tip != null ? points[tip.i] : null
  const activeLabel = (date: string): string => {
    if (bucket === 'week') {
      const end = new Date(new Date(`${date}T00:00:00`).getTime() + 6 * 86400_000)
      return `${fmtShort(date)} – ${end.getMonth() + 1}/${end.getDate()}`
    }
    const dt = new Date(`${date}T00:00:00`)
    const dow = lang === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()] : `周${'日一二三四五六'[dt.getDay()]}`
    return lang === 'en'
      ? `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getMonth()]} ${dt.getDate()}`
      : `${dt.getMonth() + 1}月${dt.getDate()}日 ${dow}`
  }

  /** tooltip x 定位：跟随柱子真实位置，左右缘钳制防溢出（同 HeatmapCalendar；jsdom 零矩形时落 70px） */
  const clampX = (el: HTMLButtonElement): number => {
    const host = hostRef.current
    if (!host) return 70
    const hr = host.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const cx = r.left - hr.left + r.width / 2
    return Math.min(Math.max(cx, 70), Math.max(hr.width - 70, 70))
  }
  const showTip = (el: HTMLButtonElement, i: number) => setTip({ x: clampX(el), i })

  // 柱距自适应：点多时去 gap 保 ≥2px 柱宽（150 桶在 360px 屏放得下）
  const gap = points.length > 120 ? 0 : points.length > 48 ? 1 : 3
  const ticks = points.length
    ? [points[0], points[Math.floor((points.length - 1) / 2)], points[points.length - 1]]
    : []

  return (
    <div data-testid="trip-daily-activity">
      <div className="relative">
        <div
          ref={hostRef}
          className="flex h-20 items-end sm:h-24"
          style={{ gap: `${gap}px` }}
          data-testid="daily-track"
          role="presentation"
        >
          {points.map((p, i) => {
            const act = p.driveMin + p.chargeMin
            const dh = act > 0 ? Math.max((p.driveMin / stats.maxAct) * 100, 2) : 0
            const ch = act > 0 && p.chargeMin > 0 ? Math.max((p.chargeMin / stats.maxAct) * 100, 0.6) : 0
            return (
              <button
                key={p.date}
                type="button"
                className="flex h-full min-w-[2px] flex-1 cursor-pointer flex-col justify-end"
                aria-label={`${activeLabel(p.date)} · ${t('trips.share.drive', '行驶')} ${fmtDuration(p.driveMin)} · ${t('trips.share.charge', '充电')} ${fmtDuration(p.chargeMin)} · ${p.trips} ${t('dash.tripsUnit', '趟')}`}
                data-testid="daily-bar"
                data-active={tip?.i === i}
                data-zero={act === 0}
                onMouseEnter={(e) => showTip(e.currentTarget, i)}
                onMouseLeave={() => setTip(null)}
                onFocus={(e) => showTip(e.currentTarget, i)}
                onBlur={() => setTip(null)}
                onClick={(e) => setTip(tip?.i === i ? null : { x: clampX(e.currentTarget), i })}
              >
                {act > 0 ? (
                  <>
                    {ch > 0 && <span className="block w-full rounded-t-[2px] bg-emerald-500" style={{ height: `${ch}%` }} />}
                    <span
                      className="block w-full bg-sky-500"
                      style={{ height: `${dh}%`, borderRadius: ch > 0 ? undefined : '2px 2px 0 0' }}
                    />
                  </>
                ) : (
                  <span className="block h-[2px] w-full rounded-sm bg-white/[0.08]" />
                )}
              </button>
            )
          })}
        </div>
        {/* x 轴刻度：首/中/尾 */}
        {ticks.length > 0 && (
          <div className="mt-1.5 flex justify-between text-[11px] text-slate-400" data-testid="daily-x-labels">
            <span className="num">{fmtShort(ticks[0].date)}</span>
            <span className="num">{fmtShort(ticks[1].date)}</span>
            <span className="num">{fmtShort(ticks[2].date)}</span>
          </div>
        )}
        {/* Tooltip（悬停/触控/键盘三通道） */}
        {active && tip && (
          <div
            className="pointer-events-none absolute -top-1.5 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-white/10 bg-base-900/95 px-3 py-2 text-xs shadow-lg"
            style={{ left: `${tip.x}px` }}
            data-testid="daily-tooltip"
            role="tooltip"
          >
            <span className="num font-medium text-slate-200">{activeLabel(active.date)}</span>
            <span className="num ml-2 text-sky-400">{t('trips.share.drive', '行驶')} {fmtDuration(active.driveMin)}</span>
            <span className="num ml-2 text-emerald-400">{t('trips.share.charge', '充电')} {fmtDuration(active.chargeMin)}</span>
            <span className="num ml-2 text-slate-400">{active.trips} {t('dash.tripsUnit', '趟')}</span>
          </div>
        )}
      </div>

      {/* 图例 + 峰值（区间内最活跃的一天/一周） */}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-slate-400">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-sky-500" />
            {t('trips.share.drive', '行驶')} <span className="num text-slate-300">{fmtDuration(overview.stateShare.driveMin)}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
            {t('trips.share.charge', '充电')} <span className="num text-slate-300">{fmtDuration(overview.stateShare.chargeMin)}</span>
          </span>
        </div>
        {stats.peak && stats.peak.act > 0 && (
          <span className="num text-slate-500" data-testid="daily-peak">
            {t('trips.share.peak', '峰值')} {fmtShort(stats.peak.date)} · {fmtHours(stats.peak.act)}
          </span>
        )}
      </div>
      {/* 驻车叙事降级为小字：驻车占比 + 日均活跃（由桶数据计算，"全部"区间也有意义） */}
      <div className="num mt-1 text-[11px] text-slate-500" data-testid="daily-sub">
        {t('trips.share.parked', '驻车')} {stats.parkedPct.toFixed(1)}% · {t('trips.share.dailyAvg', '日均活跃')} {fmtDuration(stats.dailyAvg)}
      </div>
    </div>
  )
}
