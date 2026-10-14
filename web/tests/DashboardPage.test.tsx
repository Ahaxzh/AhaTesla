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
  it('渲染车辆电量环形与续航', async () => {
    renderWithProviders(<DashboardPage />)
    const ring = await screen.findByTestId('battery-ring')
    expect(ring).toHaveTextContent('72')
    expect(ring).toHaveTextContent('358')
  })

  it('渲染本月统计卡（里程/能耗/电费）与油车对比', async () => {
    renderWithProviders(<DashboardPage />)
    expect(await screen.findByTestId('car-card')).toBeInTheDocument()
    const stats = screen.getByTestId('month-stats')
    expect(stats).toHaveTextContent('1,240.5 km')
    expect(stats).toHaveTextContent('223.1 kWh')
    expect(screen.getByTestId('stat-cost')).toHaveTextContent('¥168.40')
    // 油车 620.25 - 电 168.40 = 省 451.85
    expect(stats).toHaveTextContent('省')
    expect(stats).toHaveTextContent('451.85')
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
