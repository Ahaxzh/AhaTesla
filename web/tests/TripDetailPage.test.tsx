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
  })
})
