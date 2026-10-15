import { useState } from 'react'
import type { HeatmapData } from '@/types'

/**
 * P2 模块4【Grafana Mileage 提炼】用车日历热力图。
 * GitHub 贡献图风格：最近 3 个月矩阵（横轴周、纵轴星期），颜色深度 = 当天里程。
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

export function HeatmapCalendar({ data }: { data: HeatmapData }) {
  const [hover, setHover] = useState<{ date: string; km: number } | null>(null)

  // 按周分列：周一为行首
  const cells = data.daysData
  const columns: (typeof cells)[] = []
  let col: typeof cells = []
  // 对齐：第一列补齐到周一
  const firstDate = new Date(`${cells[0]?.date ?? ''}T00:00:00`)
  const firstDow = Number.isNaN(firstDate.getTime()) ? 0 : (firstDate.getDay() + 6) % 7
  for (let i = 0; i < firstDow; i++) col.push({ date: '', distanceKm: -1 })
  for (const day of cells) {
    col.push(day)
    if (col.length === 7) {
      columns.push(col)
      col = []
    }
  }
  if (col.length > 0) columns.push(col)

  return (
    <section className="glass-card p-5" data-testid="heatmap-card">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-200">用车日历</h2>
        <span className="text-[11px] text-slate-500">最近 {data.days} 天 · 按日里程</span>
      </div>
      <p className="mb-4 text-xs text-slate-500">颜色越深当天行驶里程越多，点击查看当日里程</p>

      <div className="overflow-x-auto pb-1">
        <div className="flex gap-[3px]" data-testid="heatmap-grid">
          {/* 星期标签列 */}
          <div className="flex flex-col gap-[3px] pr-1">
            {WEEKDAY_LABELS.map((d) => (
              <span key={d} className="flex h-3.5 w-3.5 items-center justify-center text-[9px] text-slate-600">
                {d}
              </span>
            ))}
          </div>
          {columns.map((column, ci) => (
            <div key={ci} className="flex flex-col gap-[3px]">
              {Array.from({ length: 7 }, (_, ri) => {
                const cell = column[ri]
                if (!cell || cell.distanceKm < 0) {
                  return <span key={ri} className="h-3.5 w-3.5" />
                }
                const level = intensity(cell.distanceKm, data.maxKm)
                return (
                  <button
                    key={ri}
                    className={`h-3.5 w-3.5 rounded-[3px] transition ${LEVEL_CLASS[level]} ${hover?.date === cell.date ? 'ring-1 ring-white/60' : ''}`}
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
    </section>
  )
}
