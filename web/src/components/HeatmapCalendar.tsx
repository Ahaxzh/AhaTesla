import { useMemo, useState } from 'react'
import type { HeatmapData } from '@/types'

/**
 * 用车日历热力图 — GitHub 贡献图风格 v3。
 * 设计要点（对比 GitHub / Grafana 打磨）：
 * - 量化图例：每档标区间 km 值，不再只有"少—多"
 * - 0 km / 未来日期 语义区分（未来格不渲染底色，0km 保留极淡底色）
 * - 今天格子白色描边标记
 * - tooltip 跟随焦点列，不再固定左下角
 * - 星期分布柱状图带数值标注、高亮最大值、标题独立行不与柱重叠
 */
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

/** 量化分档（km）：与图例区间文案一致 */
const LEVEL_THRESHOLDS = [0, 10, 30, 60, 100]

function levelOf(km: number): number {
  if (km <= 0) return 0
  if (km <= 10) return 1
  if (km <= 30) return 2
  if (km <= 60) return 3
  return 4
}

/** 深色底上相邻档位对比强化：0 档近透明、末档全亮 */
const LEVEL_CLASS = [
  'bg-white/[0.05]',
  'bg-sky-500/30',
  'bg-sky-500/55',
  'bg-sky-500/80',
  'bg-sky-400',
]

