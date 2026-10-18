import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ChevronRight, Route } from 'lucide-react'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { Pagination } from '@/components/Pagination'
import { EmptyState } from '@/components/EmptyState'
import { SkeletonList } from '@/components/Skeletons'
import { fmtCny, fmtDateTime, fmtDuration, fmtKm, fmtKwh, toInputDate } from '@/utils/format'

const PAGE_SIZE = 20

export default function TripsPage() {
  const [page, setPage] = useState(1)
  const today = useMemo(() => new Date(), [])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const params = useMemo(
    () => ({
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
    }),
    [page, from, to],
  )

  const { data, isLoading, isFetching } = useQuery({
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
      <PageHeader icon={Route} title="行程" subtitle={data ? `共 ${data.total} 条记录` : '行车记录'} />

      {/* 日期筛选 */}
      <div className="glass-card-flat mb-4 flex flex-wrap items-end gap-3 p-4" data-testid="trip-filter">
        <div>
          <label htmlFor="filter-from" className="mb-1 block text-[11px] text-slate-400">开始日期</label>
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
          <label htmlFor="filter-to" className="mb-1 block text-[11px] text-slate-400">结束日期</label>
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
            清除筛选
          </button>
        )}
      </div>

      {isLoading ? (
        <SkeletonList rows={6} />
      ) : !data || data.items.length === 0 ? (
        <div className="glass-card-flat">
          <EmptyState
            icon={Route}
            title="没有符合条件的行程"
            description="调整日期范围，或等 TeslaMate 记录到新行程后刷新"
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
