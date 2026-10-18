import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import PushPage from '@/pages/PushPage'
import { renderWithProviders } from './test-utils'
import { server } from './msw'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('PushPage（三渠道平权 + 矩阵迁移到设置页）', () => {
  it('渲染 Web Push / Telegram / 飞书 三渠道卡片（AC-10.1）', async () => {
    renderWithProviders(<PushPage />)
    expect(await screen.findByTestId('webpush-card')).toBeInTheDocument()
    // 等渠道状态数据到位再断言（findBy 轮询）
    expect(await screen.findByTestId('webpush-status')).toHaveTextContent('1 台设备')
    expect(await screen.findByTestId('telegram-status')).toHaveTextContent('未连接')
    expect(screen.getByTestId('feishu-card')).toBeInTheDocument()
  })

  it('Web Push：HTTPS 环境显示一键开启与测试按钮', async () => {
    renderWithProviders(<PushPage />)
    expect(await screen.findByTestId('webpush-enable')).toBeInTheDocument()
    expect(screen.getByTestId('webpush-test')).toBeEnabled()
    expect(screen.queryByTestId('webpush-https-warning')).not.toBeInTheDocument()
  })

  it('Web Push：非 HTTPS 环境置灰并显示引导文案（AC-11.0）', async () => {
    server.use(
      http.get('/api/push/env', () => HttpResponse.json({ https: false, vapidPublicKey: null })),
    )
    renderWithProviders(<PushPage />)
    expect(await screen.findByTestId('webpush-https-warning')).toHaveTextContent(/非 HTTPS/)
    expect(screen.queryByTestId('webpush-enable')).not.toBeInTheDocument()
  })

  it('Telegram：填写 Token/ChatID 后可保存（密文不回传）', async () => {
    const user = userEvent.setup()
    const bodies: unknown[] = []
    server.use(
      http.put('/api/channels/telegram', async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ ok: true, connected: true })
      }),
    )
    renderWithProviders(<PushPage />)
    await screen.findByTestId('telegram-card')
    expect(screen.getByTestId('telegram-save')).toBeDisabled() // 无已存配置且未填写
    await user.type(screen.getByTestId('tg-token-input'), '123456789:AAFx')
    await user.type(screen.getByTestId('tg-chat-input'), '987654321')
    expect(screen.getByTestId('telegram-save')).toBeEnabled()
    await user.click(screen.getByTestId('telegram-save'))
    await waitFor(() => expect(bodies[0]).toMatchObject({ enabled: true, botToken: '123456789:AAFx', chatId: '987654321' }))
  })

  it('飞书卡片：状态、AppID 输入与测试发送', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PushPage />)
    expect(await screen.findByTestId('feishu-status')).toHaveTextContent('已连接')
    const testBtn = screen.getByTestId('feishu-test')
    expect(testBtn).toBeEnabled()
    await user.click(testBtn)
    expect(await screen.findByText('测试卡片已发送')).toBeInTheDocument()
  })

  it('未连接时测试按钮禁用；填写 AppID 可保存', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/channels', () =>
        HttpResponse.json({
          webpush: { enabled: false, configured: false, subscriberCount: 0 },
          telegram: { enabled: false, connected: false, botAlias: null, chatIdAlias: null },
          feishu: { enabled: true, connected: false, appAlias: null, lastEventAt: null },
        }),
      ),
    )
    renderWithProviders(<PushPage />)
    expect(await screen.findByTestId('feishu-status')).toHaveTextContent('未连接')
    expect(screen.getByTestId('feishu-test')).toBeDisabled()
    expect(screen.getByTestId('feishu-save')).toBeDisabled()
    await user.type(screen.getByLabelText('App ID'), 'cli_newapp')
    expect(screen.getByTestId('feishu-save')).toBeEnabled()
  })
})

