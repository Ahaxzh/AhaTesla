/** 统一 API 客户端：credentials include、401 → refresh → 重试（B3）、错误 toast */
import type {
  CarDiscoveryResult,
  ChargeDetail,
  ChannelsData,
  Charge,
  ChargingStats,
  ChannelStatus,
  DashboardData,
  HealthLite,
  HeatmapData,
  InstanceSettings,
  LedgerSummary,
  Paged,
  PricingData,
  PricingHistoryEntry,
  PushRules,
  PushRulesV2,
  RecalcJob,
  ReportDetail,
  ReportListItem,
  SetupStatus,
  SystemEvent,
  SystemStatus,
  TestConnectionResult,
  TimelineData,
  Trip,
  TripDetail,
  User,
} from '@/types'

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** 全局 401 / 错误回调（由 App 层注入，避免 client 依赖 React） */
type ErrorHandler = (err: ApiError) => void
let onUnauthorized: ErrorHandler | null = null
let onError: ErrorHandler | null = null
export function setApiHandlers(h: { unauthorized?: ErrorHandler; error?: ErrorHandler }) {
  onUnauthorized = h.unauthorized ?? null
  onError = h.error ?? null
}

async function request<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    ...init,
  })
  if (!res.ok) {
    // B3：Access 过期 → 静默用 Refresh 续期并重试一次（refresh 自身失败不重试）
    if (res.status === 401 && !retried && !path.startsWith('/api/auth/') && !path.startsWith('/api/setup/')) {
      try {
        const refreshRes = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
        })
        if (refreshRes.ok) return request<T>(path, init, true)
      } catch {
        /* refresh 失败 → 正常走 401 处理 */
      }
    }
    let code = 'UNKNOWN'
    let message = `请求失败 (${res.status})`
    try {
      const body = await res.json()
      if (body?.error?.code) code = body.error.code
      if (body?.error?.message) message = body.error.message
    } catch {
      /* 非 JSON 错误体 */
    }
    const err = new ApiError(res.status, code, message)
    if (res.status === 401) {
      onUnauthorized?.(err)
    } else {
      onError?.(err)
    }
    throw err
  }
  return (await res.json()) as T
}

const get = <T>(path: string) => request<T>(path)
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
const put = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) })

