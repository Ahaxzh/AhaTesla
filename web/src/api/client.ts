/** 统一 API 客户端：credentials include、401 → refresh → 重试（B3）、错误 toast */
import { getUiLang } from '@/utils/format'
import type { BatteryHealth } from '@/types'
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
  AiConfig,
  RecalcJob,
  ReportDetail,
  RouteSummary,
  TripsOverview,
  ReportListItem,
  SetupStatus,
  SystemEvent,
  SystemStatus,
  TestConnectionResult,
  TimelineData,
  Trip,
  TripDetail,
  User,
  CarInfo,
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
    let message = getUiLang() === 'en' ? `Request failed (${res.status})` : `请求失败 (${res.status})`
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
/** m4e:可选 carId 拼 query(缺省=主车,后端语义);undefined 时不加参数 */
const withCar = (path: string, carId?: number) =>
  carId == null ? path : `${path}${path.includes('?') ? '&' : '?'}carId=${carId}`
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
const put = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) })

// ---- Auth ----
/** urlBase64 → Uint8Array（VAPID 公钥格式转换） */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

/** 一键开启 Web Push：确保 VAPID → 浏览器订阅 → 上报（向导 Step4 与推送页共用） */
export async function subscribeWebPush(): Promise<{ ok: boolean }> {
  const vapid = await api.webpushInitVapid()
  const reg = await navigator.serviceWorker.ready
  const key = urlBase64ToUint8Array(vapid.publicKey)
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key.buffer as ArrayBuffer,
  })
  const json = sub.toJSON()
  return api.webpushSubscribe({
    endpoint: String(json.endpoint),
    keys: { p256dh: String(json.keys?.p256dh ?? ''), auth: String(json.keys?.auth ?? '') },
  })
}

