import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen, waitFor } from '@testing-library/react'
import TripsPage from '@/pages/TripsPage'
import { renderWithProviders } from './test-utils'
import { server } from './msw'

// jsdom 缺少 Leaflet 需要的布局 API（轨迹汇总图懒加载组件），与 TripDetail 测试同款 mock
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

/** IO mock：只登记最新回调（observe 语义由测试手动驱动——jsdom 无真实布局，逐页确定触发） */
type IoCb = (entries: { isIntersecting: boolean }[], obs: unknown) => void
let ioCb: IoCb | null = null
class MockIO {
  constructor(cb: IoCb) { ioCb = cb }
  observe() {}
  disconnect() {}
  unobserve() {}
}
const fireIntersection = () => ioCb?.([{ isIntersecting: true }], {})

beforeAll(() => {
  server.listen()
  vi.stubGlobal('IntersectionObserver', MockIO)
})
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('TripsPage（v0.3：默认近90天 + 顶部汇总 + 无限滚动）', () => {
  it('渲染列表 + 顶部汇总（KPI/状态占比/轨迹汇总）+ 无限滚动取完全部', async () => {
    renderWithProviders(<TripsPage />)
    // 首屏 20 条
    await waitFor(() => expect(screen.getAllByTestId('trip-item').length).toBe(20))
    // 哨兵进视口 → 第 2 页
    fireIntersection()
    await waitFor(() => expect(screen.getAllByTestId('trip-item').length).toBe(40))
    expect(screen.getAllByTestId('trip-item')[20]).toHaveTextContent('起点21')
    // 再触发 → 第 3 页（45 条中的最后 5 条）→ 全部加载完
    fireIntersection()
    await waitFor(() => expect(screen.getAllByTestId('trip-item').length).toBe(45))
    expect(screen.getByTestId('trip-load-state')).toHaveTextContent('已加载全部 45 条')
    // 顶部汇总（msw overview mock；里程按 0 位小数显示）
    const overview = screen.getByTestId('trip-overview')
    expect(overview).toHaveTextContent('1,241')
    expect(overview).toHaveTextContent('128')
    expect(overview).toHaveTextContent('¥168.40')
    expect(screen.getByTestId('trip-state-share')).toHaveTextContent('行驶')
    expect(screen.getByTestId('trip-state-share')).toHaveTextContent('驻车')
    expect(screen.getByText('轨迹汇总')).toBeInTheDocument()
  })

  it('默认筛选近 90 天：开始日期预填，清除后恢复全部', async () => {
    renderWithProviders(<TripsPage />)
    await waitFor(() => expect(screen.getAllByTestId('trip-item').length).toBe(20))
    const from = screen.getByLabelText('开始日期') as HTMLInputElement
    expect(from.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Date.parse(from.value)).toBeGreaterThan(Date.now() - 91 * 86400_000)
    expect(screen.getByTestId('filter-clear')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByTestId('filter-clear'))
    expect(screen.queryByTestId('filter-clear')).not.toBeInTheDocument()
  })
})
