import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import ChargingPage from '@/pages/ChargingPage'
import { renderWithProviders } from './test-utils'
import { server } from './msw'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('ChargingPage', () => {
  it('渲染统计卡（含量/价/次数四卡）、电池健康卡、地点条形图与充电列表', async () => {
    renderWithProviders(<ChargingPage />)
    expect(await screen.findByTestId('charge-total-cost')).toHaveTextContent('¥168.40')
    // v0.3：第四张「充电次数」卡（stats.sessionCount）+ 电池健康紧凑单行（与首页大卡区分）
    const stats = screen.getByTestId('charge-stats')
    expect(stats).toHaveTextContent('24 次')
    const slim = await screen.findByTestId('battery-health-slim')
    expect(slim).toHaveTextContent('98.2')
    expect(slim).toHaveTextContent('50.7')

    const bars = await screen.findAllByTestId('location-bar')
    expect(bars).toHaveLength(2)
    expect(bars[0]).toHaveTextContent('家庭充电桩')
    expect(bars[1]).toHaveTextContent('超充 上海站')

    const items = screen.getAllByTestId('charge-item')
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveTextContent('41.2 kWh')
    expect(items[0]).toHaveTextContent('18%')
    expect(items[0]).toHaveTextContent('85%')
  })
})

/** 成本构成三分 + 月度趋势(Grafana charging-costs-stats 提炼) */
describe('充电成本构成', () => {
  it('渲染 AC/超充/其他快充三分与月度柱图', async () => {
    renderWithProviders(<ChargingPage />)
    const section = await screen.findByTestId('cost-composition')
    expect(section.textContent).toContain('家充/交流')
    expect(section.textContent).toContain('特斯拉超充')
    expect(section.textContent).toContain('其他快充')
    expect(await screen.findByTestId('monthly-cost-chart')).toBeInTheDocument()
    expect(await screen.findByTestId('free-charged')).toBeInTheDocument()
  })
})
