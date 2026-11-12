import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { HeatmapCalendar } from '@/components/HeatmapCalendar'
import { I18nProvider } from '@/i18n'
import type { ReactElement } from 'react'
import type { HeatmapData } from '@/types'

/** 组件 v5 起文案走 useI18n，测试需包 Provider（默认 zh，断言中文文案不变） */
function renderCalendar(ui: ReactElement) {
  return render(<I18nProvider>{ui}</I18nProvider>)
}

/** 确定性造数：LCG 种子=距今天数；今天固定 42.5 km、第 8 天前固定 152.3 km（最高单日） */
function makeData(days: number): HeatmapData {
  const out: { date: string; distanceKm: number }[] = []
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    const r = ((i * 2654435761) % 1000) / 1000
    const weekend = d.getDay() === 0 || d.getDay() === 6
    let km = 0
    if (i === 0) km = 42.5
    else if (i === 7) km = 152.3
    else if (r >= 0.25) km = Math.round((weekend ? 40 + r * 90 : 5 + r * 50) * 10) / 10
    out.push({ date, distanceKm: km })
  }
  return { days, maxKm: 152.3, daysData: out }
}

const todayDate = (() => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()

describe('HeatmapCalendar', () => {
  it('渲染网格/图例/统计条/星期分布，格子数与天数一致', () => {
    const data = makeData(90)
    renderCalendar(<HeatmapCalendar data={data} />)
    const grid = screen.getByTestId('heatmap-grid')
    expect(within(grid).getAllByTestId('heatmap-cell')).toHaveLength(90)
    // 图例：少→多 + 5 档色块（量化区间在 <sm 隐藏，用 title 断言语义）
    const legend = screen.getByTestId('heatmap-legend')
    expect(legend).toHaveTextContent('少')
    expect(legend).toHaveTextContent('多')
    // 统计条：口径来自造数（最高单日 152.3 → 152；总天数 90）
    const stats = screen.getByTestId('heatmap-stats')
    expect(stats).toHaveTextContent('152')
    expect(stats).toHaveTextContent('/ 90 天')
    // 星期分布 7 列
    expect(screen.getByTestId('heatmap-weekday-bars')).toHaveTextContent('星期分布')
    expect(screen.getByTestId('heatmap-weekday-bars').querySelectorAll('[title^="周"]').length).toBe(7)
  })

  it('今天的格子有白描边（ring）与 aria 语义', () => {
    renderCalendar(<HeatmapCalendar data={makeData(90)} />)
    const today = screen.getByLabelText(`${todayDate} 42.5 km`)
    expect(today).toHaveAttribute('data-level', '3')
    expect(today.className).toContain('ring')
  })

  it('点按格子出现 tooltip（值为强、日期为辅），再点同一格关闭', () => {
    renderCalendar(<HeatmapCalendar data={makeData(90)} />)
    const today = screen.getByLabelText(`${todayDate} 42.5 km`)
    fireEvent.click(today)
    const tip = screen.getByTestId('heatmap-hover')
    expect(tip).toHaveTextContent('42.5 km')
    const dt = new Date(`${todayDate}T00:00:00`)
    const weekCn = '日一二三四五六'[dt.getDay()]
    expect(tip).toHaveTextContent(`${dt.getMonth() + 1}月${dt.getDate()}日 周${weekCn}`)
    fireEvent.click(today)
    expect(screen.queryByTestId('heatmap-hover')).not.toBeInTheDocument()
  })

  it('未出行日 tooltip 显示「未出行」而非 0 km', () => {
    const data = makeData(90)
    const zeroDay = data.daysData.find((d) => d.distanceKm === 0)!
    renderCalendar(<HeatmapCalendar data={data} />)
    fireEvent.click(screen.getByLabelText(`${zeroDay.date} 0.0 km`))
    expect(screen.getByTestId('heatmap-hover')).toHaveTextContent('未出行')
  })

  it('范围切换按钮（近7天/近3月/近一年）触发 onDaysChange', () => {
    const onDaysChange = vi.fn()
    renderCalendar(<HeatmapCalendar data={makeData(90)} onDaysChange={onDaysChange} />)
    fireEvent.click(screen.getByTestId('heatmap-range-365'))
    expect(onDaysChange).toHaveBeenCalledWith(365)
    fireEvent.click(screen.getByTestId('heatmap-range-90'))
    expect(onDaysChange).toHaveBeenCalledWith(90)
    fireEvent.click(screen.getByTestId('heatmap-range-7'))
    expect(onDaysChange).toHaveBeenCalledWith(7)
  })

  it('近一年数据同样渲染完整（365 格、月份标签随列定位）', () => {
    renderCalendar(<HeatmapCalendar data={makeData(365)} />)
    const grid = screen.getByTestId('heatmap-grid')
    expect(within(grid).getAllByTestId('heatmap-cell')).toHaveLength(365)
    expect(Number(grid.getAttribute('data-cols'))).toBeGreaterThanOrEqual(52)
    expect(screen.getByTestId('heatmap-stats')).toHaveTextContent('/ 365 天')
  })

  it('近7天切换为每日条形紧凑视图（7 行、无周历网格、无星期分布）', () => {
    renderCalendar(<HeatmapCalendar data={makeData(7)} />)
    // 紧凑条形：7 行、每天一条 bar；今天 42.5 是最高单日 → 行的 bar 满宽
    const rows = screen.getAllByTestId('heatmap-daily-row')
    expect(rows).toHaveLength(7)
    expect(screen.getAllByTestId('heatmap-daily-bar')).toHaveLength(7)
    expect(screen.queryByTestId('heatmap-grid')).not.toBeInTheDocument()
    expect(screen.queryByTestId('heatmap-weekday-bars')).not.toBeInTheDocument()
    // 统计条仍在（两种视图共用）；最高单日按 7 天窗口内数据推导
    expect(screen.getByTestId('heatmap-stats')).toHaveTextContent('/ 7 天')
    const data = makeData(7)
    const maxKm = Math.round(Math.max(...data.daysData.map((d) => d.distanceKm)))
    expect(screen.getByTestId('heatmap-stats')).toHaveTextContent(String(maxKm))
    // 未出行日显示文案而非 0 km
    const zeroDay = data.daysData.find((d) => d.distanceKm === 0)
    if (zeroDay) expect(screen.getByText('未出行')).toBeTruthy()
  })
})
