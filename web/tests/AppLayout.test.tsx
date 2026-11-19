import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Routes, Route } from 'react-router-dom'
import { AppLayout, NAV_ITEMS, SIDEBAR_ITEMS, TABBAR_ITEMS } from '@/layouts/AppLayout'
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
  it('桌面侧边栏使用 hidden lg:flex 策略，含 6 个主导航入口（v2.7 新增能耗）与头像菜单', async () => {
    renderWithProviders(<AppLayout />)
    const sidebar = await screen.findByTestId('desktop-sidebar')
    expect(sidebar.className).toContain('hidden')
    expect(sidebar.className).toContain('lg:flex')
    for (const item of SIDEBAR_ITEMS) {
      expect(screen.getByTestId(item.testid)).toBeInTheDocument()
    }
    expect(screen.getByTestId('nav-energy')).toBeInTheDocument()
    // 旧次级入口不再出现在侧栏
    expect(screen.queryByTestId('nav-pricing')).not.toBeInTheDocument()
    expect(screen.queryByTestId('nav-push')).not.toBeInTheDocument()
    expect(screen.queryByTestId('nav-system')).not.toBeInTheDocument()
    // 头像菜单（点击展开：用户信息/修改密码/退出登录）
    expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('user-menu-button'))
    const menu = screen.getByTestId('user-menu')
    expect(menu).toBeInTheDocument()
    expect(screen.getByTestId('user-menu-account-link')).toBeInTheDocument()
    expect(screen.getByTestId('user-menu-logout')).toBeInTheDocument()
    // 桌面形态面板无「设置」直达（设置已在侧栏，避免重复入口）
    expect(screen.queryByTestId('user-menu-settings-link')).not.toBeInTheDocument()
    expect(screen.getByTestId('sidebar-car')).toBeInTheDocument()
    // m4e:默认 mock 两辆车 → 切换 chips 渲染且可点选
    expect(screen.getByTestId('car-switcher')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('car-option-2'))
    expect(screen.getByTestId('car-option-2')).toHaveAttribute('aria-checked', 'true')
  })

  it('移动 TabBar 使用 lg:hidden 策略，5 项且不含设置（v2.7：设置移入顶栏头像菜单）', async () => {
    renderWithProviders(<AppLayout />)
    const tabbar = await screen.findByTestId('mobile-tabbar')
    // lg:hidden 在外层 fixed 容器上
    const wrapper = tabbar.parentElement?.parentElement
    expect(wrapper?.className).toContain('lg:hidden')
    for (const item of TABBAR_ITEMS) {
      expect(screen.getByTestId(`${item.testid}-mobile`)).toBeInTheDocument()
    }
    expect(screen.queryByTestId('nav-settings-mobile')).not.toBeInTheDocument()
    // 底栏实底化（v2.7 修 iOS 动量滚动整栏消失）：不再使用 backdrop-blur
    expect(tabbar.parentElement?.className).not.toContain('backdrop-blur')
  })

  it('导航分列（v2.7）：侧栏 6 项含设置；底栏 5 项概览居中，左侧行程/充电、右侧能耗/报告', () => {
    expect(NAV_ITEMS.map((n) => n.to)).toEqual(['/', '/trips', '/charging', '/energy', '/reports', '/settings'])
    expect(TABBAR_ITEMS.map((n) => n.to)).toEqual(['/trips', '/charging', '/', '/energy', '/reports'])
    expect(TABBAR_ITEMS[2].to).toBe('/') // 概览居中（拇指最顺位）
    expect(SIDEBAR_ITEMS).toBe(NAV_ITEMS)
  })

  it('移动 TabBar 网格为 5 列', async () => {
    renderWithProviders(<AppLayout />)
    const tabbar = await screen.findByTestId('mobile-tabbar')
    expect(tabbar.className).toContain('grid-cols-5')
  })
})

describe('移动端顶栏（v2.7）', () => {
  it('顶栏 lg:hidden：左 Logo 右头像按钮，点开菜单含设置/账户安全/退出', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AppLayout />)
    const bar = await screen.findByTestId('mobile-topbar')
    expect(bar.className).toContain('lg:hidden')
    // 菜单初始关闭
    expect(screen.queryByTestId('mobile-user-menu')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('mobile-user-menu-button'))
    expect(screen.getByTestId('mobile-user-menu')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-user-menu-settings-link')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-user-menu-account-link')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-user-menu-logout')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-user-menu-theme')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-user-menu-lang')).toBeInTheDocument()
  })

  it('头像菜单「设置」直达设置页（移动端设置唯一入口），点击后菜单收起', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <Routes>
        <Route path="/" element={<AppLayout />}>
          <Route index element={<div data-testid="home-route" />} />
          <Route path="settings" element={<div data-testid="settings-route" />} />
        </Route>
      </Routes>,
    )
    await user.click(screen.getByTestId('mobile-user-menu-button'))
    await user.click(screen.getByTestId('mobile-user-menu-settings-link'))
    expect(await screen.findByTestId('settings-route')).toBeInTheDocument()
    expect(screen.queryByTestId('mobile-user-menu')).not.toBeInTheDocument()
  })
})

/** Discord 式用户菜单：快捷开关（主题/语言）+ 内联账户面板（用户名+密码） */
describe('UserMenu 快捷开关与账户面板', () => {
  it('主题按钮三态循环切换，语言按钮中英互切', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AppLayout />)
    await userEvent.click(screen.getByTestId('user-menu-button'))
    const themeBtn = screen.getByTestId('user-menu-theme')
    // 默认 system → dark → light → system
    expect(themeBtn.textContent).toContain('跟随系统')
    await user.click(themeBtn)
    expect(themeBtn.textContent).toContain('深色')
    await user.click(themeBtn)
    expect(themeBtn.textContent).toContain('浅色')
    await user.click(themeBtn)
    expect(themeBtn.textContent).toContain('跟随系统')
    const langBtn = screen.getByTestId('user-menu-lang')
    expect(langBtn.textContent).toContain('English')
    await user.click(langBtn)
    expect(langBtn.textContent).toContain('中文')
  })

  it('账户安全入口：点击跳转设置页锚点（完整编辑唯一入口在设置→账户安全）', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <Routes>
        <Route path="/" element={<AppLayout />}>
          <Route index element={<div data-testid="home-route" />} />
          <Route path="settings" element={<div data-testid="settings-route" />} />
        </Route>
      </Routes>,
    )
    await user.click(screen.getByTestId('user-menu-button'))
    await user.click(screen.getByTestId('user-menu-account-link'))
    expect(await screen.findByTestId('settings-route')).toBeInTheDocument()
    // 点击后菜单收起
    expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument()
  })
})
