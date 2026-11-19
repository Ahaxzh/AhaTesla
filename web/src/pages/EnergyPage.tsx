import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  BatteryCharging,
  Coins,
  Gauge,
  Route as RouteIcon,
  Timer,
  TrendingUp,
  Zap,
} from 'lucide-react'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { StatCard } from '@/components/StatCard'
import { EmptyState } from '@/components/EmptyState'
import { SkeletonCards } from '@/components/Skeletons'
import { EfficiencyCard } from '@/components/EfficiencyCard'
import { ConsumptionTrendChart } from '@/components/ConsumptionTrendChart'
import { MonthlyAccuracyChart } from '@/components/MonthlyAccuracyChart'
import { useI18n } from '@/i18n'
import { useCar } from '@/contexts/CarContext'
import { fmtCny, fmtDateTime, fmtDuration, fmtKm, fmtKwh } from '@/utils/format'

/**
 * 能耗页（v2.7）—— 车机能耗 App 的网页版，三段切换（数据全部来自现有端点，后端零新增）：
 * ① 最近行程：刚跑完这一趟的里程/能耗/平均 Wh/km/表显达成
 * ② 自上次充电：上次充电结束后的累计（车机 Trip 语义；无充电记录时回落全部行程）
 * ③ 累计：全部数据 + 每月「实际里程 vs 表显消耗」+ 能效画像
 * 「表显达成」口径 = display-accuracy 的 avgRatio（实际里程 ÷ 表显续航消耗，单趟用行程详情
 * efficiency.ratio，两者同式），>100% = 跑赢表显。
 */

const RANGES = [
  { key: 'trip', label: '最近行程', labelKey: 'energy.range.trip' },
  { key: 'since', label: '自上次充电', labelKey: 'energy.range.since' },
  { key: 'all', label: '近两年', labelKey: 'energy.range.all' },
] as const
type EnergyRange = (typeof RANGES)[number]['key']

/** 「近两年」窗口：与 efficiency-profile 的 730 天上限同口径。
 *  不做真"全部"：全量 overview（无 from）在本库实测 4~5s/次（暖查也重跑 SUM），
 *  且 2 年窗口外还压着约千趟早期/脏时间戳行程（首桶 1969）——收口两年，快且干净。 */
const ALL_FROM = () => new Date(Date.now() - 730 * 86400_000).toISOString()

const isRange = (v: string | null): v is EnergyRange => RANGES.some((r) => r.key === v)

