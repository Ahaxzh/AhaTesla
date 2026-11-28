import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DailyActivityChart } from '@/components/DailyActivityChart'
import { I18nProvider } from '@/i18n'
import type { ReactElement } from 'react'
import type { TripsOverview } from '@/types'

/** 组件文案走 useI18n，测试需包 Provider（默认 zh，断言中文文案） */
function renderChart(ui: ReactElement) {
  return render(<I18nProvider>{ui}</I18nProvider>)
}

/** 确定性造数：固定 7 天（2026-11-08 周日 ~ 11-14 周六），峰值在 11-10（120 分钟） */
function makeOverview(bucket: 'day' | 'week' = 'day'): TripsOverview {
  const pts = [
    { date: '2026-11-08', driveMin: 60, chargeMin: 30, trips: 2 },
    { date: '2026-11-09', driveMin: 0, chargeMin: 0, trips: 0 },
    { date: '2026-11-10', driveMin: 120, chargeMin: 0, trips: 3 },
    { date: '2026-11-11', driveMin: 30, chargeMin: 60, trips: 1 },
    { date: '2026-11-12', driveMin: 0, chargeMin: 45, trips: 0 },
    { date: '2026-11-13', driveMin: 90, chargeMin: 0, trips: 2 },
    { date: '2026-11-14', driveMin: 15, chargeMin: 15, trips: 1 },
  ]
  return {
    tripCount: 9,
    distanceKm: 300,
    durationMin: 315,
    energyKwh: 50,
    cost: 30,
    maxSpeedKmh: 100,
    stateShare: { driveMin: 315, chargeMin: 150, parkedMin: 9615 },
    daily: { bucket, points: bucket === 'day' ? pts : [{ date: '2026-11-09', driveMin: 315, chargeMin: 150, trips: 9 }] },
  }
}

describe('DailyActivityChart（v0.4 每日活跃柱状图）', () => {
  it('柱数=桶数，零活跃日降级为基线 stub；图例含总时长；峰值指向最活跃日', () => {
    renderChart(<DailyActivityChart overview={makeOverview()} />)
    expect(screen.getAllByTestId('daily-bar')).toHaveLength(7)
    // 仅 11-09 全零（11-12 有充电 45 分，不算零日）
    expect(screen.getAllByTestId('daily-bar').filter((b) => b.dataset.zero === 'true')).toHaveLength(1)
    // 图例：行驶 315 分 = 5小时15分
    expect(screen.getByTestId('trip-daily-activity')).toHaveTextContent('行驶')
    expect(screen.getByTestId('trip-daily-activity')).toHaveTextContent('5小时15分')
    expect(screen.getByTestId('trip-daily-activity')).toHaveTextContent('2小时30分')
    // 峰值 11/10 · 2h
    expect(screen.getByTestId('daily-peak')).toHaveTextContent('11/10')
    expect(screen.getByTestId('daily-peak')).toHaveTextContent('2h')
    // x 轴首/尾刻度
    expect(screen.getByTestId('daily-x-labels')).toHaveTextContent('11/8')
    expect(screen.getByTestId('daily-x-labels')).toHaveTextContent('11/14')
  })

  it('点按柱子 → tooltip 露出日期/行驶/充电/趟数（触屏通道）', () => {
    renderChart(<DailyActivityChart overview={makeOverview()} />)
    const bars = screen.getAllByTestId('daily-bar')
    expect(screen.queryByTestId('daily-tooltip')).not.toBeInTheDocument()
    fireEvent.click(bars[0])
    const tip = screen.getByTestId('daily-tooltip')
    expect(tip).toHaveTextContent('11月8日')
    expect(tip).toHaveTextContent('1小时0分') // 行驶 60
    expect(tip).toHaveTextContent('30分钟') // 充电 30
    expect(tip).toHaveTextContent('2 趟')
    // 再点同一根 → 收起（toggle，触屏无 hover）
    fireEvent.click(bars[0])
    expect(screen.queryByTestId('daily-tooltip')).not.toBeInTheDocument()
  })

  it('周桶：tooltip 日期显示为周区间（周一 – 周日）', () => {
    renderChart(<DailyActivityChart overview={makeOverview('week')} />)
    fireEvent.click(screen.getAllByTestId('daily-bar')[0])
    expect(screen.getByTestId('daily-tooltip')).toHaveTextContent('11/9 – 11/15')
  })

  it('驻车叙事降级小字：占比 + 日均活跃（按桶数据计算）', () => {
    renderChart(<DailyActivityChart overview={makeOverview()} />)
    // 7 天总活动 465 分 / 10080 分 → 驻车 95.4%；日均 465/7 ≈ 1小时6分
    const sub = screen.getByTestId('daily-sub')
    expect(sub).toHaveTextContent('驻车')
    expect(sub).toHaveTextContent('95.4%')
    expect(sub).toHaveTextContent('1小时6分')
  })

  it('无数据点：不渲染柱区，仍显示小字汇总', () => {
    const empty = { ...makeOverview(), daily: { bucket: 'day' as const, points: [] } }
    renderChart(<DailyActivityChart overview={empty} />)
    expect(screen.queryByTestId('daily-bar')).not.toBeInTheDocument()
    expect(screen.getByTestId('daily-sub')).toBeInTheDocument()
    expect(screen.queryByTestId('daily-peak')).not.toBeInTheDocument()
  })
})