// ---- m4b 三新渠道:企业微信 / ntfy / Bark ----------------------------------------
describe('m4b 新渠道卡片（企业微信/ntfy/Bark）', () => {
  it('三卡渲染,默认未配置,测试按钮禁用', async () => {
    renderWithProviders(<PushPage />)
    expect(await screen.findByTestId('wecom-card')).toBeInTheDocument()
    expect(screen.getByTestId('ntfy-card')).toBeInTheDocument()
    expect(screen.getByTestId('bark-card')).toBeInTheDocument()
    expect(await screen.findByTestId('wecom-status')).toHaveTextContent('未配置')
    expect(screen.getByTestId('ntfy-status')).toHaveTextContent('未配置')
    expect(screen.getByTestId('bark-status')).toHaveTextContent('未配置')
    expect(screen.getByTestId('wecom-test')).toBeDisabled()
    expect(screen.getByTestId('ntfy-test')).toBeDisabled()
    expect(screen.getByTestId('bark-test')).toBeDisabled()
  })

  it('企业微信:填 webhook key 保存断言 PUT body;已配置后测试按钮可发', async () => {
    const user = userEvent.setup()
    const bodies: unknown[] = []
    // 状态化 mock:PUT 成功后 configured 翻转,invalidate 重查自然生效
    let wecomConfigured = false
    const channelJson = () =>
      HttpResponse.json({
        webpush: { enabled: false, configured: false, subscriberCount: 0 },
        telegram: { enabled: false, connected: false, botAlias: null, chatIdAlias: null },
        feishu: { enabled: false, connected: false, appAlias: null, lastEventAt: null },
        wecom: { enabled: wecomConfigured, configured: wecomConfigured, webhookKeyAlias: wecomConfigured ? 'wk-a' : null },
        ntfy: { enabled: false, configured: false, serverUrl: '', topic: '' },
        bark: { enabled: false, configured: false, serverUrl: '', deviceKeyAlias: null },
      })
    server.use(
      http.get('/api/channels', channelJson),
      http.put('/api/channels/wecom', async ({ request }) => {
        bodies.push(await request.json())
        wecomConfigured = true
        return HttpResponse.json({ ok: true })
      }),
    )
    renderWithProviders(<PushPage />)
    await screen.findByTestId('wecom-card')
    expect(await screen.findByTestId('wecom-status')).toHaveTextContent('未配置')
    expect(screen.getByTestId('wecom-save')).toBeDisabled() // 未配置且未填写
    await user.type(screen.getByTestId('wecom-key'), 'wk-abcdef-1234')
    expect(screen.getByTestId('wecom-save')).toBeEnabled()
    await user.click(screen.getByTestId('wecom-save'))
    await waitFor(() => expect(bodies[0]).toMatchObject({ enabled: true, webhookKey: 'wk-abcdef-1234' }))
    // 保存触发 invalidate → 重查后状态翻转,测试按钮可用并 toast message
    expect(await screen.findByTestId('wecom-status')).toHaveTextContent('已配置')
    expect(screen.getByTestId('wecom-test')).toBeEnabled()
    await user.click(screen.getByTestId('wecom-test'))
    expect(await screen.findByText('企业微信测试消息已发送')).toBeInTheDocument()
  })

  it('ntfy:填 server + topic 保存断言 PUT body', async () => {
    const user = userEvent.setup()
    const bodies: unknown[] = []
    server.use(
      http.put('/api/channels/ntfy', async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ ok: true })
      }),
    )
    renderWithProviders(<PushPage />)
    await screen.findByTestId('ntfy-card')
    expect(screen.getByTestId('ntfy-save')).toBeDisabled()
    await user.type(screen.getByTestId('ntfy-server'), 'https://ntfy.example.com')
    await user.type(screen.getByTestId('ntfy-topic'), 'my-tesla')
    expect(screen.getByTestId('ntfy-save')).toBeEnabled()
    await user.click(screen.getByTestId('ntfy-save'))
    await waitFor(() =>
      expect(bodies[0]).toMatchObject({ enabled: true, serverUrl: 'https://ntfy.example.com', topic: 'my-tesla' }),
    )
  })

  it('Bark:已配置状态下留空保存,body 不含 deviceKey(留空=不修改)', async () => {
    const user = userEvent.setup()
    const bodies: unknown[] = []
    server.use(
      http.get('/api/channels', () =>
        HttpResponse.json({
          webpush: { enabled: false, configured: false, subscriberCount: 0 },
          telegram: { enabled: false, connected: false, botAlias: null, chatIdAlias: null },
          feishu: { enabled: false, connected: false, appAlias: null, lastEventAt: null },
          wecom: { enabled: false, configured: false, webhookKeyAlias: null },
          ntfy: { enabled: false, configured: false, serverUrl: '', topic: '' },
          bark: { enabled: true, configured: true, serverUrl: 'https://api.day.app', deviceKeyAlias: 'abcd' },
        }),
      ),
    )
    server.use(
      http.put('/api/channels/bark', async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ ok: true })
      }),
    )
    renderWithProviders(<PushPage />)
    expect(await screen.findByTestId('bark-status')).toHaveTextContent('已配置')
    // 密钥框留空直接保存:仅 enabled,不带 deviceKey
    await user.click(screen.getByTestId('bark-save'))
    await waitFor(() => expect(bodies[0]).toEqual({ enabled: true }))
  })
})

