import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { http, HttpResponse } from 'msw'

import ReportsPage from '@/pages/ReportsPage'
import { renderWithProviders } from './test-utils'
import { server } from './msw'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/** 日报不落归档：手动重发后 toast 逐通道汇报送达结果（排障一眼看出挂在哪个渠道） */
describe('ReportsPage 日报手动重发', () => {
  it('点击「重发昨日日报」→ 展示各通道送达结果', async () => {
    server.use(
      http.get('/api/reports', () => HttpResponse.json({ items: [] })),
      http.post('/api/reports/generate', async ({ request }) => {
        const body = (await request.json()) as { type: string }
        expect(body.type).toBe('daily')
        return HttpResponse.json({
          ok: true,
          type: 'daily',
          periodLabel: '10/21 日报',
          results: { telegram: { sent: true }, feishu: { sent: false, reason: 'auth_failed' } },
        })
      }),
    )
    renderWithProviders(
      <Routes>
        <Route path="/reports" element={<ReportsPage />} />
      </Routes>,
      { route: '/reports' },
    )

    await userEvent.click(await screen.findByTestId('generate-daily'))
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('日报已推送')
    })
    // 逐通道结果：Telegram 成功 ✓、飞书失败 ✗
    expect(screen.getByRole('status')).toHaveTextContent('Telegram ✓')
    expect(screen.getByRole('status')).toHaveTextContent('飞书 ✗')
  })

  it('昨日无数据 → 409 report_empty 错误提示', async () => {
    server.use(
      http.get('/api/reports', () => HttpResponse.json({ items: [] })),
      http.post('/api/reports/generate', () =>
        HttpResponse.json({ error: { code: 'report_empty', message: '昨日无行程且无充电，日报已跳过' } }, { status: 409 }),
      ),
    )
    renderWithProviders(
      <Routes>
        <Route path="/reports" element={<ReportsPage />} />
      </Routes>,
      { route: '/reports' },
    )

    await userEvent.click(await screen.findByTestId('generate-daily'))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('昨日无行程且无充电')
    })
  })

  it('周报/月报按钮保留原有生成行为', async () => {
    let calledType = ''
    server.use(
      http.get('/api/reports', () => HttpResponse.json({ items: [] })),
      http.post('/api/reports/generate', async ({ request }) => {
        calledType = ((await request.json()) as { type: string }).type
        return HttpResponse.json({ ok: true, id: 7 })
      }),
    )
    renderWithProviders(
      <Routes>
        <Route path="/reports" element={<ReportsPage />} />
      </Routes>,
      { route: '/reports' },
    )

    await userEvent.click(await screen.findByTestId('generate-weekly'))
    await waitFor(() => expect(calledType).toBe('weekly'))
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('报告已生成')
    })
  })
})
