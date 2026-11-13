import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ChevronRight, Clock, Coins, Gauge, MapPinned, Route, TrendingUp, X } from 'lucide-react'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { SkeletonList } from '@/components/Skeletons'
import { StatCard } from '@/components/StatCard'
import { useI18n } from '@/i18n'
import { useCar } from '@/contexts/CarContext'
import { fmtCny, fmtDateTime, fmtDuration, fmtKm, fmtKwh, toInputDate } from '@/utils/format'
import type { TripsOverview } from '@/types'

// 轨迹汇总图二级懒加载：地图 chunk（Leaflet ~156KB）不阻塞行程页首屏
const RouteMap = lazy(() => import('@/components/RouteMap').then((m) => ({ default: m.RouteMap })))

const PAGE_SIZE = 20
/** 默认筛选窗口（v0.3）：近 90 天——手机端首屏 & 列表噪音双优；「清除」可看全部 */
const DEFAULT_WINDOW_DAYS = 90

/** 状态占比条：行驶/充电/驻车（时长近似口径），一行分段彩色条 + 图例 */
function StateShareBar({ data }: { data: TripsOverview['stateShare'] }) {
  const { t } = useI18n()
  const { driveMin, chargeMin, parkedMin } = data
  const total = Math.max(driveMin + chargeMin + parkedMin, 1)
  const segs = [
    { key: 'trips.share.drive', zh: '行驶', min: driveMin, cls: 'bg-sky-500', dot: 'bg-sky-500' },
    { key: 'trips.share.charge', zh: '充电', min: chargeMin, cls: 'bg-emerald-500', dot: 'bg-emerald-500' },
    { key: 'trips.share.parked', zh: '驻车', min: parkedMin, cls: 'bg-slate-600', dot: 'bg-slate-600' },
  ]
  return (
    <div data-testid="trip-state-share">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-white/[0.05]" role="presentation">
        {segs.map((s) => (
          <div key={s.key} className={s.cls} style={{ width: `${(s.min / total) * 100}%` }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
        {segs.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-sm ${s.dot}`} />
            {t(s.key, s.zh)} <span className="num text-slate-300">{fmtDuration(s.min)}</span>
            <span className="num text-slate-500">{((s.min / total) * 100).toFixed(0)}%</span>
          </span>
        ))}
      </div>
    </div>
  )
}

export default function TripsPage() {
  const { t } = useI18n()
  const today = useMemo(() => new Date(), [])
  const defaultFrom = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - DEFAULT_WINDOW_DAYS)
    return toInputDate(d)
  }, [])
  const { currentCarId } = useCar()
  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState('')

  const rangeParams = useMemo(
    () => ({
      from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
      carId: currentCarId,
    }),
    [from, to, currentCarId],
  )

  // 无限滚动：useInfiniteQuery 累积分页，sentinel 进视口即取下一页
  const {
    data, isLoading, isFetching, isError, refetch, fetchNextPage, hasNextPage,
  } = useInfiniteQuery({
    queryKey: ['trips', rangeParams],
    queryFn: ({ pageParam }) => api.trips({ limit: PAGE_SIZE, offset: pageParam, ...rangeParams }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0)
      return loaded < lastPage.total ? loaded : undefined
    },
  })
  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data])
  const total = data?.pages[0]?.total ?? 0

  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting && hasNextPage && !isFetching) void fetchNextPage() },
      { rootMargin: '400px 0px' }, // 提前 400px 预载，滚动到底无感衔接
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasNextPage, isFetching, fetchNextPage])

  // 顶部汇总（KPI + 占比条 + 轨迹图）与列表同区间
  const { data: overview } = useQuery({
    queryKey: ['trips-overview', rangeParams],
    queryFn: () => api.tripsOverview(rangeParams),
    retry: false,
  })
  const { data: routeSummary } = useQuery({
    queryKey: ['trips-route-summary', rangeParams],
    queryFn: () => api.tripsRouteSummary(rangeParams),
    retry: false,
    staleTime: 5 * 60_000,
  })

  const applyFilter = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom)
    setTo(nextTo)
  }

  return (
    <div>
      <PageHeader
        icon={Route}
        title={t('trips.title', '行程')}
        subtitle={data ? `${t('trips.subtitle.totalPrefix', '共')} ${total} ${t('trips.subtitle.totalSuffix', '条记录')}` : t('trips.subtitle.loading', '行车记录')}
      />

      {/* 日期筛选（默认近 90 天；清除=全部） */}
      <div className="glass-card-flat mb-4 flex flex-wrap items-end gap-3 p-4" data-testid="trip-filter">
        <div>
          <label htmlFor="filter-from" className="mb-1 block text-[11px] text-slate-400">{t('trips.filter.from', '开始日期')}</label>
          <input
            id="filter-from"
            type="date"
            className="input-dark !w-auto"
            value={from}
            max={to || toInputDate(today)}
            onChange={(e) => applyFilter(e.target.value, to)}
          />
        </div>
        <div>
          <label htmlFor="filter-to" className="mb-1 block text-[11px] text-slate-400">{t('trips.filter.to', '结束日期')}</label>
          <input
            id="filter-to"
            type="date"
            className="input-dark !w-auto"
            value={to}
            min={from || undefined}
            max={toInputDate(today)}
            onChange={(e) => applyFilter(from, e.target.value)}
          />
        </div>
        {(from || to) && (
          <button
            className="btn-ghost !px-2.5 !py-2"
            onClick={() => { setFrom(''); setTo('') }}
            aria-label={t('trips.filter.clear', '清除筛选')}
            title={t('trips.filter.clear', '清除筛选')}
            data-testid="filter-clear"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* 顶部汇总（Grafana trip.json 提炼）：KPI 行 + 状态占比条 + 区间轨迹汇总图 */}
      {overview && overview.tripCount > 0 && (
        <div className="mb-4 space-y-4" data-testid="trip-overview">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon={Route} label={t('trips.kpi.distance', '总里程')} value={`${fmtKm(overview.distanceKm, 0)} km`} hint={`${overview.tripCount} ${t('dash.tripsUnit', '趟')} · ${fmtDuration(overview.durationMin)}`} />
            <StatCard icon={Gauge} label={t('trips.kpi.maxSpeed', '最高时速')} value={overview.maxSpeedKmh != null ? `${Math.round(overview.maxSpeedKmh)} km/h` : '--'} />
            <StatCard icon={TrendingUp} label={t('trips.kpi.energy', '总能耗')} value={overview.energyKwh != null ? fmtKwh(overview.energyKwh) : '--'} />
            <StatCard icon={Coins} label={t('trips.kpi.cost', '总电费')} value={overview.costCny != null ? fmtCny(overview.costCny) : '--'} accent />
          </div>
          <div className="glass-card-flat p-4">
            <div className="mb-2.5 flex items-center gap-2 text-sm font-medium text-slate-200">
              <Clock className="h-4 w-4 text-tesla" /> {t('trips.share.title', '时间分布（区间内）')}
            </div>
            <StateShareBar data={overview.stateShare} />
          </div>
          {routeSummary && routeSummary.points.length >= 2 && (
            <div className="glass-card-flat p-4">
              <div className="mb-2.5 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-medium text-slate-200">
                  <MapPinned className="h-4 w-4 text-tesla" /> {t('trips.map.title', '轨迹汇总')}
                </h3>
                <span className="num text-[11px] text-slate-500">{t('trips.map.pointsPrefix', '采样')} {routeSummary.pointCount.toLocaleString()} {t('heatmap.stats.daysUnit', '点')}</span>
              </div>
              <Suspense fallback={<div className="skeleton h-64 w-full rounded-xl" />}>
                <RouteMap points={routeSummary.points} height={280} />
              </Suspense>
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <SkeletonList rows={6} />
      ) : isError ? (
        <div className="glass-card-flat">
          <EmptyState
            icon={Route}
            title={t('common.loadError.title', '加载失败')}
            description={t('common.loadError.desc', '数据源连接异常，数据不会丢失')}
            action={{ label: t('common.retry', '重试'), onClick: () => void refetch() }}
          />
        </div>
      ) : items.length === 0 ? (
        <div className="glass-card-flat">
          <EmptyState
            icon={Route}
            title={t('trips.empty.title', '没有符合条件的行程')}
            description={t('trips.empty.desc', '调整日期范围，或等 TeslaMate 记录到新行程后刷新')}
          />
        </div>
      ) : (
        <div className={isFetching ? 'opacity-60 transition' : 'transition'}>
          <ul className="space-y-2.5" data-testid="trip-list">
            {items.map((trip) => (
              <li key={trip.id}>
                <Link
                  to={`/trips/${trip.id}`}
                  className="glass-card flex items-center gap-3 p-4 transition hover:border-white/[0.12] hover:bg-white/[0.06]"
                  data-testid="trip-item"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-100">
                      {trip.startAddress} → {trip.endAddress}
                    </div>
                    <div className="num mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
                      <span>{fmtDateTime(trip.startAt)}</span>
                      <span>{fmtKm(trip.distanceKm)} km</span>
                      <span>{fmtDuration(trip.durationMin)}</span>
                      <span>{fmtKwh(trip.energyKWh)}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="num text-sm font-semibold text-tesla">{fmtCny(trip.costCny)}</div>
                    <div className="num mt-0.5 text-[11px] text-slate-400">{fmtKm(trip.kwhPer100km, 1)} kWh/100km</div>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />
                </Link>
              </li>
            ))}
          </ul>
          {/* 无限滚动哨兵：进视口自动取下一页；替代底部页码 */}
          <div ref={sentinelRef} data-testid="trip-scroll-sentinel" className="h-2" />
          <div className="num pt-3 pb-1 text-center text-[11px] text-slate-500" data-testid="trip-load-state">
            {hasNextPage
              ? isFetching ? t('trips.loadingMore', '加载中…') : t('trips.scrollHint', '下滑加载更多')
              : t('trips.allLoaded', '已加载全部 {n} 条').replace('{n}', String(total))}
          </div>
        </div>
      )}
    </div>
  )
}
