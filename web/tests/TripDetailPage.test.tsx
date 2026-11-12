import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'

// jsdom 缺少 Leaflet 需要的布局 API（offsetWidth/resize），mock 掉地图实现
const fakeLayer = { addTo: () => fakeLayer, on: () => fakeLayer, clearLayers: () => {}, remove: () => {} }
vi.mock('leaflet', () => ({
  default: {
    map: () => ({ remove: () => {}, fitBounds: () => {}, on: () => {}, setView: () => {}, removeLayer: () => {}, addLayer: () => {} }),
    tileLayer: () => fakeLayer,
    control: { zoom: () => ({ addTo: () => {} }) },
    layerGroup: () => fakeLayer,
    polyline: () => fakeLayer,
    marker: () => fakeLayer,
    divIcon: (o: unknown) => o,
    latLngBounds: () => ({ pad: () => ({}) }),
  },
}))
vi.mock('leaflet/dist/leaflet.css', () => ({}))

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
    // v2.2：Leaflet 真实底图版（容器存在性 + 图例；瓦片加载与轨迹由 e2e 真浏览器验证）
    expect(screen.getByTestId('route-speed-legend')).toBeInTheDocument()
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
    // 胎压卡（行程末）：最低值 + FL/RL 缩写明细（语言中立缩写）
    expect(screen.getByTestId('trip-tire-pressure')).toHaveTextContent('最低')
    expect(screen.getByTestId('trip-tire-pressure')).toHaveTextContent('FL 3.1/3.0')
    expect(screen.getByTestId('trip-tire-pressure')).toHaveTextContent('RL 2.9/3.0')
    // GPS 采样点 + 平均采样间隔成对（35min ÷ 3 点 = 700s/点）
    expect(screen.getByTestId('trip-gps-count')).toHaveTextContent('3')
    expect(screen.getByTestId('trip-sample-interval')).toHaveTextContent('700')
  })
})


/** 海拔剖面(Grafana trip.json Elevation 提炼) */
describe('海拔剖面', () => {
  it('渲染海拔面积图与高差信息', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/trips/:id" element={<TripDetailPage />} />
      </Routes>,
      { route: '/trips/101' },
    )
    expect(await screen.findByTestId('elevation-profile')).toBeInTheDocument()
    expect(await screen.findByTestId('elevation-profile')).toHaveTextContent("8–28 m")
  })
})