// ---- Auth ----
export const api = {
  login: (username: string, password: string) =>
    post<{ token: string; user: User }>('/api/auth/login', { username, password }),
  logout: () => post<{ ok: boolean }>('/api/auth/logout'),
  me: () => get<User>('/api/auth/me'),
  changePassword: (oldPassword: string, newPassword: string) =>
    post<{ ok: boolean }>('/api/auth/change-password', { oldPassword, newPassword }),

  // ---- Setup wizard（契约 v2 §1）----
  setupStatus: () => get<SetupStatus>('/api/setup/status'),
  setupRegisterAdmin: (username: string, password: string) =>
    post<{ ok: boolean; user: { username: string; role: string } }>('/api/setup/admin', { username, password }),
  setupTestConnection: (payload: { host: string; port: number; database: string; user: string; password: string }) =>
    post<TestConnectionResult>('/api/setup/test-connection', payload),
  setupSaveDatasource: (payload: { mode: 'connect' | 'fullstack'; host?: string; port?: number; database?: string; user?: string; password?: string; carId?: number }) =>
    post<{ ok: boolean }>('/api/setup/datasource', payload),
  setupCarDiscovery: () => get<CarDiscoveryResult>('/api/setup/car-discovery'),
  setupSelectCar: (carId: number) => post<{ ok: boolean; carId: number }>('/api/setup/select-car', { carId }),

  dashboard: () => get<DashboardData>('/api/dashboard'),

  trips: (params: { limit?: number; offset?: number; from?: string; to?: string } = {}) => {
    const q = new URLSearchParams()
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    if (params.from) q.set('from', params.from)
    if (params.to) q.set('to', params.to)
    return get<Paged<Trip>>(`/api/trips?${q.toString()}`)
  },
  trip: (id: number | string) => get<TripDetail>(`/api/trips/${id}`),

  charging: (params: { limit?: number; offset?: number; month?: string } = {}) => {
    const q = new URLSearchParams()
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    if (params.month) q.set('month', params.month)
    return get<Paged<Charge>>(`/api/charging?${q.toString()}`)
  },
  chargingDetail: (id: number | string) => get<ChargeDetail>(`/api/charging/${id}`),
  chargingStats: (period: 'month' | 'year' | 'all' = 'month', month?: string) =>
    get<ChargingStats>(`/api/charging/stats?period=${period}${month ? `&month=${month}` : ''}`),
  putChargeCost: (id: number, amount: number) =>
    put<{ ok: boolean }>(`/api/charging/${id}/cost`, { amount, source: 'manual' }),

  // ---- v2.1：时间轴 / 热力图 / 设置 / 账本 / 推送 / 报告 ----
  timeline: () => get<TimelineData>('/api/dashboard/timeline'),
  heatmap: (days = 90) => get<HeatmapData>(`/api/dashboard/heatmap?days=${days}`),
  settings: () => get<InstanceSettings>('/api/settings'),
  saveSettings: (payload: Partial<InstanceSettings>) => put<{ ok: boolean; settings: InstanceSettings }>('/api/settings', payload),
  ledgerSummary: (month?: string) =>
    post<LedgerSummary>(`/api/ledger/summary${month ? `?month=${month}` : ''}`, {}),
  startRecalculate: (payload: { all?: boolean; from?: string; to?: string }) =>
    post<{ jobId: string }>('/api/ledger/recalculate', payload),
  recalculateStatus: (jobId: string) => get<RecalcJob>(`/api/ledger/recalculate/${jobId}`),

  pricing: () => get<PricingData>('/api/pricing'),
  setDefaultRate: (rate: number) => put<{ ok: boolean }>('/api/pricing/default', { rate }),
  setLocationPricing: (id: number, payload: { priceMode: 'fixed'; pricePerUnit?: number } | { priceMode: 'tou'; tou: { offPeakStart: string; offPeakEnd: string; offPeakRate: number; peakRate: number } }) =>
    put<{ ok: boolean }>(`/api/pricing/locations/${id}`, payload),
  pricingHistory: () => get<PricingHistoryEntry[]>('/api/pricing/history'),

  channels: () => get<ChannelsData>('/api/channels'),
  channelStatus: () => get<ChannelStatus>('/api/channels'),
  pushEnv: () => get<{ https: boolean; vapidPublicKey: string | null }>('/api/push/env'),
  webpushInitVapid: () => post<{ ok: boolean; publicKey: string; created: boolean }>('/api/push/webpush/init-vapid'),
  webpushSubscribe: (payload: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    post<{ ok: boolean }>('/api/push/webpush/subscribe', payload),
  webpushUnsubscribe: (endpoint: string) =>
    post<{ ok: boolean }>('/api/push/webpush/unsubscribe', { endpoint }),
  webpushTest: () => post<{ ok: boolean }>('/api/push/webpush/test'),
  saveTelegram: (payload: { enabled: boolean; botToken?: string; chatId?: string }) =>
    put<{ ok: boolean; connected: boolean }>('/api/channels/telegram', payload),
  testTelegram: () => post<{ ok: boolean }>('/api/channels/telegram/test'),
  pushRulesV2: () => get<PushRulesV2>('/api/push-rules'),
  setPushRulesV2: (payload: PushRulesV2) => put<PushRulesV2>('/api/push-rules', payload),
  reports: () => get<{ items: ReportListItem[] }>('/api/reports'),
  reportDetail: (id: number | string) => get<ReportDetail>(`/api/reports/${id}`),
  generateReport: (type: 'weekly' | 'monthly') => post<{ ok: boolean; id: number }>('/api/reports/generate', { type }),
  healthLite: () => get<HealthLite>('/api/system/health-lite'),
  saveFeishu: (payload: { enabled: boolean; appId: string; appSecret?: string }) =>
    put<{ ok: boolean; connected: boolean }>('/api/channels/feishu', payload),
  testFeishu: () => post<{ ok: boolean; message: string }>('/api/channels/feishu/test'),
  pushRules: () => get<PushRules>('/api/push-rules'),
  setPushRules: (rules: PushRules) => put<PushRules>('/api/push-rules', rules),

  systemStatus: () => get<SystemStatus>('/api/system/status'),
  systemEvents: (limit = 100) => get<SystemEvent[]>(`/api/system/events?limit=${limit}`).then((r: unknown) => {
    // API 契约返回 { items: [...] }，容错直接数组
    return Array.isArray(r) ? r : ((r as { items?: SystemEvent[] }).items ?? []);
  }),
}
