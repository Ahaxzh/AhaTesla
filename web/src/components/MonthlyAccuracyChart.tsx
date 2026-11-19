import { useRef, useState } from 'react'
import { useI18n } from '@/i18n'

/**
 * 每月「实际里程 vs 表显消耗」（能耗页，v2.7）—— 预估 vs 实际的按月回答：
 * 柱 = 实际里程（跑掉的），横刻线 = 表显续航消耗里程（预估掉的），
 * 柱高越过刻线 = 当月跑赢表显（绿），不及 = 琥珀。达成率与公里数进 tooltip。
 * 同 ConsumptionTrendChart：位置关系是主编码（柱 vs 刻线），颜色冗余强化。
 */

export interface MonthPoint {
  /** YYYY-MM */
  month: string
  actualKm: number
  ratedKm: number
  ratio: number
}

/** 紧凑月份 3月 / Mar（手工切串避免时区解析） */
function fmtMonth(month: string, lang: 'zh' | 'en'): string {
  const m = Number(month.slice(5, 7))
  return lang === 'en' ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] : `${m}月`
}

export function MonthlyAccuracyChart({ months }: { months: MonthPoint[] }) {
  const { t, lang } = useI18n()
  const [tip, setTip] = useState<{ x: number; i: number } | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)

  const data = months.slice(-12)
  if (data.length < 2) return null

  const max = Math.max(...data.flatMap((m) => [m.actualKm, m.ratedKm]), 1)
  const pct = (v: number) => (v / max) * 100

  const clampX = (el: HTMLButtonElement): number => {
    const host = hostRef.current
    if (!host) return 70
    const hr = host.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const cx = r.left - hr.left + r.width / 2
    return Math.min(Math.max(cx, 70), Math.max(hr.width - 70, 70))
  }
  const showTip = (el: HTMLButtonElement, i: number) => setTip({ x: clampX(el), i })

  const active = tip != null ? data[tip.i] : null
  const gap = data.length > 8 ? 2 : 4
  const ticks = [data[0], data[Math.floor((data.length - 1) / 2)], data[data.length - 1]]

  return (
    <div data-testid="energy-monthly">
      <div className="relative">
        <div ref={hostRef} className="flex h-24 items-end sm:h-28" style={{ gap: `${gap}px` }} data-testid="energy-monthly-track" role="presentation">
          {data.map((m, i) => {
            const beats = m.ratio >= 1
            return (
              <button
                key={m.month}
                type="button"
                className="relative h-full min-w-[3px] flex-1 cursor-pointer"
                aria-label={`${fmtMonth(m.month, lang)} · ${t('energy.monthly.actual', '实际')} ${m.actualKm} km · ${t('energy.monthly.rated', '表显消耗')} ${m.ratedKm} km · ${t('energy.kpi.accuracy', '表显达成')} ${Math.round(m.ratio * 100)}%`}
                data-testid="energy-monthly-bar"
                data-beats={beats ? 'true' : 'false'}
                onMouseEnter={(e) => showTip(e.currentTarget, i)}
                onMouseLeave={() => setTip(null)}
                onFocus={(e) => showTip(e.currentTarget, i)}
                onBlur={() => setTip(null)}
                onClick={(e) => setTip((prev) => (prev?.i === i ? null : { x: clampX(e.currentTarget), i }))}
              >
                {/* 表显消耗刻线（预估）：比柱左右各探出 1px，读作"标记"而非第二条数据 */}
                <span
                  className="absolute left-[-2px] right-[-2px] h-[2px] rounded-full bg-white/70"
                  style={{ bottom: `${Math.min(pct(m.ratedKm), 99)}%` }}
                  aria-hidden="true"
                />
                {/* 实际里程柱 */}
                <span
                  className={`absolute inset-x-0 bottom-0 rounded-t-[2px] ${beats ? 'bg-emerald-500' : 'bg-amber-500'}`}
                  style={{ height: `${Math.max(pct(m.actualKm), 2)}%` }}
                />
              </button>
            )
          })}
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-slate-400" data-testid="energy-monthly-x-labels">
          <span className="num">{fmtMonth(ticks[0].month, lang)}</span>
          <span className="num">{fmtMonth(ticks[1].month, lang)}</span>
          <span className="num">{fmtMonth(ticks[2].month, lang)}</span>
        </div>
        {active && tip && (
          <div
            className="pointer-events-none absolute -top-1.5 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-white/10 bg-base-900/95 px-3 py-2 text-xs shadow-lg"
            style={{ left: `${tip.x}px` }}
            data-testid="energy-monthly-tooltip"
            role="tooltip"
          >
            <span className="num font-medium text-slate-200">{fmtMonth(active.month, lang)}</span>
            <span className="num ml-2 text-slate-300">{t('energy.monthly.actual', '实际')} {active.actualKm} km</span>
            <span className="num ml-2 text-slate-400">{t('energy.monthly.rated', '表显消耗')} {active.ratedKm} km</span>
            <span className={`num ml-2 ${active.ratio >= 1 ? 'text-emerald-400' : 'text-amber-400'}`}>{Math.round(active.ratio * 100)}%</span>
          </div>
        )}
      </div>

      {/* 图例：柱/刻线两标记 + 极性说明 */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-emerald-500" />
          {t('energy.monthly.actual', '实际里程')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-3 rounded-full bg-white/70" />
          {t('energy.monthly.rated', '表显消耗（预估）')}
        </span>
        <span className="ml-auto text-slate-500">{t('energy.monthly.legendHint', '柱越过刻线 = 跑赢表显')}</span>
      </div>
    </div>
  )
}
