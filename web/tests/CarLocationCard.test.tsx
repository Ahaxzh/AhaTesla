import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { CarLocationCard } from '@/components/CarLocationCard'
import { renderWithProviders } from './test-utils'

// leafet 地图实现 mock（jsdom 无布局）：本测重点是外壳逻辑——有无坐标决定整卡渲染。
// 工厂自包含（vi.mock 提升到 import 之前，JSX 的 jsx-runtime 尚未加载会炸整棵树）。
vi.mock('@/components/CarLocationMap', async () => {
  const { createElement } = await import('react')
  return {
    default: ({ position }: { position: { lat: number; lng: number } }) =>
      createElement('div', { 'data-testid': 'car-location-map-stub' }, `map ${position.lat},${position.lng}`),
  }
})

beforeAll(() => vi.restoreAllMocks())
afterEach(() => vi.clearAllMocks())
afterAll(() => vi.restoreAllMocks())

describe('CarLocationCard（车辆位置地图卡外壳）', () => {
  it('有定位 → 卡片渲染，坐标传入懒加载的地图', async () => {
    renderWithProviders(<CarLocationCard position={{ lat: 24.49, lng: 118.1, at: '2026-11-10T03:00:00Z' }} state="asleep" />)
    // testid car-location-card 现由地图实现持有（本测 mock 掉）→ 断言 stub
    const stub = await screen.findByTestId('car-location-map-stub', {}, { timeout: 3000 })
    expect(stub).toHaveTextContent('24.49,118.1')
  })

  it('无定位（旧库/无 GPS）→ 整卡不渲染', () => {
    const { container } = renderWithProviders(<CarLocationCard position={null} state="offline" />)
    expect(container.querySelector('[data-testid="car-location-card"]')).not.toBeInTheDocument()
  })
})
