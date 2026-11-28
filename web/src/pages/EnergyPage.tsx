import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  BatteryCharging,
  Gauge,
  Timer,
  TrendingDown,
  TrendingUp,
  Zap,
} from 'lucide-react'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { StatCard } from '@/components/StatCard'
import { EmptyState } from '@/components/EmptyState'
import { SkeletonCards } from '@/components/Skeletons'
import { EfficiencyCard } from '@/components/EfficiencyCard'
import { MonthlyAccuracyChart } from '@/components/MonthlyAccuracyChart'
import { EnergyCurveChart } from '@/components/EnergyCurveChart'
import { useI18n } from '@/i18n'
import { useCar } from '@/contexts/CarContext'
import { fmtMoney, fmtDateTime, fmtDuration, fmtKm, fmtKwh } from '@/utils/format'

/**
 * 能耗页 v2.8 —— 车机能耗 App 同构（参考 Tesla 车机「能量」页四窗设计）：
 * ① 四卡同屏：最近行程 / 自上次充电 / 近 30 天 / 近两年，每卡 = 迷你逐趟趋势线
 *    + 平均 Wh/km 大数 + km/kWh/时长小字；点卡展开该窗详情（车机"点进单卡"式）。
 * ② 车机式头条：`X km · 比额定多跑 Y km`（绝对公里差，绿=跑赢表显/橙=没跑赢）。
 *    数据 = overview.ratedUsedKm（v2.8 新字段）；最近行程窗用详情 ratio 反推。
 * ③ 长期视角：近两年窗展开 月度实际vs表显 + 能效画像；曲线图（车机瞬时vs平均）
 *    为批2 待接（trip/since 窗详情内，positions 分桶端点）。
 * 口径诚实：数字为行驶能耗（TeslaMate 无温控/驻车功耗分拆，与车机"已消耗"总量不同口径）。
 */

const WINDOWS = [
  { key: 'trip', label: '最近行程', labelKey: 'energy.win.trip' },
  { key: 'since', label: '自上次充电', labelKey: 'energy.win.since' },
  { key: 'm30', label: '近 30 天', labelKey: 'energy.win.m30' },
  { key: 'y2', label: '近两年', labelKey: 'energy.win.y2' },
] as const
type WinKey = (typeof WINDOWS)[number]['key']
const isWinKey = (v: string | null): v is WinKey => WINDOWS.some((w) => w.key === v)

/** 批2：GET /api/trips/energy-curve（positions 1km 分桶 + 滑动平均）将插入最近行程/自上次充电详情 */

/** 逐趟 Wh/km 迷你趋势线（SVG polyline，中性墨——纯趋势轮廓不带极性色） */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return (
      <div className="flex h-6 w-14 items-end gap-px opacity-40" aria-hidden="true">
        {[40, 65, 50, 75, 55, 80].map((h, i) => (
          <span key={i} className="w-full rounded-sm bg-slate-500" style={{ height: `${h}%` }} />
        ))}
      </div>
    )
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  // 末位留 3% 给描边宽度；y 反转（能耗低=省=画在上方）
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 97 + 1.5
      const y = 26.5 - ((v - min) / span) * 23
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="h-6 w-14 shrink-0 text-slate-400" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

interface WinStats {
  km: number
  kwh: number | null
  cost: number | null
  durationMin: number
  avgWh: number | null
  tripCount: number
}

/** 单窗数据钩子：overview（trip 窗除外）+ 迷你趋势用的逐趟序列 */
function useWindowData(win: WinKey, anchor?: string) {
  const { currentCarId } = useCar()
  const enabled = win !== 'trip' && anchor !== undefined
  const overview = useQuery({
    queryKey: ['energy-ov', win, anchor, currentCarId],
    queryFn: () => api.tripsOverview({ from: anchor, carId: currentCarId }),
    enabled,
    retry: false,
    staleTime: 60_000,
  })
  const spark = useQuery({
    queryKey: ['energy-spark', win, anchor, currentCarId],
    queryFn: () => api.trips({ limit: 30, from: anchor, carId: currentCarId }),
    retry: false,
    staleTime: 60_000,
  })
  const sparkValues = useMemo(
    () =>
      (spark.data?.items ?? [])
        .filter((tr) => tr.kwhPer100km > 0 && tr.distanceKm > 0.5)
        .map((tr) => Math.round(tr.kwhPer100km * 10))
        .reverse(),
    [spark.data],
  )
  return { overview: overview.data, loading: enabled && overview.isLoading, sparkValues }
}