function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 星期分布柱状图：数值标注 + 最大值高亮 */
function WeekdayBars({ daysData }: { daysData: HeatmapData['daysData'] }) {
  const sums = useMemo(() => {
    const acc = Array.from({ length: 7 }, () => ({ km: 0, days: 0 }))
    for (const d of daysData) {
      const dt = new Date(`${d.date}T00:00:00`)
      if (Number.isNaN(dt.getTime()) || d.distanceKm <= 0) continue
      const dow = (dt.getDay() + 6) % 7
      acc[dow].km += d.distanceKm
      acc[dow].days += 1
    }
    return acc
  }, [daysData])
  const maxKmSum = Math.max(...sums.map((s) => s.km), 1)
  const best = sums.findIndex((s) => s.km === Math.max(...sums.map((x) => x.km)))

  return (
    <div data-testid="heatmap-weekday-bars">
      <p className="mb-2 text-[11px] text-slate-500">星期分布（km）</p>
      <div className="flex h-20 items-stretch gap-1.5">
        {sums.map((s, i) => {
          const isBest = i === best && s.km > 0
          return (
            <div key={i} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
              {s.km > 0 && (
                <span className={`num text-[9px] leading-none ${isBest ? 'font-semibold text-sky-300' : 'text-slate-500'}`}>
                  {Math.round(s.km)}
                </span>
              )}
              <div
                className={`w-full rounded-t-[3px] transition-all ${isBest ? 'bg-sky-400' : 'bg-sky-500/35'}`}
                style={{ height: `${Math.max((s.km / maxKmSum) * 100, s.km > 0 ? 8 : 2)}%` }}
                title={`周${WEEKDAY_LABELS[i]} · ${s.km.toFixed(0)} km · ${s.days} 天出行`}
              />
              <span className={`flex-none text-[9px] ${isBest ? 'font-medium text-sky-400' : 'text-slate-600'}`}>
                {WEEKDAY_LABELS[i]}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function HeatmapCalendar({ data, onDaysChange }: { data: HeatmapData; onDaysChange?: (d: number) => void }) {
  const [hoverCol, setHoverCol] = useState<{ col: number; date: string; km: number } | null>(null)
  const today = todayStr()
  const isYear = data.days >= 300

  // 按周分列（周一行首）+ 月份标签位置
  const cells = data.daysData
  const columns: (typeof cells)[] = []
  const monthLabels: { col: number; label: string }[] = []
  let col: typeof cells = []
  const firstDate = new Date(`${cells[0]?.date ?? ''}T00:00:00`)
  const firstDow = Number.isNaN(firstDate.getTime()) ? 0 : (firstDate.getDay() + 6) % 7
  for (let i = 0; i < firstDow; i++) col.push({ date: '', distanceKm: -1 })
  let lastMonth = -1
  for (const day of cells) {
    const dt = new Date(`${day.date}T00:00:00`)
    if (Number.isNaN(dt.getTime())) continue
    const m = dt.getMonth()
    if (m !== lastMonth) {
      monthLabels.push({ col: columns.length, label: `${m + 1}月` })
      lastMonth = m
    }
    col.push(day)
    if (col.length === 7) {
      columns.push(col)
      col = []
    }
  }
  if (col.length > 0) columns.push(col)

  const stats = useMemo(() => {
    const active = cells.filter((d) => d.distanceKm > 0)
    const total = active.reduce((s, d) => s + d.distanceKm, 0)
    const maxDay = active.reduce(
      (a, b) => (b.distanceKm > a.distanceKm ? b : a),
      active[0] ?? { date: '', distanceKm: 0 },
    )
    return {
      totalKm: total,
      activeDays: active.length,
      totalDays: cells.length,
      maxDayKm: maxDay?.distanceKm ?? 0,
      maxDayDate: maxDay?.date ?? '',
      avgKm: active.length ? total / active.length : 0,
    }
  }, [cells])

  return (
    <section className="glass-card p-5" data-testid="heatmap-card">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-200">用车日历</h2>
        {/* 时间范围切换（近3月 / 近一年） */}
        <div className="flex items-center gap-1 rounded-lg bg-white/[0.04] p-0.5">
          {[
            { d: 90, label: '近3月' },
            { d: 365, label: '近一年' },
          ].map(({ d, label }) => (
            <button
              key={d}
              onClick={() => onDaysChange?.(d)}
              className={`rounded-md px-2 py-0.5 text-[10px] transition ${
                (d === 365) === isYear ? 'bg-white/[0.08] font-medium text-slate-100' : 'text-slate-500 hover:text-slate-300'
              }`}
              data-testid={`heatmap-range-${d}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-stretch">
        {/* 左：热力图 */}
        <div className="min-w-0 flex-1">
          <div>
            {/* 月份标签：与列同宽对齐 */}
            <div className="mb-1.5 ml-[20px] flex gap-[3px]">
              {columns.map((_c, ci) => {
                const label = monthLabels.find((m) => m.col === ci)
                return (
                  <div key={ci} className="min-w-0 flex-1">
                    {label && <span className="block truncate text-[9px] text-slate-500">{label.label}</span>}
                  </div>
                )
              })}
            </div>
            <div className="flex gap-[3px]" data-testid="heatmap-grid">
              <div className="mr-0.5 flex w-4 flex-col gap-[3px]">
                {WEEKDAY_LABELS.map((d, i) => (
                  <span
                    key={d}
                    className={`flex aspect-square items-center justify-center text-[8px] ${i % 2 === 0 ? 'text-slate-600' : 'opacity-0'}`}
                  >
                    {d}
                  </span>
                ))}
              </div>
              {columns.map((column, ci) => (
                <div key={ci} className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  {Array.from({ length: 7 }, (_, ri) => {
                    const cell = column[ri]
                    if (!cell || cell.distanceKm < 0) {
                      return <span key={ri} className="aspect-square w-full" />
                    }
                    const level = levelOf(cell.distanceKm)
                    const isToday = cell.date === today
                    const isHover = hoverCol?.col === ci && hoverCol.date === cell.date
                    return (
                      <button
                        key={ri}
                        className={`aspect-square w-full rounded-[3px] transition ${LEVEL_CLASS[level]} ${
                          isToday ? 'ring-1 ring-white/70' : ''
                        } ${isHover ? 'outline outline-1 outline-white/90' : ''}`}
                        aria-label={`${cell.date} ${cell.distanceKm.toFixed(1)} km`}
                        data-testid="heatmap-cell"
                        data-level={level}
                        onMouseEnter={() => setHoverCol({ col: ci, date: cell.date, km: cell.distanceKm })}
                        onMouseLeave={() => setHoverCol(null)}
                        onClick={() => setHoverCol({ col: ci, date: cell.date, km: cell.distanceKm })}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* 读数（跟随焦点列）+ 量化图例 */}
          <div className="relative mt-3 h-5">
            {hoverCol ? (
              <span
                className="num absolute whitespace-nowrap text-[11px] font-medium text-slate-200"
                style={{
                  left: `calc(20px + ${hoverCol.col} * (100% - 20px) / ${columns.length})`,
                }}
                data-testid="heatmap-hover"
              >
                {hoverCol.date.slice(5)} · {hoverCol.km > 0 ? `${hoverCol.km.toFixed(1)} km` : '未出行'}
              </span>
            ) : (
              <span className="num absolute text-[11px] text-slate-600" data-testid="heatmap-hover">
                悬停查看单日
              </span>
            )}
            <div className="absolute right-0 top-0 flex items-center gap-1">
              {LEVEL_THRESHOLDS.map((t, i) => {
                const upper = i < LEVEL_THRESHOLDS.length - 1 ? LEVEL_THRESHOLDS[i + 1] : null
                return (
                  <span key={i} className="flex items-center gap-0.5">
                    <span className={`h-2.5 w-2.5 rounded-[2px] ${LEVEL_CLASS[i]}`} />
                    <span className="num text-[8px] text-slate-600">
                      {upper ? `${t}-${upper}` : `${t}+`}
                    </span>
                  </span>
                )
              })}
              <span className="num text-[8px] text-slate-600">km</span>
            </div>
          </div>
        </div>

        {/* 右：统计面板 */}
        <div
          className="grid shrink-0 grid-cols-2 gap-x-5 gap-y-3 border-white/[0.06] lg:w-52 lg:grid-cols-1 lg:border-l lg:pl-5"
          data-testid="heatmap-stats"
        >
          <div>
            <p className="text-[11px] text-slate-500">本期里程</p>
            <p className="num text-base font-semibold text-slate-100">
              {stats.totalKm.toFixed(0)} <span className="text-[11px] font-normal text-slate-500">km</span>
            </p>
          </div>
          <div>
            <p className="text-[11px] text-slate-500">出行天数</p>
            <p className="num text-base font-semibold text-slate-100">
              {stats.activeDays}
              <span className="text-[11px] font-normal text-slate-500"> / {stats.totalDays} 天</span>
            </p>
          </div>
          <div>
            <p className="text-[11px] text-slate-500">最高单日</p>
            <p className="num text-base font-semibold text-slate-100">
              {stats.maxDayKm.toFixed(0)} <span className="text-[11px] font-normal text-slate-500">km</span>
            </p>
            {stats.maxDayDate && <p className="num text-[10px] text-slate-600">{stats.maxDayDate.slice(5)}</p>}
          </div>
          <div>
            <p className="text-[11px] text-slate-500">日均（出行日）</p>
            <p className="num text-base font-semibold text-slate-100">
              {stats.avgKm.toFixed(0)} <span className="text-[11px] font-normal text-slate-500">km</span>
            </p>
          </div>
          <div className="col-span-2 lg:col-span-1">
            <WeekdayBars daysData={cells} />
          </div>
        </div>
      </div>
    </section>
  )
}
