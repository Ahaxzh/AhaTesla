import { useMemo, useState } from 'react'
import type { HeatmapData } from '@/types'

/**
 * P2 模块4【Grafana Mileage 提炼】用车日历热力图 — v2.2 GitHub 贡献图风格。
 * 升级：月份标签行 + 右侧统计面板（总里程/出行天数/最高单日/日均/
 * 星期分布迷你柱状图），布局 flex 自适应，消灭右侧留白。
 */
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

function intensity(km: number, maxKm: number): number {
  if (km <= 0) return 0
  if (maxKm <= 0) return 1
  const ratio = km / maxKm
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

const LEVEL_CLASS = [
  'bg-white/[0.04]',
  'bg-sky-500/25',
  'bg-sky-500/45',
  'bg-sky-500/70',
  'bg-sky-400',
]

/** 星期分布条形图：哪天最爱开车 */
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
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] text-slate-500">星期分布</span>
        {sums[best]?.km > 0 && (
          <span className="text-[11px] font-medium text-sky-400">周{WEEKDAY_LABELS[best]}最多</span>
        )}
      </div>
      <div className="flex h-16 items-end gap-1">
        {sums.map((s, i) => (
          <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
            <div
              className={`w-full flex-none rounded-[3px] transition-all ${i === best && s.km > 0 ? 'bg-sky-400' : 'bg-sky-500/40'}`}
              style={{ height: `${Math.max((s.km / maxKmSum) * 100, s.km > 0 ? 6 : 2)}%` }}
              title={`周${WEEKDAY_LABELS[i]} · ${s.km.toFixed(0)} km · ${s.days} 天`}
            />
            <span className={`flex-none text-[9px] ${i === best && s.km > 0 ? 'text-sky-400' : 'text-slate-600'}`}>
              {WEEKDAY_LABELS[i]}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function HeatmapCalendar({ data }: { data: HeatmapData }) {
  const [hover, setHover] = useState<{ date: string; km: number } | null>(null)

  // 按周分列：周一为行首 + 月份标签位置
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
    const m = dt.getMonth()
    if (!Number.isNaN(dt.getTime()) && m !== lastMonth) {
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

  // 统计面板数据
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
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-200">用车日历</h2>
        <span className="text-[11px] text-slate-500">最近 {data.days} 天 · 按日里程</span>
      </div>

      <div className="flex flex-col gap-5 lg:flex-row lg:items-stretch">
        {/* 左：GitHub 风贡献图 */}
        <div className="min-w-0 flex-1">
          <div className="overflow-x-auto pb-1">
            {/* 月份标签：与列同宽的自适应行（每列一个 flex 槽，月初打标签） */}
            <div className="mb-1 ml-[18px] flex gap-[3px]">
              {columns.map((_column, ci) => {
                const label = monthLabels.find((m) => m.col === ci)
                return (
                  <div key={ci} className="min-w-0 flex-1">
                    {label && <span className="block truncate text-[9px] text-slate-500">{label.label}</span>}
                  </div>
                )
              })}
            </div>
            <div className="flex gap-[3px]" data-testid="heatmap-grid">
              {/* 星期标签列（隔行显示防拥挤） */}
              <div className="flex flex-col gap-[3px] pr-1">
                {WEEKDAY_LABELS.map((d, i) => (
                  <span
                    key={d}
                    className={`flex aspect-square w-3.5 items-center justify-center text-[9px] ${i % 2 === 0 ? 'text-slate-600' : 'opacity-0'}`}
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
                    const level = intensity(cell.distanceKm, data.maxKm)
                    return (
                      <button
                        key={ri}
                        className={`aspect-square w-full rounded-[3px] transition ${LEVEL_CLASS[level]} ${hover?.date === cell.date ? 'ring-1 ring-white/60' : ''}`}
                        aria-label={`${cell.date} ${cell.distanceKm.toFixed(1)} km`}
                        data-testid="heatmap-cell"
                        data-level={level}
                        onMouseEnter={() => setHover({ date: cell.date, km: cell.distanceKm })}
                        onMouseLeave={() => setHover(null)}
                        onClick={() => setHover({ date: cell.date, km: cell.distanceKm })}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between">
            <span className="num text-[11px] text-slate-400" data-testid="heatmap-hover">
              {hover ? `${hover.date} · ${hover.km.toFixed(1)} km` : '悬停/点击查看单日'}
            </span>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-slate-600">少</span>
              {LEVEL_CLASS.map((cls, i) => (
                <span key={i} className={`h-2.5 w-2.5 rounded-[2px] ${cls}`} />
              ))}
              <span className="text-[10px] text-slate-600">多</span>
            </div>
          </div>
        </div>

        {/* 右：统计面板（消灭留白） */}
        <div
          className="grid shrink-0 grid-cols-2 gap-x-5 gap-y-3 border-white/[0.06] lg:w-56 lg:grid-cols-1 lg:border-l lg:pl-5"
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
          <div className="col-span-2 mt-1 lg:col-span-1">
            <WeekdayBars daysData={cells} />
          </div>
        </div>
      </div>
    </section>
  )
}
