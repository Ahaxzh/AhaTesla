import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import ReportDetailPage from '@/pages/ReportDetailPage'
import { renderWithProviders } from './test-utils'
import { server } from './msw'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/** v2.4：insights/ytd/compare/topRoutes 明细早已在快照响应里，此前被前端类型丢弃 */
const monthlyDetail = {
  id: 12,
  type: 'monthly',
  periodLabel: '2026-10',
  periodStart: '2026-10-01T00:00:00Z',
  periodEnd: '2026-10-31T23:59:59Z',
  carName: 'Model 3',
  createdAt: '2026-11-01T08:00:00Z',
  distanceKm: 1520.4,
  totalCost: 231.8,
  saved: 1015.5,
  kpi: {
    distanceKm: 1520.4, energyKwh: 240.5, chargeKwh: 262.1, totalCost: 231.8,
    driveCount: 38, costPerKm: 0.152, fuelCost: 1247.3, saved: 1015.5, savedPct: 81.4,
  },
  topRoutes: [
    { route: '家 → 公司', count: 21, distanceKm: 189.0, energyKwh: 30.2, costCny: 28.9 },
    { route: '公司 → 家', count: 19, distanceKm: 171.0, energyKwh: 27.4, costCny: 26.2 },
  ],
  insights: {
    avgTempC: 18.2, tempRangeC: '9~27°C', avgSpeedKmh: 32, maxSpeedKmh: 118,
    idlePct: 14, powerMaxKw: 92, tireFlBar: 2.9, tireRrBar: 3.0, tireMinBar: 2.86, kwhPer100km: 15.8,
  },
  ytd: { distanceKm: 15800.2, totalCost: 2312.6, saved: 10680.4 },
  baselineNote: '对比基准：8L/100km @ ¥8.20/L',
  closing: '10 月共行驶 1,520.4 km…',
}

const dailyDetail = {
  ...monthlyDetail,
  id: 13,
  type: 'daily',
  periodLabel: '11-14（周五）',
  insights: null,
  ytd: undefined,
  compare: {
    lastWeek: { distanceKm: 42.1, totalCost: 6.4 },
    kmDeltaPct: 18,
    costDeltaPct: -5,
    month: { distanceKm: 320, totalCost: 48.9 },
  },
}

describe('ReportDetailPage（v2.4 快照字段全量露出）', () => {
  it('月报：驾驶洞察 + 年度至今 + 路线明细（里程/电费）', async () => {
    server.use(http.get('/api/reports/12', () => HttpResponse.json(monthlyDetail)))
    renderWithProviders(
      <Routes>
        <Route path="/reports/:id" element={<ReportDetailPage />} />
      </Routes>,
      { route: '/reports/12' },
    )
    // 洞察区块：气温区间/怠速/最高功率/胎压
    const insights = await screen.findByTestId('report-insights')
    expect(insights).toHaveTextContent('9~27°C')
    expect(insights).toHaveTextContent('14%')
    expect(insights).toHaveTextContent('92 kW')
    expect(insights).toHaveTextContent('2.9 / 3.0 bar')
    expect(screen.getByTestId('report-insights')).toHaveTextContent('2.86')
    // 年度至今
    expect(screen.getByTestId('report-ytd')).toHaveTextContent('15,800')
    expect(screen.getByTestId('report-ytd')).toHaveTextContent('¥2,312.60')
    // 路线明细：次数 + 里程 + 电费
    const routes = screen.getByTestId('report-routes')
    expect(routes).toHaveTextContent('家 → 公司')
    expect(routes).toHaveTextContent('189 km')
    expect(routes).toHaveTextContent('¥28.90')
  })

  it('年报：标题 + 年度之最四格（v2.5）', async () => {
    server.use(http.get('/api/reports/14', () =>
      HttpResponse.json({
        ...monthlyDetail,
        id: 14,
        type: 'annual',
        periodLabel: '2025 年报',
        insights: null,
        ytd: undefined,
        annual: { maxDayKm: 620, maxTripKm: 412.5, maxTripRoute: '家 → 三亚', chargeSessions: 58, superPct: 22 },
      }),
    ))
    renderWithProviders(
      <Routes>
        <Route path="/reports/:id" element={<ReportDetailPage />} />
      </Routes>,
      { route: '/reports/14' },
    )
    expect(await screen.findByText(/年报/)).toBeInTheDocument()
    const annual = screen.getByTestId('report-annual')
    expect(annual).toHaveTextContent('620 km')
    expect(annual).toHaveTextContent('413 km') // fmtKm(412.5, 0) 四舍五入
    expect(annual).toHaveTextContent('家 → 三亚')
    expect(annual).toHaveTextContent('58')
    expect(annual).toHaveTextContent('22%')
    expect(screen.queryByTestId('report-ytd')).not.toBeInTheDocument()
  })

  it('日报：标题 + 上周同日环比 + 本月累计；无 insights 时不渲染洞察区', async () => {
    server.use(http.get('/api/reports/13', () => HttpResponse.json(dailyDetail)))
    renderWithProviders(
      <Routes>
        <Route path="/reports/:id" element={<ReportDetailPage />} />
      </Routes>,
      { route: '/reports/13' },
    )
    expect(await screen.findByText(/日报/)).toBeInTheDocument()
    const compare = screen.getByTestId('report-compare')
    expect(compare).toHaveTextContent('42 km')
    expect(compare).toHaveTextContent('+18%')
    expect(compare).toHaveTextContent('320 km')
    expect(screen.queryByTestId('report-insights')).not.toBeInTheDocument()
    expect(screen.queryByTestId('report-ytd')).not.toBeInTheDocument()
  })
})
