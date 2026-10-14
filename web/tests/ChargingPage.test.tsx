import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import ChargingPage from '@/pages/ChargingPage'
import { renderWithProviders } from './test-utils'
import { server } from './msw'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('ChargingPage', () => {
  it('渲染统计卡、地点条形图与充电列表', async () => {
    renderWithProviders(<ChargingPage />)
    expect(await screen.findByTestId('charge-total-cost')).toHaveTextContent('¥168.40')

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
