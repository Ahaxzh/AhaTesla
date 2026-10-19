import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ChevronRight, Route } from 'lucide-react'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { Pagination } from '@/components/Pagination'
import { EmptyState } from '@/components/EmptyState'
import { SkeletonList } from '@/components/Skeletons'
import { useI18n } from '@/i18n'
import { useCar } from '@/contexts/CarContext'
import { fmtCny, fmtDateTime, fmtDuration, fmtKm, fmtKwh, toInputDate } from '@/utils/format'

const PAGE_SIZE = 20

export default function TripsPage() {
  const { t } = useI18n()
  const [page, setPage] = useState(1)
  const today = useMemo(() => new Date(), [])
  const { currentCarId } = useCar()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  // 切车/改筛选回第 1 页（车 B 只有 12 条时，沿用 A 的第 3 页会看到假"无数据"）
  useEffect(() => { setPage(1) }, [currentCarId, from, to])

  const params = useMemo(
    () => ({
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
      carId: currentCarId,
    }),
    [page, from, to, currentCarId],
  )

  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: ['trips', params],
    queryFn: () => api.trips(params),
    placeholderData: keepPreviousData,
  })

  const pageCount = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  const applyFilter = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom)
    setTo(nextTo)
    setPage(1)
  }

  return (
    <div>
      <PageHeader
        icon={Route}
        title={t('trips.title', '行程')}
        subtitle={data ? `${t('trips.subtitle.totalPrefix', '共')} ${data.total} ${t('trips.subtitle.totalSuffix', '条记录')}` : t('trips.subtitle.loading', '行车记录')}
      />

      {/* 日期筛选 */}
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
            className="btn-ghost !py-2 text-xs"
            onClick={() => applyFilter('', '')}
            data-testid="filter-clear"
          >
            {t('trips.filter.clear', '清除筛选')}
          </button>
        )}
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
      ) : !data || data.items.length === 0 ? (
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
            {data.items.map((trip) => (
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
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        </div>
      )}
    </div>
  )
}
