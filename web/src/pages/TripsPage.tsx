import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { ChevronRight, Clock, Coins, Download, Gauge, MapPinned, Route, TrendingUp, X } from 'lucide-react'
import { api, buildExportQuery } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { SkeletonList } from '@/components/Skeletons'
import { StatCard } from '@/components/StatCard'
import { DailyActivityChart } from '@/components/DailyActivityChart'
import { EfficiencyCard } from '@/components/EfficiencyCard'
import { useI18n } from '@/i18n'
import { useCar } from '@/contexts/CarContext'
import { fmtMoney, fmtDateTime, fmtDuration, fmtKm, fmtKwh, toInputDate } from '@/utils/format'

// 轨迹汇总图二级懒加载：地图 chunk（Leaflet ~156KB）不阻塞行程页首屏
const RouteMap = lazy(() => import('@/components/RouteMap').then((m) => ({ default: m.RouteMap })))

const PAGE_SIZE = 20
/** 默认筛选窗口（v0.3）：近 90 天——手机端首屏 & 列表噪音双优；「清除」可看全部 */
const DEFAULT_WINDOW_DAYS = 90

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export default function TripsPage() {
  const { t } = useI18n()
  const today = useMemo(() => new Date(), [])
  const defaultFrom = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - DEFAULT_WINDOW_DAYS)
    return toInputDate(d)
  }, [])
  const { currentCarId } = useCar()
  // URL ?from&to（YYYY-MM-DD）：仪表盘热力图点格子跳当日行程的入口（PRD P2 模块4）
  const [searchParams] = useSearchParams()
  const [from, setFrom] = useState(() => {
    const p = searchParams.get('from')
    return p && DATE_RE.test(p) ? p : defaultFrom
  })
  const [to, setTo] = useState(() => {
    const p = searchParams.get('to')
    return p && DATE_RE.test(p) ? p : ''
  })
  // 已在本页时 URL 再变化（浏览器前进/后退）跟随；手动改日期不写回 URL
  useEffect(() => {
    const pf = searchParams.get('from')
    const pt = searchParams.get('to')
    if (pf && DATE_RE.test(pf)) setFrom(pf)
    if (pt && DATE_RE.test(pt)) setTo(pt)
  }, [searchParams])

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
        action={(
          // v2.6.1 导出挪到标题行右缘（用户反馈：筛选卡被挤换行不美观）
          <a
            className="btn-ghost !px-2.5 !py-2"
            href={`/api/export/trips${buildExportQuery(from, to, currentCarId)}`}
            download
            aria-label={t('trips.export', '导出 CSV')}
            title={t('trips.export', '导出 CSV')}
            data-testid="trip-export"
          >
            <Download className="h-4 w-4" />
          </a>
        )}
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
        <div className="ml-auto flex items-center gap-1.5">
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
      </div>

      {/* 顶部汇总（Grafana trip.json 提炼）：KPI 行 + 状态占比条 + 区间轨迹汇总图 */}
      {overview && overview.tripCount > 0 && (
        <div className="mb-4 space-y-4" data-testid="trip-overview">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon={Route} label={t('trips.kpi.distance', '总里程')} value={`${fmtKm(overview.distanceKm, 0)} km`} hint={`${overview.tripCount} ${t('dash.tripsUnit', '趟')} · ${fmtDuration(overview.durationMin)}`} />
            <StatCard icon={Gauge} label={t('trips.kpi.maxSpeed', '最高时速')} value={overview.maxSpeedKmh != null ? `${Math.round(overview.maxSpeedKmh)} km/h` : '--'} />
            <StatCard icon={TrendingUp} label={t('trips.kpi.energy', '总能耗')} value={overview.energyKwh != null ? fmtKwh(overview.energyKwh) : '--'} />
            <StatCard icon={Coins} label={t('trips.kpi.cost', '总电费')} value={overview.cost != null ? fmtMoney(overview.cost) : '--'} accent />
          </div>
          <div className="glass-card-flat p-4">
            <div className="mb-2.5 flex items-center gap-2 text-sm font-medium text-slate-200">
              <Clock className="h-4 w-4 text-tesla" /> {t('trips.share.title', '时间分布（区间内）')}
            </div>
            {/* v0.4：每日活跃柱状图（旧三段占比条被驻车 ~96% 压成灰条，已废） */}
            <DailyActivityChart overview={overview} />
          </div>
          {routeSummary && routeSummary.segments.length > 0 && (
            <div className="glass-card-flat p-4">
              <div className="mb-2.5 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-medium text-slate-200">
                  <MapPinned className="h-4 w-4 text-tesla" /> {t('trips.map.title', '轨迹汇总')}
                </h3>
                <span className="num text-[11px] text-slate-500">
                  {t('trips.map.tripsShown', '绘制')} {routeSummary.segments.length} / {routeSummary.tripCount} {t('dash.tripsUnit', '趟')}
                </span>
              </div>
              {/* 每段行程各自成线（TeslaMate trip.json 观感）；无速度图例/起终点标记 */}
              <Suspense fallback={<div className="skeleton h-64 w-full rounded-xl" />}>
                <RouteMap points={[]} segments={routeSummary.segments} height={280} showSpeedLegend={false} />
              </Suspense>
            </div>
          )}
        </div>
      )}

      {/* v2.6.1 能效画像：数据跟随筛选区间（v2.6 固定近一年已废——有筛选的页面数据必须随筛选走） */}
      <div className="mb-4">
        <EfficiencyCard from={rangeParams.from} to={rangeParams.to} />
      </div>

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
                    <div className="num text-sm font-semibold text-tesla">{fmtMoney(trip.cost)}</div>
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
