import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  BatteryCharging,
  Car,
  Coins,
  Flame,
  Gauge,
  MapPin,
  Route,
  Sparkles,
  TrendingDown,
} from 'lucide-react'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { SkeletonCards, SkeletonList } from '@/components/Skeletons'
import { StatCard } from '@/components/StatCard'
import { EmptyState } from '@/components/EmptyState'
import { Timeline24h } from '@/components/Timeline24h'
import { BatteryHealthCard } from '@/components/BatteryHealthCard'
import { HeatmapCalendar } from '@/components/HeatmapCalendar'
import { useI18n } from '@/i18n'
import { useCar } from '@/contexts/CarContext'
import { fmtCny, fmtDateTime, fmtKm, fmtKwh, timeAgo } from '@/utils/format'
import type { Charge, Trip } from '@/types'

/** states 原值 → 产品语义（PRD §6.3 P2）：offline≠睡眠；online=哨兵/在线驻车。
 *  labelKey/labelZh 交给调用点 t() 双语；dot=胶囊内前置状态点的颜色（随各状态文字色），
 *  live=true 的状态（充电/行驶/哨兵）带轻 ping 动效——只这点动，睡眠/离线保持安静。 */
function statePill(state: string): { labelKey: string; labelZh: string; cls: string; dot: string; live: boolean } {
  switch (state) {
    case 'charging':
      return { labelKey: 'dash.state.charging', labelZh: '充电中', cls: 'bg-emerald-400/10 text-emerald-400', dot: 'bg-emerald-400', live: true }
    case 'driving':
      return { labelKey: 'dash.state.driving', labelZh: '行驶中', cls: 'bg-sky-400/10 text-sky-400', dot: 'bg-sky-400', live: true }
    case 'asleep':
      return { labelKey: 'dash.state.asleep', labelZh: '睡眠中', cls: 'bg-violet-400/10 text-violet-400', dot: 'bg-violet-400', live: false }
    case 'online':
      return { labelKey: 'dash.state.online', labelZh: '哨兵/在线', cls: 'bg-amber-400/10 text-amber-400', dot: 'bg-amber-400', live: true }
    case 'offline':
      return { labelKey: 'dash.state.offline', labelZh: '离线', cls: 'bg-white/[0.04] text-slate-500', dot: 'bg-slate-500', live: false }
    default:
      return { labelKey: 'dash.state.pending', labelZh: '待数据', cls: 'bg-white/[0.06] text-slate-400', dot: 'bg-slate-400', live: false }
  }
}

