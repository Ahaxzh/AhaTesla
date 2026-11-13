import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
    // 胎压四轮横排（A 方案）：<2.6 变红由 className 承担，这里断言四值与测量时间存在；
    // 位置标签用国际缩写 FL/FR/RL/RR（前左/前右/后左/后右）
    const tp = screen.getByTestId('tire-pressure')
    expect(tp).toHaveTextContent('FL')
    expect(tp).toHaveTextContent('FR')
    expect(tp).toHaveTextContent('RL')
    expect(tp).toHaveTextContent('RR')
    expect(tp).toHaveTextContent('3.1')
    expect(tp).toHaveTextContent('2.9')
    // v0.2.x：状态胶囊与「数据同步于」合并为底部一行（省一行）
    expect(screen.getByTestId('car-state-pill')).toHaveTextContent('哨兵/在线')
    expect(screen.getByTestId('car-synced')).toHaveTextContent('数据同步于')
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

/** 电池健康（v0.3 调换：首页紧凑行，点击就地展开大卡） */
describe('BatteryHealthCard（首页）', () => {
  it('slim 显示核心数，点击展开完整指标与趋势条', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DashboardPage />)
    const slim = await screen.findByTestId('battery-health-slim')
    expect(slim).toHaveTextContent('98.2')
    expect(slim).toHaveTextContent('50.7')
    // 点击展开 → 大卡身体（容量/循环/效率 + 趋势条）
    await user.click(screen.getByTestId('battery-health-toggle'))
    const expanded = await screen.findByTestId('battery-health-expanded')
    expect(expanded.textContent).toContain('56')
    expect(expanded.textContent).toContain('92.6')
    expect(screen.getAllByTestId('battery-trend')).toHaveLength(1)
    // 再点收起
    await user.click(screen.getByTestId('battery-health-toggle'))
    expect(screen.queryByTestId('battery-health-expanded')).not.toBeInTheDocument()
  })
})
