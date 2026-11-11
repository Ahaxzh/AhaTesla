import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import DashboardPage from '@/pages/DashboardPage'
import { renderWithProviders } from './test-utils'
import { mockDashboard, server } from './msw'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('DashboardPage', () => {
  it('渲染车辆电量横条与续航（v1.2 紧凑卡：环形改细条）', async () => {
    renderWithProviders(<DashboardPage />)
    const bar = await screen.findByTestId('battery-bar')
    expect(bar).toBeInTheDocument()
    expect(screen.getByTestId('car-card')).toHaveTextContent('72')
    expect(screen.getByTestId('car-card')).toHaveTextContent('358')
    // 胎压四轮横排（A 方案）：<2.6 变红由 className 承担，这里断言四值与测量时间存在
    const tp = screen.getByTestId('tire-pressure')
    expect(tp).toHaveTextContent('3.1')
    expect(tp).toHaveTextContent('2.9')
  })

  it('渲染本月统计卡（里程/能耗/电费）与油车对比', async () => {
    renderWithProviders(<DashboardPage />)
    expect(await screen.findByTestId('car-card')).toBeInTheDocument()
    const stats = screen.getByTestId('month-stats')
    expect(stats).toHaveTextContent('1,240.5 km')
    expect(stats).toHaveTextContent('223.1 kWh')
    // v2.1：电费卡优先显示 ledger summary（¥36.12）并带构成小字（P2 模块3）
    expect(screen.getByTestId('stat-cost')).toHaveTextContent('¥36.12')
    expect(screen.getByTestId('stat-cost')).toHaveTextContent('含行驶 ¥34.46 · 驻车/哨兵 ¥1.66')
    // v2.2：省钱数 = 油车 620.25 − 账本口径电费 36.12 = 584.13（与电费卡一致，FIFO 口径）
    expect(stats).toHaveTextContent('省')
    expect(stats).toHaveTextContent('584.13')
  })

  it('渲染最近行程与充电列表', async () => {
    renderWithProviders(<DashboardPage />)
    expect(await screen.findByTestId('recent-trips')).toHaveTextContent('家')
    expect(screen.getByTestId('recent-trips')).toHaveTextContent('公司')
    expect(screen.getByTestId('recent-charges')).toHaveTextContent('家庭充电桩')
  })

  it('空数据时显示空态而非报错', async () => {
    server.use(
      http.get('/api/dashboard', () =>
        HttpResponse.json({
          ...mockDashboard,
          car: { name: 'Model 3', currentBattery: 0, rangeKm: 0, state: 'asleep', odometerKm: 0 },
          monthStats: { distanceKm: 0, energyKWh: 0, costCny: 0, driveCount: 0, driveHours: 0 },
          fuelComparison: { fuelCostCny: 0, source: 'model', asOf: '' },
          recentTrips: [],
          recentCharges: [],
        }),
      ),
    )
    renderWithProviders(<DashboardPage />)
    expect(await screen.findAllByTestId('empty-state').then((els) => els.length)).toBeGreaterThanOrEqual(2)
  })
})

/** 电池健康卡(Grafana BatteryHealthV2 提炼) */
describe('BatteryHealthCard', () => {
  it('渲染健康度/容量/循环/效率与月度趋势条', async () => {
    renderWithProviders(<DashboardPage />)
    const card = await screen.findByTestId('battery-health-card')
    expect(card.textContent).toContain('98.2')
    expect(card.textContent).toContain('50.7')
    expect(card.textContent).toContain('56')
    expect(card.textContent).toContain('92.6')
    expect(await screen.findAllByTestId('battery-trend')).toHaveLength(1)
  })
})
