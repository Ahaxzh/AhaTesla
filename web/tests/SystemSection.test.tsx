import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { SystemSection } from '@/components/settings/SystemSection'
import { renderWithProviders } from './test-utils'
import { server } from './msw'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('SystemSection', () => {
  it('渲染总览横幅、DB/MQTT 状态、版本与运行时长', async () => {
    renderWithProviders(<SystemSection />)
    // 健康时总览横幅为绿色「全部系统正常运行」+ 版本 pill
    expect(await screen.findByText('全部系统正常运行')).toBeInTheDocument()
    expect(screen.getByTestId('system-overview')).toBeInTheDocument()
    expect(screen.getByText(/v0\.1\.0/)).toBeInTheDocument()
    // 瓦片：DB/MQTT 状态行 + 服务运行时长（mock uptime = 3 天 1 小时）
    expect(await screen.findByText('PostgreSQL 正常')).toBeInTheDocument()
    expect(screen.getByText('MQTT 正常')).toBeInTheDocument()
    expect(screen.getByTestId('system-status')).toBeInTheDocument()
    expect(screen.getByTestId('db-latency')).toBeInTheDocument()
    expect(screen.getByText(/3 天/)).toBeInTheDocument()
  })

  it('渲染事件日志并支持等级筛选', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SystemSection />)
    const log = await screen.findByTestId('event-list')
    expect(log).toHaveTextContent('行程结束通知已发送至飞书')
    expect(log).toHaveTextContent('MQTT 短暂重连')
    // 头部条数 pill 显示全部条数
    expect(screen.getByText('2 条')).toBeInTheDocument()

    // 切到「警告」：只剩 warn 事件
    await user.click(screen.getByTestId('event-filter-warn'))
    const warnLog = await screen.findByTestId('event-list')
    expect(warnLog).toHaveTextContent('MQTT 短暂重连')
    expect(warnLog).not.toHaveTextContent('行程结束通知已发送至飞书')
    expect(screen.getByText('1 条')).toBeInTheDocument()
  })

  it('服务断开时显示异常状态', async () => {
    server.use(
      http.get('/api/system/status', () =>
        HttpResponse.json({
          teslamate: { dbOk: false, mqtt: { ok: false }, lastDriveAt: null, driveCount: 0 },
          uptime: 60,
          version: '0.1.0',
        }),
      ),
    )
    renderWithProviders(<SystemSection />)
    expect(await screen.findByText('数据库断开')).toBeInTheDocument()
    // 首帧 status 未加载时 dbOk 默认 false 已显示"数据库断开"，MQTT 文案要等
    // 查询返回才渲染——必须用 findByText 消除竞态。
    expect(await screen.findByText('MQTT 断开')).toBeInTheDocument()
    // 总览横幅汇总故障项
    expect(screen.getByText('数据库断开 · MQTT 断开')).toBeInTheDocument()
  })

  it('未配置 MQTT 时显示未配置文案（AC-5.1 可选增强）', async () => {
    server.use(
      http.get('/api/system/status', () =>
        HttpResponse.json({
          teslamate: { dbOk: true, lastDriveAt: null, driveCount: 0 },
          uptime: 60,
          version: '0.1.0',
        }),
      ),
    )
    renderWithProviders(<SystemSection />)
    expect(await screen.findByText('PostgreSQL 正常')).toBeInTheDocument()
    expect(screen.getByText('未配置（轮询基线）')).toBeInTheDocument()
    expect(screen.queryByText('MQTT 正常')).not.toBeInTheDocument()
    expect(screen.queryByText('MQTT 断开')).not.toBeInTheDocument()
    // MQTT 未配置不视为故障，总览横幅仍为全绿
    expect(screen.getByText('全部系统正常运行')).toBeInTheDocument()
  })
})
