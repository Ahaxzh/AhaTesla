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

export const mockBatteryHealth = {
  sampleCount: 117,
  insufficient: false,
  healthPct: 98.2,
  baselineMaxRangeKm: 398.8,
  currentMaxRangeKm: 391.4,
  capacityKwh: 50.7,
  cycles: 56.3,
  rechargeEfficiency: 92.6,
  totalAddedKwh: 2854.9,
  trend: [
    { month: '2026-05', maxRangeKm: 392.5 },
    { month: '2026-06', maxRangeKm: 391.7 },
    { month: '2026-07', maxRangeKm: 385.1 },
    { month: '2026-08', maxRangeKm: 390.8 },
    { month: '2026-09', maxRangeKm: 391.2 },
    { month: '2026-10', maxRangeKm: 391.4 },
  ],
}

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
    tirePressure: { fl: 3.1, fr: 3.0, rl: 2.9, rr: 3.0, at: '2026-11-10T03:00:00Z' },
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
    {
      id: 1,
      name: '家庭充电桩',
      pricePerUnit: 0.5,
      sessionFee: null,
      billingType: 'kWh',
      priceMode: 'tou',
      tou: { offPeakStart: '23:00', offPeakEnd: '07:00', offPeakRate: 0.3, peakRate: 1 },
    },
    { id: 2, name: '超充 上海站', pricePerUnit: 1.85, sessionFee: 0, billingType: 'kWh', priceMode: 'fixed' },
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

// v2.1 渠道状态（/api/channels；m4b 起含企业微信/ntfy/Bark,默认未配置）
export const mockChannelStatus = {
  webpush: { enabled: true, configured: true, subscriberCount: 1 },
  telegram: { enabled: false, connected: false, botAlias: null, chatIdAlias: null },
  feishu: { enabled: true, connected: true, appAlias: 'cli_test', lastEventAt: '2026-10-12T10:00:00+08:00' },
  wecom: { enabled: false, configured: false, webhookKeyAlias: null },
  ntfy: { enabled: false, configured: false, serverUrl: '', topic: '' },
  bark: { enabled: false, configured: false, serverUrl: '', deviceKeyAlias: null },
}

// v2 推送矩阵（m4b：6 事件 × 6 渠道,新渠道默认全关）
export const mockPushMatrix = {
  matrix: {
    tripEnd: { webpush: true, telegram: false, feishu: true, wecom: false, ntfy: false, bark: false },
    chargingStart: { webpush: false, telegram: false, feishu: false, wecom: false, ntfy: false, bark: false },
    chargingDone: { webpush: true, telegram: false, feishu: true, wecom: false, ntfy: false, bark: false },
    outage: { webpush: true, telegram: true, feishu: true, wecom: false, ntfy: false, bark: false },
    chargeInterrupt: { webpush: true, telegram: true, feishu: true, wecom: false, ntfy: false, bark: false },
    tirePressure: { webpush: true, telegram: true, feishu: true, wecom: false, ntfy: false, bark: false },
    daily: { webpush: true, telegram: false, feishu: false, wecom: false, ntfy: false, bark: false },
    weekly: { webpush: false, telegram: false, feishu: true, wecom: false, ntfy: false, bark: false },
    monthly: { webpush: false, telegram: false, feishu: true, wecom: false, ntfy: false, bark: false },
  },
  weeklyReportDay: 1,
}

// m4c：BYO 模型配置（GET 回显不含明文密钥）
export const mockAiConfig = {
  enabled: false,
  baseUrl: '',
  model: '',
  hasKey: false,
  keyAlias: null,
}

export const mockTimeline = {
  windowHours: 24,
  segments: [
    { from: new Date(Date.now() - 20 * 3600_000).toISOString(), to: new Date(Date.now() - 5 * 3600_000).toISOString(), state: 'asleep' },
    { from: new Date(Date.now() - 5 * 3600_000).toISOString(), to: new Date(Date.now() - 4 * 3600_000).toISOString(), state: 'charging' },
    { from: new Date(Date.now() - 4 * 3600_000).toISOString(), to: new Date(Date.now() - 3 * 3600_000).toISOString(), state: 'asleep' },
    { from: new Date(Date.now() - 3 * 3600_000).toISOString(), to: new Date(Date.now() - 2 * 3600_000).toISOString(), state: 'driving' },
    { from: new Date(Date.now() - 2 * 3600_000).toISOString(), to: new Date().toISOString(), state: 'online' },
  ],
  summary: { drivingH: 1.0, chargingH: 1.0, asleepH: 16.0, onlineH: 2.0, offlineH: 4.0 },
}

export const mockHeatmap = {
  days: 90,
  maxKm: 50,
  daysData: Array.from({ length: 90 }, (_, i) => ({
    date: new Date(Date.now() - (89 - i) * 86400_000).toISOString().slice(0, 10),
    distanceKm: i % 7 === 0 ? 42.5 : i % 3 === 0 ? 10 : 0,
  })),
}

export const mockSettings = {
  currency: { symbol: '¥', code: 'CNY' },
  distanceUnit: 'km',
  timezone: 'Asia/Shanghai',
  fuelBaseline: { literPer100km: 8.0, fuelPriceCnyPerL: 8.2 },
  primaryCarId: 1,
  carAliases: {},
}

/** m4e:车辆清单(默认两辆,单车用例覆写) */
export const mockCars = [
  { id: 1, name: 'Model 3 长续航', alias: null, isPrimary: true },
  { id: 2, name: 'Model Y', alias: null, isPrimary: false },
]

