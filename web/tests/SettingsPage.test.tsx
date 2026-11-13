import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import SettingsPage from '@/pages/SettingsPage'
import { renderWithProviders } from './test-utils'
import { server } from './msw'
import { mockSettings } from './msw'

/** v0.3 分区默认折叠：先点头部展开再交互 */
const openSection = async (user: ReturnType<typeof userEvent.setup>, id: string) => {
  await user.click(screen.getByTestId(`settings-${id}-header`))
}

beforeAll(() => server.listen())
afterEach(() => {
  server.resetHandlers()
  localStorage.clear()
  document.documentElement.dataset.theme = ''
})
afterAll(() => server.close())

describe('SettingsPage', () => {
  it('渲染账户卡片与修改密码表单', async () => {
    renderWithProviders(<SettingsPage />)
    // v2.2：账户信息合并进页头（无独立 account-card）
    expect(await screen.findByText(/aha.*单用户模式/s)).toBeInTheDocument()
    // v0.3 默认折叠：分区在、内容收起
    const sec = screen.getByTestId('change-password-card')
    expect(sec).toHaveAttribute('data-open', 'false')
    expect(screen.queryByLabelText('当前密码')).not.toBeInTheDocument()
  })

  it('分区结构：外观/车辆/账本/电价/AI/推送/系统/安全 八分区，导航与卡片一一对应', async () => {
    renderWithProviders(<SettingsPage />)
    // 八分区卡片齐备
    expect(await screen.findByTestId('settings-appearance')).toBeInTheDocument()
    expect(screen.getByTestId('settings-cars')).toBeInTheDocument()
    expect(screen.getByTestId('settings-ledger')).toBeInTheDocument()
    expect(screen.getByTestId('settings-pricing')).toBeInTheDocument()
    expect(screen.getByTestId('settings-ai')).toBeInTheDocument()
    expect(screen.getByTestId('settings-push-matrix')).toBeInTheDocument()
    expect(screen.getByTestId('settings-system')).toBeInTheDocument()
    expect(screen.getByTestId('change-password-card')).toBeInTheDocument()
    // 导航锚点与分区一一对应（桌面 aside + 移动横向 两份导航都要 8 项）
    const navs = screen.getAllByTestId('settings-nav')
    expect(navs).toHaveLength(2)
    for (const nav of navs) expect(nav.querySelectorAll('a')).toHaveLength(8)
    // 去重回归：数据源健康小卡已并入系统分区，设置页不再出现
    expect(screen.queryByText('累计行程')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resync-meta')).not.toBeInTheDocument()
  })

  it('m4e 车辆分区:主车 radio + 别名输入 + 保存 PUT body', async () => {
    const user = userEvent.setup()
    let savedBody: unknown = null
    server.use(
      http.put('/api/settings', async ({ request }) => {
        savedBody = await request.json()
        return HttpResponse.json({ ok: true, settings: { ...mockSettings } })
      }),
    )
    renderWithProviders(<SettingsPage />)
    await openSection(user, 'cars')
    await screen.findByTestId('settings-cars')
    // 默认两辆 mock,主车为 1(cars 查询异步,等行出现)
    expect(await screen.findByTestId('car-primary-1')).toBeChecked()
    expect(screen.getByTestId('car-primary-2')).not.toBeChecked()
    await user.click(screen.getByTestId('car-primary-2'))
    await user.type(screen.getByTestId('car-alias-2'), '老婆的Y')
    await user.click(screen.getByTestId('cars-save'))
    await waitFor(() => expect(savedBody).toMatchObject({ primaryCarId: 2, carAliases: { '2': '老婆的Y' } }))
  })

  it('推送分区（v0.3 事件级总开关）：9 事件各一个 Toggle，副行显示启用渠道；关=全静音', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)
    await openSection(user, 'push')
    // 列表要等 pushRules 查询返回（此前是骨架屏）
    const list = await screen.findByTestId('push-matrix-list')
    // 9 行事件 Toggle 全渲染（含每日早报与告警三行）
    expect(within(list).getAllByTestId(/^push-event-toggle-/).length).toBe(9)
    expect(within(list).getByText('每日早报')).toBeInTheDocument()
    expect(within(list).getByText('数据断联告警')).toBeInTheDocument()
    expect(within(list).getByText('充电提前中止')).toBeInTheDocument()
    expect(within(list).getByText('胎压过低')).toBeInTheDocument()
    // msw 矩阵 outage: webpush/telegram/feishu 开 → 副行列出渠道名，switch 亮
    expect(screen.getByTestId('push-event-toggle-outage')).toHaveAttribute('aria-checked', 'true')
    expect(list).toHaveTextContent('经 Web Push · Telegram · 飞书')
    // chargingStart 全关 → 静音态
    expect(screen.getByTestId('push-event-toggle-chargingStart')).toHaveAttribute('aria-checked', 'false')
  })

  it('AI 助手分区：填写保存断言 PUT body，测试按钮成功 toast', async () => {
    const user = userEvent.setup()
    const bodies: unknown[] = []
    server.use(
      http.put('/api/ai/config', async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ ok: true })
      }),
    )
    renderWithProviders(<SettingsPage />)
    await openSection(user, 'ai')
    await screen.findByTestId('settings-ai')
    // 默认关闭、密钥输入框存在且为 password 型
    expect(screen.getByTestId('ai-api-key')).toHaveAttribute('type', 'password')
    await user.type(screen.getByTestId('ai-base-url'), 'https://api.openai.com/v1')
    await user.type(screen.getByTestId('ai-model'), 'gpt-4o-mini')
    await user.type(screen.getByTestId('ai-api-key'), 'sk-test-123')
    await user.click(screen.getByTestId('ai-save'))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({
      enabled: false,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-123',
    })
    // 测试连通：成功 toast 显示 preview 前 50 字
    await user.click(screen.getByTestId('ai-test'))
    expect(await screen.findByText(/连通正常/)).toBeInTheDocument()
  })

  it('外观分区：主题切换写 dataset，语言切换即时生效', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)
    await openSection(user, 'appearance')
    await screen.findByTestId('settings-appearance')
    // 默认中文（桌面导航 + 分区标题各出现一次）
    expect(screen.getAllByText('外观').length).toBeGreaterThanOrEqual(2)
    fireEvent.click(screen.getByTestId('theme-light'))
    expect(document.documentElement.dataset.theme).toBe('light')
    fireEvent.click(screen.getByTestId('theme-dark'))
    expect(document.documentElement.dataset.theme).toBe('dark')
    // 切英文：页面标题 + 分区导航即时变英文（词典命中；Appearance 在两份导航+分区标题共 3 处）
    fireEvent.click(screen.getByTestId('lang-en'))
    expect(await screen.findByText('Settings')).toBeInTheDocument()
    expect(screen.getAllByText('Appearance')).toHaveLength(3)
    fireEvent.click(screen.getByTestId('lang-zh'))
    expect((await screen.findAllByText('外观')).length).toBeGreaterThanOrEqual(2)
  })

  it('密码不一致与过短密码被前端拦截', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)
    await openSection(user, 'security')
    await screen.findByTestId('change-password-card')
    await user.type(screen.getByLabelText('当前密码'), 'old')
    await user.type(screen.getByLabelText('新密码'), '123')
    await user.type(screen.getByLabelText('确认新密码'), '123')
    await user.click(screen.getByTestId('password-submit'))
    expect(await screen.findByTestId('password-error')).toHaveTextContent('至少 8 位')

    await user.clear(screen.getByLabelText('新密码'))
    await user.clear(screen.getByLabelText('确认新密码'))
    await user.type(screen.getByLabelText('新密码'), 'newpass99')
    await user.type(screen.getByLabelText('确认新密码'), 'different')
    await user.click(screen.getByTestId('password-submit'))
    expect(await screen.findByTestId('password-error')).toHaveTextContent('不一致')
  })

  it('修改密码成功提示', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/auth/change-password', () => HttpResponse.json({ ok: true })),
    )
    renderWithProviders(<SettingsPage />)
    await openSection(user, 'security')
    await screen.findByTestId('change-password-card')
    await user.type(screen.getByLabelText('当前密码'), 'old')
    await user.type(screen.getByLabelText('新密码'), 'newpass99')
    await user.type(screen.getByLabelText('确认新密码'), 'newpass99')
    await user.click(screen.getByTestId('password-submit'))
    expect(await screen.findByText('账户已更新')).toBeInTheDocument()
    await waitFor(() => expect((screen.getByLabelText('新密码') as HTMLInputElement).value).toBe(''))
  })

  // v0.2.x：头像菜单「账户安全」跳 /settings#settings-security 后滚动落地（此前只导航不滚动）
  it('hash 锚点直达：#settings-security 渲染后滚动到账户安全分区', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    renderWithProviders(<SettingsPage />, { route: '/settings#settings-security' })
    // 锚点直达自动展开（v0.3）：分区 data-open=true 且表单渲染
    await waitFor(() => expect(screen.getByTestId('change-password-card')).toHaveAttribute('data-open', 'true'))
    await screen.findByLabelText('当前密码')
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    // 侧栏高亮同步切到 security
    const desktopNav = screen.getAllByTestId('settings-nav')[0]
    expect(desktopNav.querySelector('a[href="#settings-security"]')?.className).toContain('text-white')
  })
})
