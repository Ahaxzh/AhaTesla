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
  /** compose 注入的部署形态（fullstack/connect）；裸机开发为 null → 向导出模式选择器 */
  deployMode: 'fullstack' | 'connect' | null
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
  route?: { t: string; lat: number; lng: number; speed?: number | null; elevation?: number | null }[]
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
  /** SoC 采样缺失时为 null（服务端 ?? null 直传，展示层需判空） */
  startBattery: number | null
  endBattery: number | null
  durationMin: number
  /** 峰值功率：charges 表无采样时为 null（渲染层判空，防 null.toFixed 白屏） */
  powerMaxKw: number | null
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
    /** 车辆 asleep/数据缺失时为 null（BatteryRing 与文案需判空，防"0%"红圈） */
    currentBattery: number | null
    rangeKm: number
    state: string
    odometerKm: number
    /** 最新定位（车辆位置地图卡）；无定位数据时为 null → 整卡不渲染 */
    position?: { lat: number; lng: number; at: string | null; label?: string | null } | null
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

export interface ChargingStats extends ChargingStatsV2 {
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
  /** m4e 多车:主车(缺省 carId 时后端用);别名覆盖 TeslaMate 车名 */
  primaryCarId?: number
  carAliases?: Record<string, string>
  /** 可选高德逆地理("未知"点位地名补全,默认关;key 密文存后端只回 hasKey) */
  geocoding?: { enabled: boolean; hasKey: boolean; keyAlias?: string | null }
}

/** GET /api/battery-health → 电池健康快照(样本不足时 insufficient,UI 隐藏) */
export interface BatteryHealth {
  sampleCount: number
  insufficient: boolean
  healthPct?: number | null
  baselineMaxRangeKm?: number | null
  currentMaxRangeKm?: number | null
  capacityKwh?: number | null
  cycles?: number | null
  rechargeEfficiency?: number | null
  totalAddedKwh?: number | null
  trend?: { month: string; maxRangeKm: number }[]
}

/** 充电 stats 扩展:成本三分 + 免费充电 + 月度趋势 */
export interface ChargingStatsV2 {
  byType: { ac: { kwh: number; cost: number; count: number }; super: { kwh: number; cost: number; count: number }; dc: { kwh: number; cost: number; count: number } }
  freeKwh: number
  monthly: { month: string; kwh: number; cost: number }[]
}

/** m4e:GET /api/cars → 车辆清单(name 来自 TeslaMate,alias/isPrimary 来自本地设置) */
export interface CarInfo {
  id: number
  name: string
  alias?: string | null
  isPrimary?: boolean
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

export type PushChannelId = 'webpush' | 'telegram' | 'feishu' | 'wecom' | 'ntfy' | 'bark'
export type PushEventId = 'tripEnd' | 'chargingStart' | 'chargingDone' | 'daily' | 'weekly' | 'monthly' | 'outage' | 'chargeInterrupt' | 'tirePressure'

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
  /** m4b 三新渠道(未部署后端时可能缺省,消费方需容忍 undefined) */
  wecom?: { enabled: boolean; configured: boolean; webhookKeyAlias: string | null }
  ntfy?: { enabled: boolean; configured: boolean; serverUrl: string; topic: string }
  bark?: { enabled: boolean; configured: boolean; serverUrl: string; deviceKeyAlias: string | null }
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
