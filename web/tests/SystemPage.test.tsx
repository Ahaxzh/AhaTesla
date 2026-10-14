import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import SystemPage from '@/pages/SystemPage'
import { renderWithProviders } from './test-utils'
import { server } from './msw'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('SystemPage', () => {
  it('渲染 DB/MQTT 状态、版本与运行时长', async () => {
    renderWithProviders(<SystemPage />)
    expect(await screen.findByText('PostgreSQL 正常')).toBeInTheDocument()
    expect(screen.getByText('MQTT 正常')).toBeInTheDocument()
    expect(screen.getByTestId('system-status')).toBeInTheDocument()
    expect(screen.getByText(/v0\.1\.0/)).toBeInTheDocument()
    expect(screen.getByText(/3 天/)).toBeInTheDocument()
  })

  it('渲染事件日志', async () => {
    renderWithProviders(<SystemPage />)
    const log = await screen.findByTestId('event-list')
    expect(log).toHaveTextContent('行程结束通知已发送至飞书')
    expect(log).toHaveTextContent('MQTT 短暂重连')
  })

  it('服务断开时显示异常状态', async () => {
    server.use(
      http.get('/api/system/status', () =>
        HttpResponse.json({
          teslamate: { dbOk: false, mqttOk: false, lastDriveAt: null, driveCount: 0 },
          uptime: 60,
          version: '0.1.0',
        }),
      ),
    )
    renderWithProviders(<SystemPage />)
    expect(await screen.findByText('数据库断开')).toBeInTheDocument()
    expect(screen.getByText('MQTT 断开')).toBeInTheDocument()
  })
})