// ---- iOS PWA 推送体验:安装引导 / 权限被拒恢复 / 订阅自愈 ------------------------
describe('WebPush iOS PWA 体验', () => {
  const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  const nav = window.navigator as Navigator & { standalone?: boolean }
  const uaDesc = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent')

  function stubUa(ua: string) {
    Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })
  }

  afterEach(() => {
    // 恢复 UA / standalone / Notification / serviceWorker 打桩
    if (uaDesc) Object.defineProperty(window.navigator, 'userAgent', uaDesc)
    else delete (window.navigator as { userAgent?: string }).userAgent
    delete nav.standalone
    vi.unstubAllGlobals()
    delete (window.navigator as { serviceWorker?: unknown }).serviceWorker
  })

  it('iOS Safari 未安装到主屏幕:显示三步安装引导且订阅按钮禁用', async () => {
    stubUa(IOS_UA)
    renderWithProviders(<PushPage />)
    expect(await screen.findByTestId('webpush-ios-install-guide')).toHaveTextContent('添加到主屏幕')
    expect(screen.getByTestId('webpush-enable')).toBeDisabled()
    expect(screen.queryByTestId('webpush-permission-denied')).not.toBeInTheDocument()
  })

  it('iOS 已从主屏幕打开(standalone):安装引导消失,恢复订阅流', async () => {
    stubUa(IOS_UA)
    Object.defineProperty(nav, 'standalone', { value: true, configurable: true })
    renderWithProviders(<PushPage />)
    expect(await screen.findByTestId('webpush-enable')).toBeEnabled()
    expect(screen.queryByTestId('webpush-ios-install-guide')).not.toBeInTheDocument()
  })

  it('通知权限被拒:iOS 给系统设置路径,重新检测后恢复', async () => {
    stubUa(IOS_UA)
    Object.defineProperty(nav, 'standalone', { value: true, configurable: true })
    const fake = { permission: 'denied' as NotificationPermission }
    vi.stubGlobal('Notification', fake)
    renderWithProviders(<PushPage />)
    expect(await screen.findByTestId('webpush-permission-denied')).toHaveTextContent('系统设置 → 通知')
    expect(screen.queryByTestId('webpush-enable')).not.toBeInTheDocument()
    // 用户去系统设置打开后回来点「重新检测」
    fake.permission = 'granted'
    fireEvent.click(screen.getByTestId('webpush-permission-recheck'))
    expect(await screen.findByTestId('webpush-enable')).toBeEnabled()
  })

  it('桌面浏览器权限被拒:提示站点设置路径', async () => {
    vi.stubGlobal('Notification', { permission: 'denied' as NotificationPermission })
    renderWithProviders(<PushPage />)
    expect(await screen.findByTestId('webpush-permission-denied')).toHaveTextContent('站点设置')
  })

  it('订阅自愈:权限已授予但本地订阅缺失 → 静默重订并上报', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' as NotificationPermission })
    const fakeSub = {
      toJSON: () => ({ endpoint: 'https://push.example/sub-1', keys: { p256dh: 'pk', auth: 'ak' } }),
    }
    Object.defineProperty(window.navigator, 'serviceWorker', {
      value: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: () => Promise.resolve(null),
            subscribe: () => Promise.resolve(fakeSub),
          },
        }),
      },
      configurable: true,
    })
    server.use(
      http.post('/api/push/webpush/init-vapid', () =>
        HttpResponse.json({ ok: true, publicKey: 'QUJD', created: false }),
      ),
    )
    const bodies: unknown[] = []
    server.use(
      http.post('/api/push/webpush/subscribe', async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ ok: true })
      }),
    )
    renderWithProviders(<PushPage />)
    await waitFor(() => {
      expect(bodies[0]).toMatchObject({
        endpoint: 'https://push.example/sub-1',
        keys: { p256dh: 'pk', auth: 'ak' },
      })
    })
    // 静默路径不应弹「已开启」toast
    expect(screen.queryByText('Web Push 已开启，本设备将收到通知')).not.toBeInTheDocument()
  })
})
