import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  it('桌面侧边栏使用 hidden lg:flex 策略，含 5 个主导航入口与头像菜单（v2.2 电价/推送/系统并入设置）', async () => {
    renderWithProviders(<AppLayout />)
    const sidebar = await screen.findByTestId('desktop-sidebar')
    expect(sidebar.className).toContain('hidden')
    expect(sidebar.className).toContain('lg:flex')
    for (const item of SIDEBAR_ITEMS) {
      expect(screen.getByTestId(item.testid)).toBeInTheDocument()
    }
    // 旧次级入口不再出现在侧栏
    expect(screen.queryByTestId('nav-pricing')).not.toBeInTheDocument()
    expect(screen.queryByTestId('nav-push')).not.toBeInTheDocument()
    expect(screen.queryByTestId('nav-system')).not.toBeInTheDocument()
    // 头像菜单（点击展开：用户信息/修改密码/退出登录）
    expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('user-menu-button'))
    const menu = screen.getByTestId('user-menu')
    expect(menu).toBeInTheDocument()
    expect(screen.getByTestId('user-menu-password')).toBeInTheDocument()
    expect(screen.getByTestId('user-menu-logout')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-car')).toBeInTheDocument()
  })

  it('移动 TabBar 使用 lg:hidden 策略，含 5 个主入口（报告并入，修复移动端不可达）', async () => {
    renderWithProviders(<AppLayout />)
    const tabbar = await screen.findByTestId('mobile-tabbar')
    // lg:hidden 在外层 fixed 容器上
    const wrapper = tabbar.parentElement?.parentElement
    expect(wrapper?.className).toContain('lg:hidden')
    for (const item of NAV_ITEMS) {
      expect(screen.getByTestId(`${item.testid}-mobile`)).toBeInTheDocument()
    }
  })

  it('TabBar 与侧栏共用 5 项导航（概览/行程/充电/报告/设置），报告页移动端可达', () => {
    expect(NAV_ITEMS.map((n) => n.to)).toEqual(['/', '/trips', '/charging', '/reports', '/settings'])
    expect(SIDEBAR_ITEMS).toBe(NAV_ITEMS)
  })

  it('移动 TabBar 网格为 5 列', async () => {
    renderWithProviders(<AppLayout />)
    const tabbar = await screen.findByTestId('mobile-tabbar')
    expect(tabbar.className).toContain('grid-cols-5')
  })
})
