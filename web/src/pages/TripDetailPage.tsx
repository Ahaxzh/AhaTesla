import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ArrowLeft, Clock, Coins, MapPin, Route as RouteIcon, Zap } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { api } from '@/api/client'
import { RouteMap } from '@/components/RouteMap'
import { SkeletonCards } from '@/components/Skeletons'
import { StatCard } from '@/components/StatCard'
import { fmtCny, fmtDateTime, fmtDuration, fmtKm, fmtKwh } from '@/utils/format'

export default function TripDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: trip, isLoading } = useQuery({
    queryKey: ['trip', id],
    queryFn: () => api.trip(id!),
    enabled: !!id,
  })

  return (
    <div>
      <div className="mb-5 flex items-center gap-3">
        <Link to="/trips" className="btn-ghost !px-3" aria-label="返回行程列表">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="page-title">行程详情</h1>
          {trip && <p className="mt-0.5 text-xs text-slate-500">{fmtDateTime(trip.startAt)}</p>}
        </div>
      </div>

      {isLoading || !trip ? (
        <div className="space-y-4">
          <SkeletonCards count={4} />
          <div className="skeleton h-56 rounded-2xl" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon={RouteIcon} label="里程" value={`${fmtKm(trip.distanceKm)} km`} />
            <StatCard icon={Clock} label="时长" value={fmtDuration(trip.durationMin)} />
            <StatCard icon={Zap} label="能耗" value={fmtKwh(trip.energyKWh)} hint={`${fmtKm(trip.kwhPer100km)} kWh/100km`} />
            <StatCard icon={Coins} label="电费" value={fmtCny(trip.costCny)} accent data-testid="trip-cost" />
          </div>

          <RouteMap points={trip.route ?? []} />

          <div className="glass-card space-y-4 p-5" data-testid="trip-endpoints">
            <div className="flex gap-3">
              <span className="mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full border-2 border-emerald-400" aria-hidden />
              <div className="min-w-0">
                <div className="text-[11px] text-slate-500">起点 · {fmtDateTime(trip.startAt)}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-sm text-slate-200">
                  <MapPin className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <span className="break-all">{trip.startAddress || '未知位置'}</span>
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <span className="mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full border-2 border-tesla bg-tesla/40" aria-hidden />
              <div className="min-w-0">
                <div className="text-[11px] text-slate-500">终点 · {fmtDateTime(trip.endAt)}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-sm text-slate-200">
                  <MapPin className="h-3.5 w-3.5 shrink-0 text-tesla" />
                  <span className="break-all">{trip.endAddress || '未知位置'}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