export const api = {
  login: (username: string, password: string) =>
    post<{ token: string; user: User }>('/api/auth/login', { username, password }),
  logout: () => post<{ ok: boolean }>('/api/auth/logout'),
  me: () => get<User>('/api/auth/me'),
  /** 账户更新：改密和/或改用户名（当前密码恒必需） */
  changeAccount: (payload: { oldPassword: string; newPassword?: string; newUsername?: string }) =>
    post<{ ok: boolean; user: { username: string } }>('/api/auth/change-password', payload),
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
  // m4a 轨道B：自动发现可达库 + 一键建只读账号（凭据仅本次使用，服务端不落盘）
  setupProbeDiscovery: () =>
    post<{ candidates: { host: string; port: number; source: string }[] }>('/api/setup/probe-discovery', {}),
  setupAutoRo: (payload: { host: string; port: number; database: string; user: string; password: string }) =>
    post<{ ok: true; dsn: string; password: string } | { ok: false; stage: string; error: string; fallbackSql: string }>('/api/setup/auto-ro', payload),

  // ---- m4e 车辆 ----
  cars: () => get<CarInfo[]>('/api/cars'),

  dashboard: (carId?: number) => get<DashboardData>(withCar('/api/dashboard', carId)),

  trips: (params: { limit?: number; offset?: number; from?: string; to?: string; carId?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    if (params.from) q.set('from', params.from)
    if (params.to) q.set('to', params.to)
    if (params.carId != null) q.set('carId', String(params.carId))
    return get<Paged<Trip>>(`/api/trips?${q.toString()}`)
  },
  trip: (id: number | string) => get<TripDetail>(`/api/trips/${id}`),
  /** v0.3 行程页顶部汇总：KPI + 状态占比 */
  tripsOverview: (params: { from?: string; to?: string; carId?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.from) q.set('from', params.from)
    if (params.to) q.set('to', params.to)
    if (params.carId != null) q.set('carId', String(params.carId))
    return get<TripsOverview>(`/api/trips/overview?${q.toString()}`)
  },
  /** v0.3 行程页轨迹汇总（区间内所有行驶轨迹叠加，抽稀 ≤1200 点） */
  tripsRouteSummary: (params: { from?: string; to?: string; carId?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.from) q.set('from', params.from)
    if (params.to) q.set('to', params.to)
    if (params.carId != null) q.set('carId', String(params.carId))
    return get<RouteSummary>(`/api/trips/route-summary?${q.toString()}`)
  },

  charging: (params: { limit?: number; offset?: number; month?: string; from?: string; to?: string; carId?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    if (params.month) q.set('month', params.month)
    if (params.from) q.set('from', params.from)
    if (params.to) q.set('to', params.to)
    if (params.carId != null) q.set('carId', String(params.carId))
    return get<Paged<Charge>>(`/api/charging?${q.toString()}`)
  },
  chargingDetail: (id: number | string) => get<ChargeDetail>(`/api/charging/${id}`),
  chargingStats: (params: { from?: string; to?: string; month?: string; carId?: number } = {}) => {
    const q = new URLSearchParams({ period: 'month' })
    if (params.month) q.set('month', params.month)
    if (params.from) q.set('from', params.from)
    if (params.to) q.set('to', params.to)
    return get<ChargingStats>(withCar(`/api/charging/stats?${q.toString()}`, params.carId))
  },
  putChargeCost: (id: number, amount: number) =>
    put<{ ok: boolean }>(`/api/charging/${id}/cost`, { amount, source: 'manual' }),

  // ---- v2.1：时间轴 / 热力图 / 设置 / 账本 / 推送 / 报告 ----
  timeline: (carId?: number) => get<TimelineData>(withCar('/api/dashboard/timeline', carId)),
  heatmap: (days = 90, carId?: number) => get<HeatmapData>(withCar(`/api/dashboard/heatmap?days=${days}`, carId)),
  batteryHealth: (carId?: number | null) => get<BatteryHealth>(`/api/battery-health${carId ? `?carId=${carId}` : ''}`),
  settings: () => get<InstanceSettings>('/api/settings'),
  saveSettings: (payload: Omit<Partial<InstanceSettings>, 'geocoding'> & { geocoding?: { enabled: boolean; amapKey?: string } }) => put<{ ok: boolean; settings: InstanceSettings }>('/api/settings', payload),
  ledgerSummary: (month?: string, carId?: number) =>
    post<LedgerSummary>(withCar(`/api/ledger/summary${month ? `?month=${month}` : ''}`, carId), {}),
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
  // ---- m4b 三新渠道:企业微信 / ntfy / Bark(密钥型字段留空=不修改) ----
  saveWecom: (payload: { enabled: boolean; webhookKey?: string }) =>
    put<{ ok: boolean }>('/api/channels/wecom', payload),
  testWecom: () => post<{ ok: boolean; message: string }>('/api/channels/wecom/test'),
  saveNtfy: (payload: { enabled: boolean; serverUrl?: string; topic?: string }) =>
    put<{ ok: boolean }>('/api/channels/ntfy', payload),
  testNtfy: () => post<{ ok: boolean; message: string }>('/api/channels/ntfy/test'),
  saveBark: (payload: { enabled: boolean; serverUrl?: string; deviceKey?: string }) =>
    put<{ ok: boolean }>('/api/channels/bark', payload),
  testBark: () => post<{ ok: boolean; message: string }>('/api/channels/bark/test'),
  pushRulesV2: () => get<PushRulesV2>('/api/push-rules'),
  setPushRulesV2: (payload: PushRulesV2) => put<PushRulesV2>('/api/push-rules', payload),
  // ---- m4c：BYO 模型（OpenAI 兼容，密钥服务端加密，回显只给别名） ----
  aiConfig: () => get<AiConfig>('/api/ai/config'),
  saveAiConfig: (payload: { enabled: boolean; baseUrl: string; model: string; apiKey?: string }) =>
    put<{ ok: boolean }>('/api/ai/config', payload),
  aiTest: () => post<{ ok: boolean; preview?: string; error?: string }>('/api/ai/test'),
  reports: (carId?: number) => get<{ items: ReportListItem[] }>(withCar('/api/reports', carId)),
  reportDetail: (id: number | string) => get<ReportDetail>(`/api/reports/${id}`),
  generateReport: (type: 'daily' | 'weekly' | 'monthly') =>
    post<{
      ok: boolean
      id?: number
      deduplicated?: boolean
      type?: 'daily'
      periodLabel?: string
      results?: Record<string, { sent: boolean; reason?: string }>
    }>('/api/reports/generate', { type }),
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
