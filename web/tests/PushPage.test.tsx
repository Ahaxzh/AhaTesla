import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen, waitFor } from '@testing-library/react'
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