export const mockLedgerSummary = {
  month: new Date().toISOString().slice(0, 7),
  distanceKm: 420.5,
  energyKwh: 60.2,
  totalCost: 36.12,
  costPerKm: 0.0859,
  fuelComparison: { fuelCost: 275.85, saving: 239.73, baseline: '对比基准 8L/100km @ ¥8.2/L' },
  parkingLoss: { kwh: 3.2, cost: 1.66 },
  breakdown: { drivingCost: 34.46, parkingCost: 1.66 },
}

export const mockSystemStatus: SystemStatus = {
  teslamate: { dbOk: true, mqtt: { ok: true }, lastDriveAt: '2026-10-13T20:00:00+08:00', driveCount: 42 },
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
  http.get('/api/cars', () => HttpResponse.json(mockCars)),
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
    HttpResponse.json({
      ...mockTrip,
      id: Number(params.id),
      route: [
        { t: '2026-10-13T09:00:00Z', lat: 31.22, lng: 121.4, speed: 32, elevation: 12 },
        { t: '2026-10-13T09:20:00Z', lat: 31.23, lng: 121.42, speed: 75, elevation: 28 },
        { t: '2026-10-13T09:40:00Z', lat: 31.25, lng: 121.45, speed: 105, elevation: 8 },
      ],
      positionCount: 3,
      fifo: {
        batches: [
          { source: '10-13 家庭充电桩', kwh: 5.0, price: 0.5, amount: 2.5 },
          { source: '默认电价', kwh: 2.0, price: 0.925, amount: 1.85 },
        ],
        totalCost: 4.35,
        blendedPrice: 0.621,
        exhaustedNote: null,
      },
      fuelComparison: { baseline: '对比基准 8L/100km @ ¥8.2/L（¥0.656/km）', fuelCost: 6.56, saved: 2.21, savedPct: 33.7 },
      efficiency: { ratedKwh: 6.5, actualKwh: 7.0, ratio: 0.929 },
      environment: { avgTempC: 18.5, acEstimateKwh: 0.3, avgSpeedKmh: 32.5, maxSpeedKmh: 78 },
    }),
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
      byType: {
        ac: { kwh: 820, cost: 410, count: 20 },
        super: { kwh: 95, cost: 175.8, count: 3 },
        dc: { kwh: 12, cost: 20.4, count: 1 },
      },
      freeKwh: 8.5,
      monthly: [
        { month: '2026-08', kwh: 70, cost: 42 },
        { month: '2026-09', kwh: 88, cost: 51.2 },
        { month: '2026-10', kwh: 65.1, cost: 75.2 },
      ],
    }),
  ),
  http.get('/api/battery-health', () =>
    HttpResponse.json(mockBatteryHealth),
  ),
  http.get('/api/pricing', () => HttpResponse.json(mockPricing)),
  http.put('/api/pricing/default', async ({ request }) => {
    const body = (await request.json()) as { rate: number }
    return HttpResponse.json({ ok: true, rate: body.rate })
  }),
  http.get('/api/pricing/history', () => HttpResponse.json([])),
  http.put('/api/pricing/locations/:id', async ({ request, params }) =>
    HttpResponse.json({ ok: true, id: Number(params.id), ...((await request.json().catch(() => ({}))) as object) }),
  ),
  http.get('/api/channels', () => HttpResponse.json(mockChannelStatus)),
  http.get('/api/push/env', () => HttpResponse.json({ https: true, vapidPublicKey: 'BTest' })),
  http.get('/api/dashboard/timeline', () => HttpResponse.json(mockTimeline)),
  http.get('/api/dashboard/heatmap', () => HttpResponse.json(mockHeatmap)),
  http.get('/api/settings', () => HttpResponse.json(mockSettings)),
  http.put('/api/settings', async ({ request }) => HttpResponse.json({ ok: true, settings: await request.json() })),
  http.post('/api/ledger/summary', () => HttpResponse.json(mockLedgerSummary)),
  http.get('/api/system/health-lite', () => HttpResponse.json({ dbOk: true, bannerLevel: null, outageMs: 0 })),
  http.put('/api/channels/feishu', () => HttpResponse.json({ ok: true, connected: true })),
  http.post('/api/channels/feishu/test', () => HttpResponse.json({ ok: true, message: '测试卡片已发送' })),
  // m4b 三新渠道(密钥型字段留空=不修改)
  http.put('/api/channels/wecom', () => HttpResponse.json({ ok: true })),
  http.post('/api/channels/wecom/test', () => HttpResponse.json({ ok: true, message: '企业微信测试消息已发送' })),
  http.put('/api/channels/ntfy', () => HttpResponse.json({ ok: true })),
  http.post('/api/channels/ntfy/test', () => HttpResponse.json({ ok: true, message: 'ntfy 测试消息已发送' })),
  http.put('/api/channels/bark', () => HttpResponse.json({ ok: true })),
  http.post('/api/channels/bark/test', () => HttpResponse.json({ ok: true, message: 'Bark 测试消息已发送' })),
  http.get('/api/push-rules', () => HttpResponse.json(mockPushMatrix)),
  http.put('/api/push-rules', async ({ request }) => HttpResponse.json(await request.json())),
  http.get('/api/ai/config', () => HttpResponse.json(mockAiConfig)),
  http.put('/api/ai/config', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    return HttpResponse.json({ ok: true, ...body })
  }),
  http.post('/api/ai/test', () =>
    HttpResponse.json({ ok: true, preview: '昨晚到家充电 41 度，谷电花费 12.3 元，较油车省下 28 元。' })),
  http.get('/api/system/status', () => HttpResponse.json(mockSystemStatus)),
  http.get('/api/system/events', () => HttpResponse.json(mockEvents)),
  // m4a 轨道B：默认无可达候选（各用例按需覆盖为发现成功/失败）
  http.post('/api/setup/probe-discovery', () => HttpResponse.json({ candidates: [] })),
]

export const server = setupServer(...defaultHandlers)
