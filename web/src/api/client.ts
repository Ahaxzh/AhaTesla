/** 统一 API 客户端：credentials include、401 跳登录、错误 toast */
import type {
  CarDiscoveryResult,
  ChannelsData,
  Charge,
  ChargingStats,
  DashboardData,
  Paged,
  PricingData,
  PricingHistoryEntry,
  PushRules,
  SetupStatus,
  SystemEvent,
  SystemStatus,
  TestConnectionResult,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    ...init,
  })
  if (!res.ok) {
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

  charging: (params: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    return get<Paged<Charge>>(`/api/charging?${q.toString()}`)
  },
  chargingStats: (period: 'month' | 'all' = 'month') =>
    get<ChargingStats>(`/api/charging/stats?period=${period}`),

  pricing: () => get<PricingData>('/api/pricing'),
  setDefaultRate: (rate: number) => put<{ ok: boolean }>('/api/pricing/default', { rate }),
  pricingHistory: () => get<PricingHistoryEntry[]>('/api/pricing/history'),

  channels: () => get<ChannelsData>('/api/channels'),
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
