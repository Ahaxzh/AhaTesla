import { useEffect, useMemo, useRef, useState } from 'react'
import type { HeatmapData } from '@/types'

/**
 * 用车日历热力图 v4 —— 有界弹性格子（PC / iPad / iPhone 三端适配）。
 * 设计要点：
 * - 格子尺寸 clamp(9px, 容器均分, 22px)（.heatmap-box 容器查询量宽；桌面下限 9px 保证一年 53 列不溢出，触屏 13px 保证可点），
 *   PC/iPad 得到合理密度；iPhone 放不下时横向滚动（GitHub 移动端同款），默认滚到最新（最右）
 * - 月份标签按列索引绝对定位，任何列距下不重叠、不截断
 * - tooltip 跟随格子真实位置（hover / 点按 / 键盘 focus 三通道），左右缘自动钳制
 * - 文字下限 10px、次要文字 slate-400（深底可读）；图例窄屏降级为「少▪▪▪▪▪多」
 * - 色阶：单色相顺序 ramp 亮度单调；0km 中性色、未来格透明、今天白描边
 */
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']
const WEEK_CN = '日一二三四五六'

/** 量化分档（km）：levelOf 阈值与图例区间文案一致 */
const LEVEL_LEGEND = ['0', '1-10', '11-30', '31-60', '100+']

/** 顺序色阶（单色相，亮度单调递增；0 档中性色 = 未出行，与玻璃卡底可辨） */
const LEVEL_COLORS = ['#202631', '#1B4470', '#1E6FAE', '#2E97DC', '#7CC8FC']

function levelOf(km: number): number {
  if (km <= 0) return 0
  if (km <= 10) return 1
  if (km <= 30) return 2
  if (km <= 60) return 3
  return 4
}

function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** tooltip 用中文日期 + 星期 */
function fmtDateCn(date: string): string {
  const dt = new Date(`${date}T00:00:00`)
  if (Number.isNaN(dt.getTime())) return date
  return `${dt.getMonth() + 1}月${dt.getDate()}日 周${WEEK_CN[dt.getDay()]}`
}

interface Tip {
  x: number
  y: number
  date: string
  km: number
}

