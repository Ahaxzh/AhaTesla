import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import SettingsPage from '@/pages/SettingsPage'
import { renderWithProviders } from './test-utils'
import { server } from './msw'
import { mockSettings } from './msw'

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
    expect(screen.getByTestId('change-password-card')).toBeInTheDocument()
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
    await screen.findByTestId('settings-cars')
    // 默认两辆 mock,主车为 1(cars 查询异步,等行出现)
    expect(await screen.findByTestId('car-primary-1')).toBeChecked()
    expect(screen.getByTestId('car-primary-2')).not.toBeChecked()
    await user.click(screen.getByTestId('car-primary-2'))
    await user.type(screen.getByTestId('car-alias-2'), '老婆的Y')
    await user.click(screen.getByTestId('cars-save'))
    await waitFor(() => expect(savedBody).toMatchObject({ primaryCarId: 2, carAliases: { '2': '老婆的Y' } }))
  })

  it('推送矩阵：9 事件 × 6 渠道，含每日早报与告警三行(P2)', async () => {
    renderWithProviders(<SettingsPage />)
    // 矩阵列表要等 pushRules 查询返回（此前是骨架屏）
    const list = await screen.findByTestId('push-matrix-list')
    // 9 行事件 × 6 渠道 chip 全渲染（m4b 起 wecom/ntfy/bark 并列;P2 告警三行）
    expect(within(list).getAllByTestId(/^matrix-/).length).toBeGreaterThanOrEqual(9 * 6)
    expect(within(list).getByText('每日早报')).toBeInTheDocument()
    // 告警三行存在且 desc 标注不受静音时段影响
    expect(within(list).getByText('数据断联告警')).toBeInTheDocument()
    expect(within(list).getByText('充电提前中止')).toBeInTheDocument()
    expect(within(list).getByText('胎压过低')).toBeInTheDocument()
    expect(within(list).getByText(/不受静音时段影响/)).toBeInTheDocument()
    // 告警默认即时渠道开(msw 矩阵)
    expect(screen.getByTestId('matrix-outage-telegram')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('matrix-outage-wecom')).toHaveAttribute('aria-pressed', 'false')
    // msw 默认 daily: webpush=true → chip 按钮处于按下态;新渠道默认关
    expect(screen.getByTestId('matrix-daily-webpush')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('matrix-daily-feishu')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('matrix-daily-wecom')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('matrix-daily-ntfy')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('matrix-daily-bark')).toHaveAttribute('aria-pressed', 'false')
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
    renderWithProviders(<SettingsPage />)
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
    await screen.findByTestId('change-password-card')
    await user.type(screen.getByLabelText('当前密码'), 'old')
    await user.type(screen.getByLabelText('新密码'), 'newpass99')
    await user.type(screen.getByLabelText('确认新密码'), 'newpass99')
    await user.click(screen.getByTestId('password-submit'))
    expect(await screen.findByText('账户已更新')).toBeInTheDocument()
    await waitFor(() => expect((screen.getByLabelText('新密码') as HTMLInputElement).value).toBe(''))
  })
})