export default function DashboardPage() {
  const { t } = useI18n()
  const { currentCarId } = useCar()
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['dashboard', currentCarId], queryFn: () => api.dashboard(currentCarId), retry: false })
  const { data: timeline } = useQuery({ queryKey: ['timeline', currentCarId], queryFn: () => api.timeline(currentCarId), retry: false })
  const [heatmapDays, setHeatmapDays] = useState(365) // 默认近一年（用车日历作为仪表盘主视觉，年视图信息密度更高）
  const { data: heatmap } = useQuery({ queryKey: ['heatmap', heatmapDays, currentCarId], queryFn: () => api.heatmap(heatmapDays, currentCarId), retry: false })
  // P2 模块3 小字：总电费 = 行驶分摊 + 驻车/哨兵（POST /api/ledger/summary）
  const { data: ledger, refetch: refetchLedger } = useQuery({
    queryKey: ['ledger-summary', currentCarId],
    queryFn: () => api.ledgerSummary(undefined, currentCarId),
    retry: false,
  })

  const month = data?.monthStats
  // 省钱数：油车对比 − 账本口径电费（FIFO 批次分摊，与电费卡显示一致；v2.2 修复与简单计价的口径混用）
  const saved = month && data ? data.fuelComparison.fuelCostCny - (ledger?.totalCost ?? month.costCny) : 0
  const car = data?.car
  const pill = statePill(car?.state ?? '')
  // 电量横条配色（原 BatteryRing 内部同口径：≥50 绿 / ≥25 琥珀 / 其余红）
  const batteryColor = (() => {
    const b = car?.currentBattery
    if (b == null) return { cls: 'bg-slate-600' }
    if (b >= 50) return { cls: 'bg-emerald-400' }
    if (b >= 25) return { cls: 'bg-amber-400' }
    return { cls: 'bg-tesla' }
  })()

  return (
    <div>
      <PageHeader icon={Gauge} title={t('dash.title', '总览')} subtitle={car?.name ?? 'Tesla'} />

      {isError ? (
        <div className="glass-card fade-up flex flex-col items-center gap-3 p-10 text-center" data-testid="dashboard-error">
          <div className="text-4xl">📡</div>
          <div className="text-sm text-slate-300">{t('dash.loadError', '数据加载失败，请检查 TeslaMate 数据源连接')}</div>
          <button
            className="rounded-lg bg-white/10 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/20"
            onClick={() => { void refetch(); void refetchLedger(); }}
          >
            {t('common.retry', '重试')}
          </button>
        </div>
      ) : isLoading || !data ? (
        <div className="space-y-4">
          <div className="skeleton h-56 rounded-2xl" />
          <SkeletonCards />
          <SkeletonList rows={3} />
        </div>
      ) : (
        <div className="space-y-4">
          {/* P2 模块1：车辆状态卡（紧凑单列：电量细横条；右下角位置文字 = 围栏名/附近/坐标兜底） */}
          <section className="glass-card fade-up p-4" data-testid="car-card">
            <div className="flex flex-col justify-center gap-3">
              {/* 首行：左车名（完整不截断），右状态胶囊（v0.3 用户裁决；活跃态轻 ping） */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2 text-sm text-slate-300">
                  <Car className="h-4 w-4 shrink-0 text-tesla" />
                  <span className="truncate">{car!.name}</span>
                </div>
                <span className={`flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${pill.cls}`} data-testid="car-state-pill">
                  <span className="relative flex h-1.5 w-1.5">
                    {pill.live && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${pill.dot} opacity-50`} />}
                    <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${pill.dot}`} />
                  </span>
                  {t(pill.labelKey, pill.labelZh)}
                  {car!.state === 'charging' && car!.charging?.powerKw ? ` · ${car!.charging.powerKw} kW` : ''}
                </span>
              </div>
              {/* 电量：百分比 + 细横条（Tesla App 式，替代原 BatteryRing 大圆环） */}
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="num text-2xl font-semibold text-white">
                    {car!.currentBattery == null ? '--' : `${car!.currentBattery}%`}
                  </span>
                  <span className="text-[11px] text-slate-400">{t('dash.currentRange', '当前续航')} <span className="num text-slate-300">{fmtKm(car!.rangeKm, 0)} km</span></span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
                  <div
                    className={`h-full rounded-full transition-all ${batteryColor.cls}`}
                    style={{ width: `${car!.currentBattery ?? 0}%` }}
                    data-testid="battery-bar"
                  />
                </div>
              </div>
              {/* 胎压行 + 右侧位置（同属"车辆实况"）：胎压四轮横排，<2.6 bar 变红（对齐推送告警阈值）；
                  位置缩写 FL/FR/RL/RR；位置仅地名（无时间戳）ml-auto 贴右，窄屏自动截断 */}
              {(car?.tirePressure || car?.position) ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
                  {car?.tirePressure ? (
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5" data-testid="tire-pressure">
                      {([['FL', car.tirePressure.fl], ['FR', car.tirePressure.fr], ['RL', car.tirePressure.rl], ['RR', car.tirePressure.rr]] as const).map(([label, v]) => (
                        <span key={label} className={v != null && v < 2.6 ? 'text-tesla' : 'text-slate-300'}>
                          {label} <span className="num">{v != null ? v.toFixed(1) : '--'}</span>
                        </span>
                      ))}
                      <span className="text-slate-500">bar</span>
                    </span>
                  ) : null}
                  {car?.position ? (
                    <span className="flex ml-auto min-w-0 max-w-[52%] items-center gap-1 text-slate-400" data-testid="car-position" title={car.position.label ?? undefined}>
                      <MapPin className="h-3 w-3 shrink-0 text-tesla" />
                      <span className="truncate">
                        {car.position.label ?? `${car.position.lat.toFixed(4)}, ${car.position.lng.toFixed(4)}`}
                      </span>
                    </span>
                  ) : null}
                </div>
              ) : null}
              {/* 里程行：左总里程，右数据同步时间（两者都是元数据，凑一对） */}
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="shrink-0 text-slate-400">{t('dash.odometer', '总里程')} <span className="num text-slate-300">{fmtKm(car!.odometerKm, 0)} km</span></span>
                {car && (
                  <span className="truncate text-slate-500" data-testid="car-synced">
                    {t('dash.syncedPrefix', '数据同步于')} {timeAgo(data.recentTrips[0]?.endAt ?? null)}
                  </span>
                )}
              </div>
            </div>
          </section>

          {/* P2 模块3：本月账本汇总（构成小字：含行驶 ¥X · 驻车/哨兵 ¥Y） */}
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="month-stats">
            <StatCard icon={Route} label={t('dash.month.km', '本月里程')} value={`${fmtKm(month!.distanceKm)} km`} hint={`${month!.driveCount} ${t('dash.tripsUnit', '趟')} · ${month!.driveHours.toFixed(1)} ${t('dash.hoursUnit', '小时')}`} />
            <StatCard icon={BatteryCharging} label={t('dash.month.energy', '本月能耗')} value={fmtKwh(month!.energyKWh)} />
            <StatCard
              icon={Coins}
              label={t('dash.month.cost', '本月电费')}
              value={fmtCny(ledger?.totalCost ?? month!.costCny)}
              accent
              data-testid="stat-cost"
              hint={
                ledger
                  ? `${t('dash.costHintDriving', '含行驶')} ${fmtCny(ledger.breakdown.drivingCost ?? 0)} · ${t('dash.costHintParking', '驻车/哨兵')} ${fmtCny(ledger.breakdown.parkingCost ?? 0)}`
                  : undefined
              }
            />
            <StatCard
              icon={TrendingDown}
              label={t('dash.month.vsFuel', '相比油车')}
              value={saved >= 0 ? `${t('dash.saved', '省')} ${fmtCny(Math.abs(saved))}` : `${t('dash.more', '多')} ${fmtCny(Math.abs(saved))}`}
              hint={`${t('dash.fuelHintPrefix', '油车约')} ${fmtCny(data.fuelComparison.fuelCostCny)}`}
            />
          </section>

          {/* P2 模块2：24h 状态时间轴 */}
          {timeline && <Timeline24h data={timeline} />}
          {/* v0.3 调换：首页紧凑行（点击展开大卡），完整大卡在充电页 */}
          <BatteryHealthCard variant="slim" />

          {/* P2 模块4：用车日历热力图 */}
          {heatmap && <HeatmapCalendar data={heatmap} onDaysChange={setHeatmapDays} />}

          {/* P2 模块5：最近活动流（行程/充电混合） */}
          {/* min-w-0：grid item 默认 min-width:auto，长地址 nowrap 文本会撑开轨道导致整页横向滚动 */}
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <section className="glass-card min-w-0 p-4" data-testid="recent-trips">
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="flex items-center gap-2 text-sm font-medium text-slate-200">
                  <Route className="h-4 w-4 text-tesla" /> {t('dash.recentTrips', '最近行程')}
                </h2>
                <Link to="/trips" className="flex items-center gap-1 text-xs text-slate-400 transition hover:text-tesla">
                  {t('dash.viewAll', '全部')} <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
              {data.recentTrips.length === 0 ? (
                <EmptyState icon={Sparkles} title={t('dash.emptyReady.title', '数据通道已就绪')} description={t('dash.emptyReady.desc', '车辆首次出发或充电后将自动汇入账单')} />
              ) : (
                <ul className="divide-y divide-white/[0.05]">
                  {data.recentTrips.map((t) => (
                    <RecentTripRow key={t.id} trip={t} />
                  ))}
                </ul>
              )}
            </section>

            <section className="glass-card min-w-0 p-4" data-testid="recent-charges">
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="flex items-center gap-2 text-sm font-medium text-slate-200">
                  <Flame className="h-4 w-4 text-tesla" /> {t('dash.recentCharges', '最近充电')}
                </h2>
                <Link to="/charging" className="flex items-center gap-1 text-xs text-slate-400 transition hover:text-tesla">
                  {t('dash.viewAll', '全部')} <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
              {data.recentCharges.length === 0 ? (
                <EmptyState icon={BatteryCharging} title={t('dash.noCharges', '暂无充电记录')} />
              ) : (
                <ul className="divide-y divide-white/[0.05]">
                  {data.recentCharges.map((c) => (
                    <RecentChargeRow key={c.id} charge={c} />
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  )
}

function RecentTripRow({ trip }: { trip: Trip }) {
  return (
    <li>
      <Link to={`/trips/${trip.id}`} className="flex items-center gap-3 px-1 py-3 transition hover:bg-white/[0.03]">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-slate-200">
            {trip.startAddress} → {trip.endAddress}
          </div>
          <div className="num mt-0.5 text-[11px] text-slate-500">
            {fmtDateTime(trip.startAt)} · {fmtKm(trip.distanceKm)} km · {fmtKwh(trip.energyKWh)}
          </div>
        </div>
        <div className="num text-sm font-medium text-tesla">{fmtCny(trip.costCny)}</div>
      </Link>
    </li>
  )
}

function RecentChargeRow({ charge }: { charge: Charge }) {
  const soc = charge.startBattery != null && charge.endBattery != null
    ? ` · ${charge.startBattery}%→${charge.endBattery}%`
    : '';
  return (
    <li className="flex items-center gap-3 px-1 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-slate-200">{charge.locationName}</div>
        <div className="num mt-0.5 text-[11px] text-slate-500">
          {fmtDateTime(charge.startAt)} · {fmtKwh(charge.energyAddedKWh)}{soc}
        </div>
      </div>
      <div className="num text-sm font-medium text-slate-300">{fmtCny(charge.costCny)}</div>
    </li>
  )
}