export default function EnergyPage() {
  const { t } = useI18n()
  const { currentCarId, displayName } = useCar()
  const [searchParams, setSearchParams] = useSearchParams()
  const active: WinKey = isWinKey(searchParams.get('range')) ? (searchParams.get('range') as WinKey) : 'trip'

  // 窗口锚点一次性计算（Date.now() 每渲染新串会打爆 queryKey——v2.7 教训）
  const anchors = useMemo(() => ({
    m30: new Date(Date.now() - 30 * 86400_000).toISOString(),
    y2: new Date(Date.now() - 730 * 86400_000).toISOString(),
  }), [])

  // 最近一趟 + 上次充电（trip 卡数据源 + since 卡锚点）。
  // 取 5 条挑首条 ≥0.5km：最新记录常是 0km 挪车微行程（avgWh 除零、卡面全 0）
  const { data: latestTripPage, isLoading: tripLoading } = useQuery({
    queryKey: ['energy-latest-trip', currentCarId],
    queryFn: () => api.trips({ limit: 5, carId: currentCarId }),
    retry: false,
  })
  const latestTrip = useMemo(
    () => latestTripPage?.items.find((tr) => tr.distanceKm >= 0.5) ?? null,
    [latestTripPage],
  )
  const { data: lastChargePage } = useQuery({
    queryKey: ['energy-last-charge', currentCarId],
    queryFn: () => api.charging({ limit: 1, carId: currentCarId }),
    retry: false,
  })
  const lastCharge = lastChargePage?.items[0] ?? null
  const sinceAnchor = lastCharge?.endAt ?? undefined

  const tripData = useWindowData('trip')
  const sinceData = useWindowData('since', sinceAnchor)
  const m30Data = useWindowData('m30', anchors.m30)
  const y2Data = useWindowData('y2', anchors.y2)

  const winData: Record<WinKey, ReturnType<typeof useWindowData>> = {
    trip: tripData, since: sinceData, m30: m30Data, y2: y2Data,
  }

  // 每窗统计：trip 来自 latestTrip（表显口径 kwhPer100km×10），其余来自 overview
  const stats = useMemo(() => {
    const s: Record<WinKey, WinStats | null> = { trip: null, since: null, m30: null, y2: null }
    if (latestTrip) {
      s.trip = {
        km: latestTrip.distanceKm,
        kwh: latestTrip.energyKWh,
        cost: latestTrip.cost,
        durationMin: latestTrip.durationMin,
        avgWh: latestTrip.kwhPer100km > 0 ? Math.round(latestTrip.kwhPer100km * 10) : null,
        tripCount: 1,
      }
    }
    for (const key of ['since', 'm30', 'y2'] as const) {
      const ov = winData[key].overview
      if (!ov) continue
      s[key] = {
        km: ov.distanceKm,
        kwh: ov.energyKwh,
        cost: ov.cost,
        durationMin: ov.durationMin,
        avgWh: ov.energyKwh != null && ov.distanceKm > 0 ? Math.round((ov.energyKwh / ov.distanceKm) * 1000) : null,
        tripCount: ov.tripCount,
      }
    }
    return s
  }, [latestTrip, winData.since.overview, winData.m30.overview, winData.y2.overview]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 展开窗详情数据 ----
  const { data: tripDetail } = useQuery({
    queryKey: ['energy-trip-detail', latestTrip?.id],
    queryFn: () => api.trip(latestTrip!.id),
    enabled: active === 'trip' && latestTrip != null,
    retry: false,
  })
  const { data: accuracy } = useQuery({
    queryKey: ['energy-accuracy', active, active === 'since' ? sinceAnchor : anchors[active as 'm30' | 'y2'], currentCarId],
    queryFn: () => api.displayAccuracy({
      from: active === 'since' ? sinceAnchor : anchors[active as 'm30' | 'y2'],
      months: active === 'y2' ? 24 : 12,
      carId: currentCarId,
    }),
    enabled: active !== 'trip' && (active !== 'since' || sinceAnchor != null),
    retry: false,
  })
  // 满电预估需要电池容量（与电池健康卡共享缓存）
  const { data: battery } = useQuery({
    queryKey: ['battery-health', currentCarId],
    queryFn: () => api.batteryHealth(currentCarId),
    retry: false,
  })
  // 车机能量曲线（v2.8.2）：trip 窗衰减+瞬时两张，since 窗瞬时一张（positions 分桶）
  const curveAnchor = active === 'trip' ? latestTrip?.id : active === 'since' ? sinceAnchor : undefined
  const { data: curve } = useQuery({
    queryKey: ['energy-curve', active, curveAnchor, currentCarId],
    queryFn: () =>
      active === 'trip'
        ? api.energyCurve({ driveId: latestTrip!.id, carId: currentCarId })
        : api.energyCurve({ from: sinceAnchor, carId: currentCarId }),
    enabled: (active === 'trip' && latestTrip != null) || (active === 'since' && sinceAnchor != null),
    retry: false,
  })

  const st = stats[active]
  const detailLoading =
    (active === 'trip' && tripLoading) ||
    (active !== 'trip' && active !== 'since' && winData[active].loading) ||
    (active === 'since' && sinceAnchor != null && winData.since.loading)
  const sinceNoCharge = active === 'since' && sinceAnchor == null

  // 头条：实际里程 + 比额定 ±X km（表显达成绝对化）
  const headline = useMemo(() => {
    if (!st || detailLoading) return null
    let ratedKm: number | null = null
    if (active === 'trip') {
      const ratio = tripDetail?.efficiency?.ratio
      ratedKm = ratio != null && ratio > 0 ? st.km / ratio : null
    } else {
      ratedKm = winData[active].overview?.ratedUsedKm ?? null
    }
    const delta = ratedKm != null ? st.km - ratedKm : null
    return { km: st.km, delta, ratedKm }
  }, [st, active, tripDetail, winData, detailLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  const ratio = active === 'trip' ? tripDetail?.efficiency?.ratio ?? null : accuracy?.avgRatio ?? null
  const projectedKm = st?.avgWh != null && st.avgWh > 0 && battery?.capacityKwh
    ? Math.round(battery.capacityKwh / (st.avgWh / 1000))
    : null
  const months = accuracy?.months ?? []

  return (
    <div>
      <PageHeader icon={Zap} title={t('energy.title', '能耗')} subtitle={displayName(currentCarId) ?? undefined} />

      {/* 四卡同屏（车机能量页式）：点卡展开详情 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="energy-cards">
        {WINDOWS.map((w) => {
          const ws = stats[w.key]
          const loading = w.key === 'trip' ? tripLoading : winData[w.key].loading
          const disabled = w.key === 'since' && sinceAnchor == null
          return (
            <button
              key={w.key}
              type="button"
              onClick={() => !disabled && setSearchParams(w.key === 'trip' ? {} : { range: w.key }, { replace: true })}
              aria-pressed={active === w.key}
              disabled={disabled}
              data-testid={`energy-card-${w.key}`}
              className={`glass-card flex min-w-0 flex-col gap-1.5 p-3.5 text-left transition active:scale-[0.98] ${
                active === w.key ? 'border-tesla/40 bg-white/[0.05] shadow-glow' : ''
              } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
            >
              <span className="flex w-full items-center justify-between gap-1.5">
                <span className="min-w-0 truncate text-[10px] text-slate-400">{t(w.labelKey, w.label)}</span>
                {loading ? (
                  <span className="skeleton h-4 w-14 shrink-0 rounded" />
                ) : (
                  <Sparkline values={winData[w.key].sparkValues} />
                )}
              </span>
              <span className="num text-lg font-semibold leading-none text-slate-100">
                {loading ? <span className="skeleton inline-block h-5 w-16 rounded" /> : ws?.avgWh != null ? `${ws.avgWh} Wh/km` : '--'}
              </span>
              <span className="num w-full truncate text-[10px] text-slate-500" title={ws ? `${fmtKm(ws.km, 0)} km · ${ws.kwh != null ? fmtKwh(ws.kwh) : '--'} · ${fmtDuration(ws.durationMin)}` : undefined}>
                {ws
                  ? `${fmtKm(ws.km, 0)} km · ${ws.kwh != null ? fmtKwh(ws.kwh) : '--'} · ${fmtDuration(ws.durationMin)}`
                  : disabled
                    ? t('energy.win.noCharge', '尚无充电记录')
                    : '--'}
              </span>
            </button>
          )
        })}
      </div>

      {/* 展开窗详情 */}
      <div className="mt-4 space-y-4" data-testid="energy-detail">
        {sinceNoCharge ? (
          <div className="glass-card-flat" data-testid="energy-empty">
            <EmptyState
              icon={Zap}
              title={t('energy.empty.sinceTitle', '尚无充电记录')}
              description={t('energy.empty.sinceDesc', '完成首次充电后，这里会展示自充电以来的能耗')}
            />
          </div>
        ) : detailLoading || !st ? (
          <div className="space-y-4">
            <div className="skeleton h-24 rounded-2xl" />
            <SkeletonCards />
          </div>
        ) : (
          <>
            {/* 车机式头条：X km · 比额定多/少跑 Y km */}
            {headline && (
              <section className="glass-card-flat fade-up px-4 py-3.5" data-testid="energy-headline">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="num text-2xl font-semibold text-white">{fmtKm(headline.km, 1)} km</span>
                  {headline.delta != null && (
                    <span className={`num flex items-center gap-1 text-sm font-medium ${headline.delta >= 0 ? 'text-emerald-400' : 'text-amber-400'}`} data-testid="energy-headline-delta">
                      {headline.delta >= 0 ? <TrendingDown className="h-4 w-4" /> : <TrendingUp className="h-4 w-4" />}
                      {headline.delta >= 0
                        ? t('energy.headline.beats', '比额定多跑 {n} km').replace('{n}', fmtKm(headline.delta, 1))
                        : t('energy.headline.behind', '比额定少跑 {n} km').replace('{n}', fmtKm(Math.abs(headline.delta), 1))}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {t('energy.headline.hint', '表显续航口径 · 行驶能耗（不含温控/驻车）')}
                </p>
              </section>
            )}

            {/* KPI 2×2（窄屏 3 列已证截断——v2.8 截图自检教训）：第四格 = 满电预估 */}
            <div className="grid grid-cols-2 gap-3" data-testid="energy-kpis">
              <StatCard compact icon={BatteryCharging} label={t('energy.kpi.energy', '能耗')} value={fmtKwhBig(st.kwh)} hint={st.cost != null ? fmtMoney(st.cost) : undefined} />
              <StatCard compact icon={Gauge} label={t('energy.kpi.avg', '平均能耗')} value={st.avgWh != null ? `${st.avgWh} Wh/km` : '--'} hint={st.avgWh != null ? `${(st.avgWh / 10).toFixed(1)} kWh/100km` : undefined} />
              <StatCard
                compact
                icon={TrendingUp}
                label={t('energy.kpi.accuracy', '表显达成')}
                value={ratio != null ? `${Math.round(ratio * 100)}%` : '--'}
                accent
                hint={ratio != null ? (ratio >= 1 ? t('eff.beats', '跑赢表显') : t('eff.behind', '未跑赢')) : undefined}
              />
              <StatCard
                compact
                icon={Zap}
                label={t('energy.kpi.projected', '满电预估')}
                value={projectedKm != null ? `${fmtKm(projectedKm, 0)} km` : '--'}
                hint={t('energy.projectedHint', '照此能耗 · 满容量')}
                data-testid="energy-projected"
              />
            </div>

            {/* 区间语境行 + 满电预估 */}
            <div className="glass-card-flat flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-[11px] text-slate-400" data-testid="energy-context">
              {active === 'trip' && latestTrip && (
                <>
                  <span className="num">{fmtDateTime(latestTrip.startAt)}</span>
                  <span className="min-w-0 truncate text-slate-300">{latestTrip.startAddress} → {latestTrip.endAddress}</span>
                  <Link to={`/trips/${latestTrip.id}`} className="ml-auto flex shrink-0 items-center gap-1 text-tesla transition hover:text-tesla-soft" data-testid="energy-trip-link">
                    {t('energy.trip.detail', '行程详情')} <ArrowRight className="h-3 w-3" />
                  </Link>
                </>
              )}
              {active === 'since' && lastCharge && (
                <>
                  <span className="num">{fmtDateTime(lastCharge.endAt)}</span>
                  <span className="min-w-0 truncate text-slate-300">{lastCharge.locationName}</span>
                  <span className="num">{fmtKwh(lastCharge.energyAddedKWh)} {t('energy.since.after', '之后')}</span>
                  <Link to="/charging" className="ml-auto flex shrink-0 items-center gap-1 text-tesla transition hover:text-tesla-soft">
                    {t('dash.recentCharges', '最近充电')} <ArrowRight className="h-3 w-3" />
                  </Link>
                </>
              )}
              {(active === 'm30' || active === 'y2') && st && (
                <>
                  <Timer className="h-3 w-3 text-slate-500" />
                  <span className="num">{st.tripCount} {t('dash.tripsUnit', '趟')}</span>
                </>
              )}
            </div>

            {/* 车机能量曲线（trip 窗：衰减+瞬时；since 窗：瞬时；样本 ≥2 才渲染） */}
            {curve && curve.points.length >= 2 && (
              <>
                {active === 'trip' && (
                  <section className="glass-card-flat p-4" data-testid="energy-decay-card">
                    <div className="mb-2.5 flex items-center justify-between">
                      <h3 className="flex items-center gap-2 text-sm font-medium text-slate-200">
                        <TrendingDown className="h-4 w-4 text-tesla" /> {t('energy.curve.decayTitle', '续航衰减（vs 额定）')}
                      </h3>
                      <span className="num text-[11px] text-slate-500">
                        {t('energy.curve.consumed', '已消耗 {n} km 表显').replace('{n}', fmtKm(curve.ratedUsedKm, 1))}
                      </span>
                    </div>
                    <EnergyCurveChart points={curve.points} startRatedKm={curve.startRatedKm} mode="decay" />
                  </section>
                )}
                <section className="glass-card-flat p-4" data-testid="energy-instant-card">
                  <div className="mb-2.5 flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-medium text-slate-200">
                      <TrendingUp className="h-4 w-4 text-tesla" />
                      {active === 'trip' ? t('energy.curve.instantTitleTrip', '本趟瞬时能耗') : t('energy.curve.instantTitleSince', '自充电以来瞬时能耗')}
                    </h3>
                    <span className="num text-[11px] text-slate-500">{curve.avgWhPerKm != null ? `${curve.avgWhPerKm} Wh/km` : ''}</span>
                  </div>
                  <EnergyCurveChart points={curve.points} startRatedKm={curve.startRatedKm} mode="instant" />
                </section>
              </>
            )}

            {/* 长期视角（近两年窗）：月度实际 vs 表显 + 能效画像 */}
            {active === 'y2' && months.length >= 2 && (
              <section className="glass-card-flat p-4" data-testid="energy-monthly-card">
                <div className="mb-2.5 flex items-center justify-between">
                  <h3 className="flex items-center gap-2 text-sm font-medium text-slate-200">
                    <TrendingUp className="h-4 w-4 text-tesla" /> {t('energy.monthly.title', '每月：实际 vs 表显消耗')}
                  </h3>
                  <span className="num text-[11px] text-slate-500">{t('energy.monthly.hint', '近 {n} 个月').replace('{n}', String(Math.min(months.length, 12)))}</span>
                </div>
                <MonthlyAccuracyChart months={months} />
              </section>
            )}
            {active === 'y2' && <EfficiencyCard from={anchors.y2} />}
          </>
        )}
      </div>
    </div>
  )
}

/** ≥1000 kWh 收整（半宽卡放不下 "4,663.8 kWh"——v2.7 截图自检教训） */
function fmtKwhBig(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '--'
  return fmtKwh(v, v >= 1000 ? 0 : 1)
}
