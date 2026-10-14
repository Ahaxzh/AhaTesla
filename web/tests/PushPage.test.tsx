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

/** 等待推送规则加载完成（switch 出现且状态稳定） */
async function findSwitch(name: string) {
  return screen.findByRole('switch', { name })
}

describe('PushPage', () => {
  it('渲染推送规则开关（初始状态来自 API）', async () => {
    renderWithProviders(<PushPage />)
    expect(await findSwitch('行程结束通知')).toBeChecked()
    expect(await findSwitch('充电开始通知')).not.toBeChecked()
    expect(await findSwitch('充电结束通知')).toBeChecked()
    expect(await findSwitch('周报')).toBeChecked()
    expect(await findSwitch('月报')).toBeChecked()
  })

  it('切换开关发送 PUT 并乐观更新', async () => {
    const user = userEvent.setup()
    const bodies: unknown[] = []
    server.use(
      http.put('/api/push-rules', async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ ...(bodies.at(-1) as object) })
      }),
    )
    renderWithProviders(<PushPage />)
    await findSwitch('充电开始通知')
    const sw = screen.getByRole('switch', { name: '充电开始通知' })
    await user.click(sw)
    await waitFor(() => expect(screen.getByRole('switch', { name: '充电开始通知' })).toBeChecked())
    expect(bodies[0]).toMatchObject({ chargingStart: true })
  })

  it('周报开启时显示发送日选择', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PushPage />)
    await findSwitch('周报')
    expect(screen.getByRole('button', { name: '周一' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: '周五' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '周五' })).toHaveAttribute('aria-pressed', 'true'))
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
          feishu: { enabled: true, connected: false, appAlias: null, lastEventAt: null },
          web: { enabled: true },
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

  it('推送规则加载失败时仍渲染页面骨架', async () => {
    server.use(
      http.get('/api/push-rules', () => HttpResponse.json({ error: { code: 'X', message: 'fail' } }, { status: 500 })),
    )
    renderWithProviders(<PushPage />)
    expect(await screen.findByTestId('feishu-card')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })
})
