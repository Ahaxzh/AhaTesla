// ---- API 契约类型（docs/API_CONTRACT.md v1）----

export interface User {
  username: string
  initialized: boolean
}

// ---- /setup 初始化向导（契约 v2 §1）----

export type SetupState = 'uninitialized' | 'setup-locked' | 'ready'

export interface SetupStatus {
  state: SetupState
  https: boolean
  carFound: boolean
}

export type SetupCheckName = 'reachability' | 'auth' | 'readonly' | 'cars'

export interface SetupCheckStep {
  name: SetupCheckName
  ok: boolean
  detail: string
}

export interface DiscoveredCar {
  id: number
  name: string | null
  model: string | null
  lastDriveAt?: string | null
}

export interface TestConnectionResult {
  ok: boolean
  steps: SetupCheckStep[]
  cars: DiscoveredCar[]
}

export interface CarDiscoveryResult {
  found: boolean
  cars: DiscoveredCar[]
  car: DiscoveredCar | null
  suggestedCarId: number | null
  error?: string
}

export interface Trip {
  id: number
  startAt: string
  endAt: string
  distanceKm: number
  durationMin: number
  energyKWh: number
  costCny: number
  startAddress: string
  endAddress: string
  kwhPer100km: number
  routeKey: string
}

export interface TripDetail extends Trip {
  /** 路线点集 {t, lat, lng, speed}[]（LTTB ≤300 点，speed km/h 供速度着色） */
  route?: { t: string; lat: number; lng: number; speed?: number | null }[]
  positionCount?: number
  /** FIFO 扣减明细（P3 模块4） */
  fifo?: {
    batches: { source: string; kwh: number; price: number; amount: number }[]
    totalCost: number | null
    blendedPrice: number | null
    exhaustedNote: string | null
  }
  /** 油车对比（P3 模块4） */
  fuelComparison?: {
    baseline: string
    fuelCost: number
    saved: number | null
    savedPct: number | null
  }
  /** 能效达成率（P3 模块1） */
  efficiency?: { ratedKwh: number | null; actualKwh: number | null; ratio: number | null }
  /** 环境剖析（P3 模块3） */
  environment?: {
    avgTempC: number | null
    acEstimateKwh: number | null
    avgSpeedKmh: number | null
    maxSpeedKmh: number | null
  }
}

export interface Charge {
  id: number
  startAt: string
  endAt: string
  locationName: string
  energyAddedKWh: number
  costCny: number
  pricePerUnit: number
  startBattery: number
  endBattery: number
  durationMin: number
  powerMaxKw: number
  /** 费用来源三态（P4）：manual=已录入 / geofence=规则计价 / default=默认估算 */
  costSource?: 'manual' | 'geofence' | 'default' | 'unknown'
}

export interface ChargeDetail extends Charge {
  powerCurve: { soc: number; kw: number }[]
  maxKw: number | null
  maxKwSoc: number | null
  /** 桩端效率（数据未上报时为 null → 隐藏损耗模块） */
  efficiency: { meterKwh: number; batteryKwh: number; ratio: number; lossKwh: number } | null
  overrideCost: number | null
}

export interface DashboardData {
  car: {
    name: string
    currentBattery: number
    rangeKm: number
    state: string
    odometerKm: number
    /** 充电实时信息（state === 'charging' 时有值） */
    charging?: { batteryLevel: number | null; powerKw: number | null } | null
  }
  monthStats: {
    distanceKm: number
    energyKWh: number
    costCny: number
    driveCount: number
    driveHours: number
  }
  weekStats: { distanceKm: number; energyKWh: number; costCny: number }
  fuelComparison: { fuelCostCny: number; source: string; asOf: string }
  recentTrips: Trip[]
  recentCharges: Charge[]
}

export interface Paged<T> {
  total: number
  items: T[]
}

export interface ChargingStats {
  totalKWh: number
  totalCostCny: number
  avgPricePerKWh: number
  byLocation: {
    name: string
    count: number
    kwh: number
    cost: number
    pricePerUnit: number
  }[]
}

export interface PricingLocation {
  id: number
  name: string
  pricePerUnit: number
  sessionFee: number | null
  billingType: string
  /** v2.1：固定单价 | 分时电价（PUT /api/pricing/locations/:id） */
  priceMode?: 'fixed' | 'tou'
  tou?: { offPeakStart: string; offPeakEnd: string; offPeakRate: number; peakRate: number } | null
}

