import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import EnergyPage from '@/pages/EnergyPage'
import { renderWithProviders } from './test-utils'
import { server } from './msw'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/**
 * 能耗页（v2.7）：车机能耗 App 三段式（最近行程/自上次充电/累计），
 * 数据全部来自既有端点（trips/overview·display-accuracy·efficiency-profile·trips·charging·battery-health）。
 */
describe('能耗页：区间切换与 KPI', () => {
  it('默认最近行程段：KPI 来自最新一趟（里程/能耗/平均 Wh/km/表显达成）+ 详情链接 + 满电预估', async () => {
    renderWithProviders(<EnergyPage />)
    expect(await screen.findByTestId('energy-kpis')).toBeInTheDocument()
    // mock 最新一趟：32.4 km · 5.8 kWh · 17.9 kWh/100km → 179 Wh/km
    expect(await screen.findByText('179 Wh/km')).toBeInTheDocument()
    // 详情 ratio 0.929 → 93%（详情查询晚于列表，findByText 等它）
    expect(await screen.findByText('93%')).toBeInTheDocument()
    expect(screen.getByTestId('energy-trip-link')).toHaveAttribute('href', '/trips/1')
    // 满电预估：容量 50.7 kWh ÷ 179 Wh/km ≈ 283 km
    expect(screen.getByTestId('energy-projected')).toHaveTextContent('283')
    // 最近行程段不渲染曲线/月度/画像
    expect(screen.queryByTestId('energy-trend-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('energy-monthly-card')).not.toBeInTheDocument()
  })

  it('自上次充电段：区间聚合 KPI + 逐趟能耗曲线 + 充电锚点语境', async () => {
    const user = userEvent.setup()
    renderWithProviders(<EnergyPage />)
    await screen.findByTestId('energy-kpis')
    await user.click(screen.getByTestId('energy-range-since'))
    // overview mock：45 趟 1240.5 km 223.1 kWh → 平均 180 Wh/km
    expect(await screen.findByTestId('energy-trend-card')).toBeInTheDocument()
    expect(screen.getByText('180 Wh/km')).toBeInTheDocument()
    // 曲线点 = 充电后行程（mock 45 条）
    expect(screen.getAllByTestId('energy-trend-point')).toHaveLength(45)
    // 语境行含上次充电地点
    expect(screen.getByTestId('energy-context')).toHaveTextContent('家庭充电桩')
    // URL 写回 range（深链/回退）
  })

  it('累计段：表显达成（avgRatio 0.975 → 98%）+ 月度实际vs表显图 + 能效画像', async () => {
    renderWithProviders(<EnergyPage />, { route: '/energy?range=all' })
    expect(await screen.findByTestId('energy-monthly-card')).toBeInTheDocument()
    expect(screen.getByText('98%')).toBeInTheDocument()
    // 月度图：mock 3 个月 → 3 根柱（越线=绿/不及=琥珀，颜色语义在图例/tooltip 承载）
    expect(screen.getAllByTestId('energy-monthly-bar')).toHaveLength(3)
    // 能效画像（samples 93 ≥ 5 才渲染）
    expect(await screen.findByTestId('trip-efficiency-card')).toBeInTheDocument()
    // 满电预估 chip
    expect(screen.getByTestId('energy-projected')).toBeInTheDocument()
  })

  it('自上次充电段但实例无充电记录：诚实回落为近两年窗口', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/charging', () => HttpResponse.json({ total: 0, items: [] })),
    )
    renderWithProviders(<EnergyPage />)
    await screen.findByTestId('energy-kpis')
    await user.click(screen.getByTestId('energy-range-since'))
    expect(await screen.findByTestId('energy-kpis')).toBeInTheDocument()
    expect(screen.getByTestId('energy-context')).toHaveTextContent('尚无充电记录')
  })

  it('无行程数据：空态卡而非 0 值 KPI', async () => {
    server.use(
      http.get('/api/trips', () => HttpResponse.json({ total: 0, items: [] })),
    )
    renderWithProviders(<EnergyPage />)
    expect(await screen.findByTestId('energy-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('energy-kpis')).not.toBeInTheDocument()
  })
})

describe('能耗图表组件（极性配色 + 三通道 tooltip）', () => {
  it('逐趟能耗曲线：平均虚线存在，悬停出 tooltip（日期/Wh/km/km）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<EnergyPage />)
    await screen.findByTestId('energy-kpis')
    await user.click(screen.getByTestId('energy-range-all'))
    const track = await screen.findByTestId('energy-trend-track')
    expect(track).toBeInTheDocument()
    expect(screen.getByTestId('energy-trend-avg-line')).toBeInTheDocument()
    const points = screen.getAllByTestId('energy-trend-point')
    await user.hover(points[points.length - 1])
    expect(screen.getByTestId('energy-trend-tooltip')).toBeInTheDocument()
    // 离开即收起
    await user.unhover(points[points.length - 1])
    expect(screen.queryByTestId('energy-trend-tooltip')).not.toBeInTheDocument()
  })

  it('月度图：悬停柱子出 tooltip（实际/表显/达成率），再点同柱可收起', async () => {
    const user = userEvent.setup()
    renderWithProviders(<EnergyPage />, { route: '/energy?range=all' })
    const bars = await screen.findAllByTestId('energy-monthly-bar')
    await user.hover(bars[0])
    expect(screen.getByTestId('energy-monthly-tooltip')).toBeInTheDocument()
    expect(screen.getByTestId('energy-monthly-tooltip')).toHaveTextContent('%')
    await user.unhover(bars[0])
    expect(screen.queryByTestId('energy-monthly-tooltip')).not.toBeInTheDocument()
  })
})
