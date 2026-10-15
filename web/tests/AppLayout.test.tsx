import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { AppLayout, NAV_ITEMS, SIDEBAR_ITEMS } from '@/layouts/AppLayout'
import { renderWithProviders } from './test-utils'
import { server } from './msw'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/**
 * jsdom 不执行 Tailwind 响应式媒体查询，无法通过计算样式断言显隐。
 * 改为断言响应式 class 策略 + 渲染结构：
 * - 侧边栏 hidden lg:flex（移动隐藏、桌面显示）
 * - TabBar 容器 lg:hidden（移动显示、桌面隐藏）
 */
describe('AppLayout 响应式导航', () => {
  it('桌面侧边栏使用 hidden lg:flex 策略，含全部 8 个导航入口与登出', async () => {
    renderWithProviders(<AppLayout />)
    const sidebar = await screen.findByTestId('desktop-sidebar')
    expect(sidebar.className).toContain('hidden')
    expect(sidebar.className).toContain('lg:flex')
    for (const item of SIDEBAR_ITEMS) {
      expect(screen.getByTestId(item.testid)).toBeInTheDocument()
    }
    expect(screen.getByTestId('logout-button')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-car')).toBeInTheDocument()
  })

  it('移动 TabBar 使用 lg:hidden 策略，含 4 个主入口（§6.1）', async () => {
    renderWithProviders(<AppLayout />)
    const tabbar = await screen.findByTestId('mobile-tabbar')
    // lg:hidden 在外层 fixed 容器上
    const wrapper = tabbar.parentElement?.parentElement
    expect(wrapper?.className).toContain('lg:hidden')
    for (const item of NAV_ITEMS) {
      expect(screen.getByTestId(`${item.testid}-mobile`)).toBeInTheDocument()
    }
  })

  it('TabBar 为 4 项（概览/行程/充电/设置，PRD §6.1），次级入口只在桌面侧栏', () => {
    expect(NAV_ITEMS.map((n) => n.to)).toEqual(['/', '/trips', '/charging', '/settings'])
    expect(SIDEBAR_ITEMS.map((n) => n.to)).toEqual(['/', '/trips', '/charging', '/settings', '/reports', '/pricing', '/push', '/system'])
  })

  it('移动 TabBar 网格为 4 列', async () => {
    renderWithProviders(<AppLayout />)
    const tabbar = await screen.findByTestId('mobile-tabbar')
    expect(tabbar.className).toContain('grid-cols-4')
  })
})