export interface PricingData {
  defaultRateCnyPerKwh: number
  locations: PricingLocation[]
}

export interface PricingHistoryEntry {
  changedAt: string
  from: number
  to: number
  source: string
}

export interface ChannelsData {
  feishu: {
    enabled: boolean
    connected: boolean
    appAlias: string | null
    lastEventAt: string | null
  }
  web: { enabled: boolean }
}

export interface PushRules {
  tripEnd: boolean
  chargingStart: boolean
  chargingDone: boolean
  weeklyReport: boolean
  weeklyReportDay: number
  monthlyReport: boolean
}

export interface SystemStatus {
  teslamate: {
    dbOk: boolean
    /** GA-31：Ping 延迟与只读校验（元数据探测） */
    latencyMs?: number | null
    readonlyVerified?: boolean | null
    /** MQTT 为可选增强（AC-5.1/§7.1）：仅在已配置时由后端返回；未配置时无此字段 */
    mqtt?: { ok: boolean }
    lastDriveAt: string | null
    driveCount: number
  }
  uptime: number
  version: string
}

export interface SystemEvent {
  id: number
  at: string
  level: 'info' | 'warn' | 'error'
  type: string
  message: string
}

// ---- v2.1 新增类型（M2 页面骨架 + 推送矩阵 + 报告 + 设置）----

export interface TimelineData {
  windowHours: number
  segments: { from: string; to: string; state: 'driving' | 'charging' | 'online' | 'asleep' | 'offline' }[]
  summary: { drivingH: number; chargingH: number; asleepH: number; onlineH: number; offlineH: number }
}

export interface HeatmapData {
  days: number
  maxKm: number
  daysData: { date: string; distanceKm: number }[]
}

export interface InstanceSettings {
  currency: { symbol: string; code: string }
  distanceUnit: 'km' | 'mi'
  timezone: string
  fuelBaseline: { literPer100km: number; fuelPriceCnyPerL: number }
}

export interface LedgerSummary {
  month: string
  distanceKm: number
  energyKwh: number
  totalCost: number
  costPerKm: number | null
  fuelComparison: { fuelCost: number; saving: number; baseline: string }
  parkingLoss: { kwh: number; cost: number }
  breakdown: { drivingCost: number; parkingCost: number }
}

export type PushChannelId = 'webpush' | 'telegram' | 'feishu'
export type PushEventId = 'tripEnd' | 'chargingStart' | 'chargingDone' | 'daily' | 'weekly' | 'monthly'

export interface PushMatrix {
  [event: string]: { [channel: string]: boolean }
}

export interface PushRulesV2 {
  matrix: PushMatrix
  weeklyReportDay: number
}

/** BYO 模型配置（GET /api/ai/config 回显；apiKey 永不回传明文，只给别名） */
export interface AiConfig {
  enabled: boolean
  baseUrl: string
  model: string
  hasKey: boolean
  keyAlias: string | null
}

export interface ChannelStatus {
  webpush: { enabled: boolean; configured: boolean; subscriberCount: number }
  telegram: { enabled: boolean; connected: boolean; botAlias: string | null; chatIdAlias: string | null }
  feishu: { enabled: boolean; connected: boolean; appAlias: string | null; lastEventAt: string | null }
}

export interface ReportListItem {
  id: number
  type: 'weekly' | 'monthly'
  periodLabel: string
  distanceKm: number | null
  totalCost: number | null
  saved: number | null
  createdAt: string
}

export interface ReportDetail extends ReportListItem {
  periodStart: string
  periodEnd: string
  carName: string | null
  kpi: {
    distanceKm: number
    energyKwh: number
    chargeKwh: number
    totalCost: number
    driveCount: number
    costPerKm: number | null
    fuelCost: number
    saved: number
    savedPct: number | null
  }
  topRoutes: { route: string; count: number }[]
  baselineNote: string
  closing: string
}

export interface PricingLocationV2 {
  id: number
  name: string
  pricePerUnit: number | null
  sessionFee: number | null
  billingType: string
  priceMode: 'fixed' | 'tou'
  tou?: { offPeakStart: string; offPeakEnd: string; offPeakRate: number; peakRate: number } | null
}

export interface RecalcJob {
  jobId: string
  status: 'running' | 'done' | 'error'
  progress: number
}

export interface HealthLite {
  dbOk: boolean
  bannerLevel: 'warn' | 'error' | null
  outageMs: number
}