/** 星期分布柱状图：数值标注 + 最大值高亮（文字不着数据色，靠柱子本身强调） */
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
        <p className="text-xs font-medium text-slate-300">星期分布</p>
        <p className="text-[10px] text-slate-500">km</p>
      </div>
      <div className="flex h-24 items-stretch gap-1.5">
        {sums.map((s, i) => {
          const isBest = i === best && s.km > 0
          return (
            <div key={i} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
              {s.km > 0 && (
                <span className={`num text-[10px] leading-none ${isBest ? 'font-semibold text-slate-200' : 'text-slate-400'}`}>
                  {Math.round(s.km)}
                </span>
              )}
              <div
                className="w-full max-w-[22px] rounded-t-[4px] transition-all"
                style={{
                  height: s.km > 0 ? `${Math.max((s.km / maxKmSum) * 100, 8)}%` : '3px',
                  background: isBest ? '#7CC8FC' : s.km > 0 ? '#1E6FAE' : '#2A313C',
                }}
                title={`周${WEEKDAY_LABELS[i]} · ${s.km.toFixed(0)} km · ${s.days} 天出行`}
              />
              <span className={`text-[10px] leading-none ${isBest ? 'font-medium text-slate-200' : 'text-slate-400'}`}>
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
  const [tip, setTip] = useState<Tip | null>(null)
  const today = todayStr()
  const isYear = data.days >= 300
  const scrollRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)

  // 按周分列（周一行首）+ 月份标签列索引
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

  // 默认滚到最右（最新日期）
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [data])

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

  /** tooltip 定位：相对网格宿主（随横向滚动一起移动），左右缘钳制防溢出 */
  const showTip = (el: HTMLButtonElement, date: string, km: number) => {
    const host = hostRef.current
    if (!host) return
    const hr = host.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const cx = r.left - hr.left + r.width / 2
    setTip({
      x: Math.min(Math.max(cx, 56), Math.max(hr.width - 56, 56)),
      y: r.top - hr.top,
      date,
      km,
    })
  }

  return (
    <section className="glass-card p-5" data-testid="heatmap-card">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-200">用车日历</h2>
        {/* 时间范围切换（近3月 / 近一年），复用全局分段控件样式 */}
        <div className="seg">
          {[
            { d: 90, label: '近3月' },
            { d: 365, label: '近一年' },
          ].map(({ d, label }) => (
            <button
              key={d}
              onClick={() => onDaysChange?.(d)}
              className={`seg-item !flex-none ${((d === 365) === isYear) ? 'seg-item-active' : ''}`}
              data-testid={`heatmap-range-${d}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:gap-4">
        {/* 左：热力图（有界弹性格子 + 图例 + 统计条） */}
        <div className="heatmap-box min-w-0 flex-1">
          <div ref={scrollRef} className="overflow-x-auto" data-testid="heatmap-scroll">
            <div
              ref={hostRef}
              className="relative w-max"
              style={
                {
                  '--cell': `clamp(var(--cell-min, 11px), calc((100cqw - 20px - ${(columns.length - 1) * 2}px) / ${columns.length}), 22px)`,
                } as React.CSSProperties
              }
              onMouseLeave={() => setTip(null)}
            >
              {/* 月份标签：按列索引绝对定位（列距 ≥4 周必然容得下，永不重叠） */}
              <div className="relative mb-1.5 ml-[20px] h-[14px]">
                {monthLabels.map((m) => (
                  <span
                    key={`${m.label}-${m.col}`}
                    className="absolute top-0 text-[10px] leading-[14px] text-slate-400"
                    style={{ left: `calc(${m.col} * (var(--cell) + 2px))` }}
                  >
                    {m.label}
                  </span>
                ))}
              </div>
              <div className="flex" data-testid="heatmap-grid" data-cols={columns.length}>
                {/* 星期标签列（一/三/五），行高与格子同步 */}
                <div className="mr-[3px] flex w-[17px] flex-col">
                  {WEEKDAY_LABELS.map((d, i) => (
                    <span
                      key={d}
                      className={`flex items-center justify-center text-[10px] leading-none ${
                        i % 2 === 0 ? 'text-slate-400' : 'opacity-0'
                      } ${i < 6 ? 'mb-[2px]' : ''}`}
                      style={{ height: 'var(--cell)' }}
                    >
                      {d}
                    </span>
                  ))}
                </div>
                {columns.map((column, ci) => (
                  <div
                    key={ci}
                    className="flex flex-col"
                    style={{ width: 'var(--cell)', gap: '2px', marginRight: ci < columns.length - 1 ? '2px' : 0 }}
                  >
                    {Array.from({ length: 7 }, (_, ri) => {
                      const cell = column[ri]
                      // 前置补位 / 无数据：透明占位
                      if (!cell || cell.distanceKm < 0 || cell.date > today) {
                        return (
                          <span
                            key={ri}
                            className="rounded-[3px]"
                            style={{ width: 'var(--cell)', height: 'var(--cell)' }}
                          />
                        )
                      }
                      const level = levelOf(cell.distanceKm)
                      const isToday = cell.date === today
                      return (
                        <button
                          key={ri}
                          className={`rounded-[3px] transition-[filter] hover:brightness-[1.3] focus-visible:outline-none ${
                            isToday ? 'ring-1 ring-white/90' : ''
                          }`}
                          style={{ width: 'var(--cell)', height: 'var(--cell)', background: LEVEL_COLORS[level] }}
                          aria-label={`${cell.date} ${cell.distanceKm.toFixed(1)} km`}
                          data-testid="heatmap-cell"
                          data-level={level}
                          onMouseEnter={(e) => showTip(e.currentTarget, cell.date, cell.distanceKm)}
                          onFocus={(e) => showTip(e.currentTarget, cell.date, cell.distanceKm)}
                          onBlur={() => setTip(null)}
                          onClick={(e) =>
                            tip?.date === cell.date
                              ? setTip(null)
                              : showTip(e.currentTarget, cell.date, cell.distanceKm)
                          }
                        />
                      )
                    })}
                  </div>
                ))}
              </div>
              {/* tooltip：跟随格子，值为主、日期为辅 */}
              {tip && (
                <div
                  data-testid="heatmap-hover"
                  role="tooltip"
                  className="pointer-events-none absolute z-10 flex items-baseline gap-1.5 whitespace-nowrap rounded-lg border border-white/10 bg-[#0C0E12]/95 px-2.5 py-1.5 shadow-overlay"
                  style={{ left: tip.x, top: tip.y, transform: 'translate(-50%, calc(-100% - 8px))' }}
                >
                  <span className="num text-xs font-semibold text-white">
                    {tip.km > 0 ? `${tip.km.toFixed(1)} km` : '未出行'}
                  </span>
                  <span className="num text-[11px] text-slate-400">{fmtDateCn(tip.date)}</span>
                </div>
              )}

              {/* 图例：置于网格宿主内、右对齐到网格右缘；窄屏只显示 少→多，≥sm 展开量化区间 */}
              <div className="mt-3 flex w-full items-center justify-end gap-2" data-testid="heatmap-legend">
                <span className="text-[10px] text-slate-400">少</span>
                {LEVEL_COLORS.map((c, i) => (
                  <span key={i} className="flex items-center gap-1">
                    <span
                      className="h-3 w-3 rounded-[3px]"
                      style={{ background: c }}
                      title={`${LEVEL_LEGEND[i]} km${i === 0 ? '（未出行）' : ''}`}
                    />
                    <span className="hidden text-[10px] text-slate-400 sm:inline">{LEVEL_LEGEND[i]}</span>
                  </span>
                ))}
                <span className="text-[10px] text-slate-400">多</span>
                <span className="hidden text-[10px] text-slate-500 sm:inline">km</span>
              </div>
            </div>
          </div>

          {/* 统计条：紧凑四格，替代原右侧竖排大间距面板 */}
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4" data-testid="heatmap-stats">
            <div>
              <dt className="text-[11px] text-slate-400">本期里程</dt>
              <dd className="num mt-0.5 text-[15px] font-semibold text-slate-100">
                {stats.totalKm.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}
                <span className="ml-0.5 text-[11px] font-normal text-slate-400">km</span>
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-slate-400">出行天数</dt>
              <dd className="num mt-0.5 text-[15px] font-semibold text-slate-100">
                {stats.activeDays}
                <span className="ml-0.5 text-[11px] font-normal text-slate-400">/ {stats.totalDays} 天</span>
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-slate-400">最高单日</dt>
              <dd className="num mt-0.5 text-[15px] font-semibold text-slate-100">
                {stats.maxDayKm.toFixed(0)}
                <span className="ml-0.5 text-[11px] font-normal text-slate-400">km</span>
              </dd>
              {stats.maxDayDate && (
                <p className="num mt-0.5 text-[11px] text-slate-500">{stats.maxDayDate.slice(5)}</p>
              )}
            </div>
            <div>
              <dt className="text-[11px] text-slate-400">日均（出行日）</dt>
              <dd className="num mt-0.5 text-[15px] font-semibold text-slate-100">
                {stats.avgKm.toFixed(0)}
                <span className="ml-0.5 text-[11px] font-normal text-slate-400">km</span>
              </dd>
            </div>
          </dl>
        </div>

        {/* 右：星期分布（PC 侧栏 / 移动端整行） */}
        <div className="shrink-0 xl:w-52 xl:border-l xl:border-white/[0.06] xl:pl-4">
          <WeekdayBars daysData={cells} />
        </div>
      </div>
    </section>
  )
}
