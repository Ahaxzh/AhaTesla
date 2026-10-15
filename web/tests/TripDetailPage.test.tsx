import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import TripDetailPage from '@/pages/TripDetailPage'
import { renderWithProviders } from './test-utils'
import { server } from './msw'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('TripDetailPage', () => {
  it('渲染统计卡、SVG 路线图与起终点', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/trips/:id" element={<TripDetailPage />} />
      </Routes>,
      { route: '/trips/101' },
    )
    expect(await screen.findByTestId('trip-cost')).toHaveTextContent('¥4.35')
    const map = await screen.findByTestId('route-map')
    expect(map).toBeInTheDocument()
    expect(map.querySelector('path')).toBeTruthy()
    expect(screen.getByTestId('trip-endpoints')).toHaveTextContent('家')
    expect(screen.getByTestId('trip-endpoints')).toHaveTextContent('公司')
    // v2.1 P3 模块4：FIFO 批次扣减明细 + 综合单价 + 油车对比 + 能效标签 + 口径标注
    expect(await screen.findByTestId('fifo-card')).toBeInTheDocument()
    expect(screen.getByTestId('fifo-batch-rows')).toHaveTextContent('家庭充电桩')
    expect(screen.getByTestId('fifo-card')).toHaveTextContent('综合单价')
    expect(screen.getByTestId('fuel-compare')).toHaveTextContent('净节省 ¥2.21')
    expect(screen.getByTestId('efficiency-badge')).toHaveTextContent('能效达成 93%')
    expect(screen.getByTestId('energy-formula-note')).toHaveTextContent('耗电口径')
    expect(screen.getByTestId('environment-card')).toHaveTextContent('18.5')
  })
})
