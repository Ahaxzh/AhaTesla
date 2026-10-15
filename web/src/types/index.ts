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
  /** 路线点集 [lng, lat][] */
  route?: [number, number][]
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
