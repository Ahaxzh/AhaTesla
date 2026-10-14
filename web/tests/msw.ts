import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import type {
  Charge,
  DashboardData,
  PricingData,
  PushRules,
  ChannelsData,
  SystemStatus,
  SystemEvent,
  Trip,
} from '@/types'

export const mockUser = { username: 'aha', initialized: true }

export const mockTrip: Trip = {
  id: 101,
  startAt: '2026-10-10T08:30:00+08:00',
  endAt: '2026-10-10T09:05:00+08:00',
  distanceKm: 32.4,
  durationMin: 35,
  energyKWh: 5.8,
  costCny: 4.35,
  startAddress: '家',
  endAddress: '公司',
  kwhPer100km: 17.9,
  routeKey: 'home-office',
}

export const mockCharge: Charge = {
  id: 201,
  startAt: '2026-10-09T22:10:00+08:00',
  endAt: '2026-10-10T06:40:00+08:00',
  locationName: '家庭充电桩',
  energyAddedKWh: 41.2,
  costCny: 20.6,
  pricePerUnit: 0.5,
  startBattery: 18,
  endBattery: 85,
  durationMin: 510,
  powerMaxKw: 7.4,
}

export const mockDashboard: DashboardData = {
  car: {
    name: 'Model 3 长续航',
    currentBattery: 72,
    rangeKm: 358,
    state: 'online',
    odometerKm: 24560,
  },
  monthStats: { distanceKm: 1240.5, energyKWh: 223.1, costCny: 168.4, driveCount: 42, driveHours: 28.5 },
  weekStats: { distanceKm: 310.2, energyKWh: 55.8, costCny: 41.2 },
  fuelComparison: { fuelCostCny: 620.25, source: 'model', asOf: '2026-10-01' },
  recentTrips: [mockTrip],
  recentCharges: [mockCharge],
}

export const mockPricing: PricingData = {
  defaultRateCnyPerKwh: 0.52,
  locations: [
    { id: 1, name: '家庭充电桩', pricePerUnit: 0.5, sessionFee: null, billingType: 'kWh' },
    { id: 2, name: '超充 上海站', pricePerUnit: 1.85, sessionFee: 0, billingType: 'kWh' },
  ],
}

export const mockPushRules: PushRules = {
  tripEnd: true,
  chargingStart: false,
  chargingDone: true,
  weeklyReport: true,
  weeklyReportDay: 1,
  monthlyReport: true,
}

export const mockChannels: ChannelsData = {
  feishu: { enabled: true, connected: true, appAlias: 'cli_test', lastEventAt: '2026-10-12T10:00:00+08:00' },
  web: { enabled: true },
}

export const mockSystemStatus: SystemStatus = {
  teslamate: { dbOk: true, mqttOk: true, lastDriveAt: '2026-10-13T20:00:00+08:00', driveCount: 42 },
  uptime: 86400 * 3 + 3600,
  version: '0.1.0',
}

export const mockEvents: SystemEvent[] = [
  { id: 1, at: '2026-10-13T20:01:00+08:00', level: 'info', type: 'push', message: '行程结束通知已发送至飞书' },
  { id: 2, at: '2026-10-12T09:00:00+08:00', level: 'warn', type: 'mqtt', message: 'MQTT 短暂重连' },
]

/** 常用 handlers，测试里可按需覆盖 */
export const defaultHandlers = [
  http.get('/api/auth/me', () => HttpResponse.json(mockUser)),
  http.post('/api/auth/login', async ({ request }) => {
    const body = (await request.json()) as { username: string; password: string }
    if (body.username === 'aha' && body.password === 'pass1234') {
      return HttpResponse.json({ token: 't', user: mockUser })
    }
    return HttpResponse.json({ error: { code: 'AUTH_FAILED', message: '用户名或密码错误' } }, { status: 401 })
  }),
  http.get('/api/dashboard', () => HttpResponse.json(mockDashboard)),
  http.get('/api/trips', ({ request }) => {
    const url = new URL(request.url)
    const limit = Number(url.searchParams.get('limit') ?? 50)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const total = 45
    const items = Array.from({ length: Math.min(limit, Math.max(total - offset, 0)) }, (_, i) => ({
      ...mockTrip,
      id: offset + i + 1,
      startAddress: `起点${offset + i + 1}`,
    }))
    return HttpResponse.json({ total, items })
  }),
  http.get('/api/trips/:id', ({ params }) =>
    HttpResponse.json({ ...mockTrip, id: Number(params.id), route: [[121.4, 31.22], [121.42, 31.23], [121.45, 31.25]] }),
  ),
  http.get('/api/charging', () => HttpResponse.json({ total: 1, items: [mockCharge] })),
  http.get('/api/charging/stats', () =>
    HttpResponse.json({
      totalKWh: 223.1,
      totalCostCny: 168.4,
      avgPricePerKWh: 0.76,
      byLocation: [
        { name: '家庭充电桩', count: 20, kwh: 820, cost: 410, pricePerUnit: 0.5 },
        { name: '超充 上海站', count: 3, kwh: 95, cost: 175.8, pricePerUnit: 1.85 },
      ],
    }),
  ),
  http.get('/api/pricing', () => HttpResponse.json(mockPricing)),
  http.put('/api/pricing/default', async ({ request }) => {
    const body = (await request.json()) as { rate: number }
    return HttpResponse.json({ ok: true, rate: body.rate })
  }),
  http.get('/api/pricing/history', () => HttpResponse.json([])),
  http.get('/api/channels', () => HttpResponse.json(mockChannels)),
  http.put('/api/channels/feishu', () => HttpResponse.json({ ok: true, connected: true })),
  http.post('/api/channels/feishu/test', () => HttpResponse.json({ ok: true, message: '测试卡片已发送' })),
  http.get('/api/push-rules', () => HttpResponse.json(mockPushRules)),
  http.put('/api/push-rules', async ({ request }) => HttpResponse.json(await request.json())),
  http.get('/api/system/status', () => HttpResponse.json(mockSystemStatus)),
  http.get('/api/system/events', () => HttpResponse.json(mockEvents)),
]

export const server = setupServer(...defaultHandlers)
