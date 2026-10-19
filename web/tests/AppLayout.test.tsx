import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
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
    // m4e:默认 mock 两辆车 → 切换 chips 渲染且可点选
    expect(screen.getByTestId('car-switcher')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('car-option-2'))
    expect(screen.getByTestId('car-option-2')).toHaveAttribute('aria-checked', 'true')
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

  it('账户面板：改用户名走 /api/auth/change-password，成功后刷新用户名', async () => {
    const user = userEvent.setup()
    let captured: Record<string, unknown> | null = null
    server.use(
      http.post('/api/auth/change-password', async ({ request }) => {
        captured = await request.json() as Record<string, unknown>
        return HttpResponse.json({ ok: true, user: { username: 'eli' } })
      }),
      http.get('/api/auth/me', () =>
        HttpResponse.json({ username: 'aha', initialized: true })),
    )
    renderWithProviders(<AppLayout />)
    await userEvent.click(screen.getByTestId('user-menu-button'))
    await user.click(screen.getByTestId('user-menu-password'))
    const panel = await screen.findByTestId('user-menu-account-panel')
    expect(panel).toBeInTheDocument()
    await user.clear(screen.getByLabelText(/用户名|Username/i))
    await user.type(screen.getByLabelText(/用户名|Username/i), 'eli')
    await user.type(screen.getByLabelText(/当前密码|Current password/i), 'password-123')
    await user.click(screen.getByTestId('user-menu-account-save'))
    // 请求体带 newUsername，不带 newPassword（留空只改名）；成功后面板收起
    await vi.waitFor(() => {
      expect(captured).not.toBeNull()
      expect(captured?.newUsername).toBe('eli')
      expect(captured?.newPassword).toBeUndefined()
    })
    await vi.waitFor(() => {
      expect(screen.queryByTestId('user-menu-account-panel')).not.toBeInTheDocument()
    })
  })

  it('两次新密码不一致被前端拦截，不发请求', async () => {
    const user = userEvent.setup()
    let fired = 0
    server.events.on('request:start', (req) => {
      if (req.request.url.includes('/api/auth/change-password')) fired += 1
    })
    renderWithProviders(<AppLayout />)
    await userEvent.click(screen.getByTestId('user-menu-button'))
    await user.click(screen.getByTestId('user-menu-password'))
    await screen.findByTestId('user-menu-account-panel')
    await user.type(screen.getByLabelText(/当前密码|Current password/i), 'password-123')
    await user.type(screen.getByLabelText(/^(新密码|New password)$/i), 'newpass999')
    await user.type(screen.getByLabelText(/(确认新密码|Confirm new password)/i), 'different')
    await user.click(screen.getByTestId('user-menu-account-save'))
    await vi.waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/不一致|do not match/)
    })
    expect(fired).toBe(0)
  })
})