export default function EnergyPage() {
  const { t } = useI18n()
  const { currentCarId, displayName } = useCar()
  const [searchParams, setSearchParams] = useSearchParams()
  const range: EnergyRange = isRange(searchParams.get('range')) ? (searchParams.get('range') as EnergyRange) : 'trip'

  // 最近一趟行程 + 上次充电（三段共用锚点）
  const { data: latestTripPage, isLoading: tripLoading } = useQuery({
    queryKey: ['energy-latest-trip', currentCarId],
    queryFn: () => api.trips({ limit: 1, carId: currentCarId }),
    retry: false,
  })
  const latestTrip = latestTripPage?.items[0] ?? null
  const { data: lastChargePage } = useQuery({
    queryKey: ['energy-last-charge', currentCarId],
    queryFn: () => api.charging({ limit: 1, carId: currentCarId }),
    retry: false,
  })
  const lastCharge = lastChargePage?.items[0] ?? null

  // 最近行程段：详情里的 efficiency.ratio 即单趟表显达成（同 avgRatio 式）
  const { data: tripDetail } = useQuery({
    queryKey: ['energy-trip-detail', latestTrip?.id],
    queryFn: () => api.trip(latestTrip!.id),
    enabled: range === 'trip' && latestTrip != null,
    retry: false,
  })

  // since = 自上次充电结束起（无充电记录回落近两年窗口）；all = 近两年（见 ALL_FROM 注释）。
  // 必须记忆化：Date.now() 每渲染一新串会让 queryKey 抖动、查询永远 pending
  const allFrom = useMemo(() => ALL_FROM(), [])
  const windowFrom = useMemo(
    () => (range === 'since' ? lastCharge?.endAt ?? allFrom : range === 'all' ? allFrom : undefined),
    [range, lastCharge?.endAt, allFrom],
  )

  const { data: overview, isLoading: overviewLoading } = useQuery({
    queryKey: ['energy-overview', range, windowFrom, currentCarId],
    queryFn: () => api.tripsOverview({ from: windowFrom, carId: currentCarId }),
    enabled: range !== 'trip',
    retry: false,
  })
  const { data: accuracy } = useQuery({
    queryKey: ['energy-accuracy', range, windowFrom, currentCarId],
    queryFn: () => api.displayAccuracy({ from: windowFrom, months: range === 'all' ? 24 : 12, carId: currentCarId }),
    enabled: range !== 'trip',
    retry: false,
  })
  // 逐趟能耗曲线：since=充电后的行程；all=最近 100 趟（点图上"全部"没有可读性）
  const { data: curvePage } = useQuery({
    queryKey: ['energy-curve', range, windowFrom, currentCarId],
    queryFn: () => api.trips({ limit: 100, from: windowFrom, carId: currentCarId }),
    enabled: range !== 'trip',
    retry: false,
  })
  // 满电预估（照此能耗满电能跑多远）需要电池容量：与电池健康卡共享缓存
  const { data: battery } = useQuery({
    queryKey: ['battery-health', currentCarId],
    queryFn: () => api.batteryHealth(currentCarId),
    retry: false,
  })

  // ---- 派生：四枚 KPI + 满电预估 ----
  const stats = useMemo(() => {
    if (range === 'trip') {
      const tr = latestTrip
      if (!tr) return null
      const avgWh = tr.kwhPer100km > 0 ? Math.round(tr.kwhPer100km * 10) : null
      return {
        distanceKm: tr.distanceKm,
        energyKwh: tr.energyKWh,
        cost: tr.costCny,
        tripCount: 1,
        durationMin: tr.durationMin,
        avgWh,
        ratio: tripDetail?.efficiency?.ratio ?? null,
      }
    }
    if (!overview) return null
    const energy = overview.energyKwh
    const avgWh = energy != null && energy > 0 && overview.distanceKm > 0
      ? Math.round((energy / overview.distanceKm) * 1000)
      : null
    return {
      distanceKm: overview.distanceKm,
      energyKwh: energy,
      cost: overview.costCny,
      tripCount: overview.tripCount,
      durationMin: overview.durationMin,
      avgWh,
      ratio: accuracy?.avgRatio ?? null,
    }
  }, [range, latestTrip, tripDetail, overview, accuracy])

  const projectedKm = stats?.avgWh != null && stats.avgWh > 0 && battery?.capacityKwh
    ? Math.round(battery.capacityKwh / (stats.avgWh / 1000))
    : null

  const curvePoints = useMemo(() => {
    const items = curvePage?.items ?? []
    return items
      .filter((tr) => tr.kwhPer100km > 0 && tr.distanceKm > 0)
      .map((tr) => ({ id: tr.id, endAt: tr.endAt, whPerKm: Math.round(tr.kwhPer100km * 10), distanceKm: tr.distanceKm }))
      .reverse() // API 按时间倒序 → 图按时间正序
  }, [curvePage])

  const loading = range === 'trip' ? tripLoading : overviewLoading
  const empty = range === 'trip' ? !loading && !latestTrip : !loading && overview != null && overview.tripCount === 0
  const months = accuracy?.months ?? []

  // 「自 X 累计」日期守卫：真实库存在时间戳脏行程（首桶落到 1969），荒谬日期不展示
  const firstDay = range === 'all' ? overview?.daily.points[0]?.date : undefined
  const saneFirstDay = firstDay && firstDay >= '2010-01-01' ? firstDay : null
  // 大数收紧小数位（半宽卡在 375px 放不下 "4,663.8 kWh"）：≥1000 取整
  const fmtKwhCompact = (v: number | null | undefined) => (v == null ? '--' : fmtKwh(v, v >= 1000 ? 0 : 1))

  return (
    <div>
      <PageHeader icon={Zap} title={t('energy.title', '能耗')} subtitle={displayName(currentCarId) ?? undefined} />

      {/* 区间切换（车机能耗 App 三段式；写回 ?range 供深链/回退） */}
      <div className="seg mb-4 flex w-full sm:w-auto" data-testid="energy-range" role="tablist" aria-label={t('energy.range.label', '能耗区间')}>
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            role="tab"
            aria-selected={range === r.key}
            data-testid={`energy-range-${r.key}`}
            className={`seg-item ${range === r.key ? 'seg-item-active' : ''}`}
            onClick={() => setSearchParams(r.key === 'trip' ? {} : { range: r.key }, { replace: true })}
          >
            {t(r.labelKey, r.label)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-4">
          <div className="skeleton h-24 rounded-2xl" />
          <SkeletonCards />
        </div>
      ) : empty ? (
        <div className="glass-card-flat" data-testid="energy-empty">
          <EmptyState
            icon={Zap}
            title={range === 'since' ? t('energy.empty.sinceTitle', '充电后还没有行程') : t('energy.empty.title', '暂无行程数据')}
            description={range === 'since'
              ? t('energy.empty.sinceDesc', '下次出发后，这一段的能耗会自动汇总到这里')
              : t('energy.empty.desc', '车辆首次出发后，能耗数据将自动汇入')}
          />
        </div>
      ) : stats ? (
        <div className="space-y-4">
          {/* KPI 四宫格（compact 变体：半宽卡在 375px 放不下大数值，v2.6.3 行程详情同款） */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="energy-kpis">
            <StatCard
              compact
              icon={RouteIcon}
              label={t('energy.kpi.distance', '实际里程')}
              value={`${fmtKm(stats.distanceKm, 0)} km`}
              hint={range === 'trip'
                ? fmtDuration(stats.durationMin)
                : `${stats.tripCount} ${t('dash.tripsUnit', '趟')} · ${fmtDuration(stats.durationMin)}`}
            />
            <StatCard
              compact
              icon={BatteryCharging}
              label={t('energy.kpi.energy', '能耗')}
              value={fmtKwhCompact(stats.energyKwh)}
              hint={`${t('energy.kpi.cost', '电费')} ${stats.cost != null ? fmtCny(stats.cost) : '--'}`}
            />
            <StatCard
              compact
              icon={Gauge}
              label={t('energy.kpi.avg', '平均能耗')}
              value={stats.avgWh != null ? `${stats.avgWh} Wh/km` : '--'}
              hint={stats.avgWh != null ? `${(stats.avgWh / 10).toFixed(1)} kWh/100km` : undefined}
            />
            <StatCard
              compact
              icon={TrendingUp}
              label={t('energy.kpi.accuracy', '表显达成')}
              value={stats.ratio != null ? `${Math.round(stats.ratio * 100)}%` : '--'}
              accent
              hint={stats.ratio != null
                ? stats.ratio >= 1 ? t('eff.beats', '跑赢表显') : t('eff.behind', '未跑赢')
                : t('energy.kpi.accuracyHint', '实际里程 ÷ 表显消耗')}
            />
          </div>

          {/* 区间语境行：这段数据"从哪到哪" + 满电预估 */}
          <div className="glass-card-flat flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-[11px] text-slate-400" data-testid="energy-context">
            {range === 'trip' && latestTrip && (
              <>
                <span className="num">{fmtDateTime(latestTrip.startAt)}</span>
                <span className="min-w-0 truncate text-slate-300">{latestTrip.startAddress} → {latestTrip.endAddress}</span>
                <Link to={`/trips/${latestTrip.id}`} className="ml-auto flex shrink-0 items-center gap-1 text-tesla transition hover:text-tesla-soft" data-testid="energy-trip-link">
                  {t('energy.trip.detail', '行程详情')} <ArrowRight className="h-3 w-3" />
                </Link>
              </>
            )}
            {range === 'since' && (
              <>
                {lastCharge ? (
                  <>
                    <span className="num">{fmtDateTime(lastCharge.endAt)}</span>
                    <span className="min-w-0 truncate text-slate-300">{lastCharge.locationName}</span>
                    <span className="num">{fmtKwh(lastCharge.energyAddedKWh)} {t('energy.since.after', '之后')}</span>
                    <Link to="/charging" className="ml-auto flex shrink-0 items-center gap-1 text-tesla transition hover:text-tesla-soft">
                      {t('dash.recentCharges', '最近充电')} <ArrowRight className="h-3 w-3" />
                    </Link>
                  </>
                ) : (
                  <span>{t('energy.since.noCharge', '尚无充电记录 · 按近两年行程累计')}</span>
                )}
              </>
            )}
            {range === 'all' && overview && (
              <>
                <Timer className="h-3 w-3 text-slate-500" />
                <span>
                  {saneFirstDay
                    ? <>{t('energy.all.since', '自 {d} 累计').replace('{d}', saneFirstDay)}{' · '}</>
                    : <>{t('energy.all.total', '累计')}{' · '}</>}
                  <span className="num">{overview.tripCount} {t('dash.tripsUnit', '趟')}</span>
                </span>
              </>
            )}
            {projectedKm != null && (
              <span className="flex items-center gap-1 rounded-full bg-white/[0.04] px-2.5 py-1 text-slate-300" data-testid="energy-projected">
                <Zap className="h-3 w-3 text-tesla" />
                {t('energy.projected', '照此能耗满电约')} <span className="num">{fmtKm(projectedKm, 0)} km</span>
              </span>
            )}
          </div>

          {/* 逐趟能耗曲线（按时间） */}
          {range !== 'trip' && (
            <section className="glass-card-flat p-4" data-testid="energy-trend-card">
              <div className="mb-2.5 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-medium text-slate-200">
                  <TrendingUp className="h-4 w-4 text-tesla" /> {t('energy.trend.title', '逐趟能耗（按时间）')}
                </h3>
                <span className="num text-[11px] text-slate-500">
                  {range === 'all' ? t('energy.trend.last100', '近 100 趟') : t('energy.trend.sinceCharge', '充电后')}
                </span>
              </div>
              {curvePoints.length >= 2 ? (
                <ConsumptionTrendChart points={curvePoints} avgWhPerKm={stats.avgWh} />
              ) : (
                <p className="py-4 text-center text-xs text-slate-500">{t('energy.trend.noData', '暂无行程样本')}</p>
              )}
            </section>
          )}

          {/* 每月：实际里程 vs 表显消耗（预估） */}
          {range !== 'trip' && months.length >= 2 && (
            <section className="glass-card-flat p-4" data-testid="energy-monthly-card">
              <div className="mb-2.5 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-medium text-slate-200">
                  <Coins className="h-4 w-4 text-tesla" /> {t('energy.monthly.title', '每月：实际 vs 表显消耗')}
                </h3>
                <span className="num text-[11px] text-slate-500">{t('energy.monthly.hint', '近 {n} 个月').replace('{n}', String(Math.min(months.length, 12)))}</span>
              </div>
              <MonthlyAccuracyChart months={months} />
            </section>
          )}

          {/* 能效画像（近两年视角：温度/均速什么情况最省） */}
          {range === 'all' && (
            <EfficiencyCard from={ALL_FROM()} />
          )}
        </div>
      ) : null}
    </div>
  )
}
