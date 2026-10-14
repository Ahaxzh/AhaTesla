import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  BatteryCharging,
  Car,
  Coins,
  Flame,
  Gauge,
  Route,
  TrendingDown,
} from 'lucide-react'
import { api } from '@/api/client'
import { BatteryRing } from '@/components/BatteryRing'
import { PageHeader } from '@/components/PageHeader'
import { SkeletonCards, SkeletonList } from '@/components/Skeletons'
import { StatCard } from '@/components/StatCard'
import { EmptyState } from '@/components/EmptyState'
import { fmtCny, fmtDateTime, fmtKm, fmtKwh } from '@/utils/format'
import type { Charge, Trip } from '@/types'

export default function DashboardPage() {
  const { data, isLoading } = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard })

  const month = data?.monthStats
  // 相比油车省下的钱 = 油车费用 - 电费
  const saved = month && data ? data.fuelComparison.fuelCostCny - month.costCny : 0
  const car = data?.car

  return (
    <div>
      <PageHeader icon={Gauge} title="总览" subtitle={car?.name ?? 'Tesla'} />

      {isLoading || !data ? (
        <div className="space-y-4">
          <div className="skeleton h-56 rounded-2xl" />
          <SkeletonCards />
          <SkeletonList rows={3} />
        </div>
      ) : (
        <div className="space-y-4">
          {/* 车辆状态卡 */}
          <section className="glass-card fade-up flex flex-col items-center gap-6 p-6 sm:flex-row sm:gap-10" data-testid="car-card">
            <BatteryRing percent={car!.currentBattery} label={`续航约 ${fmtKm(car!.rangeKm, 0)} km`} />
            <div className="w-full flex-1 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-slate-300">
                  <Car className="h-4 w-4 text-tesla" />
                  {car!.name}
                </div>
                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${car!.state === 'charging'
                      ? 'bg-emerald-400/10 text-emerald-400'
                      : car!.state === 'driving'
                        ? 'bg-sky-400/10 text-sky-400'
                        : car!.state === 'online'
                          ? 'bg-amber-400/10 text-amber-400'
                          : car!.state === 'offline'
                            ? 'bg-white/[0.04] text-slate-500'
                            : 'bg-white/[0.06] text-slate-400'
                  }`}
                >
                  {car!.state === 'charging'
                    ? `充电中${car!.charging?.powerKw ? ` · ${car!.charging.powerKw} kW` : ''}`
                    : car!.state === 'driving'
                      ? '行驶中'
                      : car!.state === 'online'
                        ? '在线'
                        : car!.state === 'offline'
                          ? '离线'
                          : car!.state === 'asleep'
                            ? '休眠'
                            : '已驻车'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-white/[0.04] px-3.5 py-3">
                  <div className="text-[11px] text-slate-500">总里程</div>
                  <div className="num mt-1 text-lg font-semibold text-white">{fmtKm(car!.odometerKm, 0)} km</div>
                </div>
                <div className="rounded-xl bg-white/[0.04] px-3.5 py-3">
                  <div className="text-[11px] text-slate-500">当前续航</div>
                  <div className="num mt-1 text-lg font-semibold text-white">{fmtKm(car!.rangeKm, 0)} km</div>
                </div>
              </div>
            </div>
          </section>

          {/* 本月统计 */}
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="month-stats">
            <StatCard icon={Route} label="本月里程" value={`${fmtKm(month!.distanceKm)} km`} hint={`${month!.driveCount} 趟 · ${month!.driveHours.toFixed(1)} 小时`} />
            <StatCard icon={BatteryCharging} label="本月能耗" value={fmtKwh(month!.energyKWh)} />
            <StatCard icon={Coins} label="本月电费" value={fmtCny(month!.costCny)} accent data-testid="stat-cost" />
            <StatCard
              icon={TrendingDown}
              label="相比油车"
              value={saved >= 0 ? `省 ${fmtCny(Math.abs(saved))}` : `多 ${fmtCny(Math.abs(saved))}`}
              hint={`油车约 ${fmtCny(data.fuelComparison.fuelCostCny)}`}
            />
          </section>

          {/* 最近行程 / 充电 */}
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="glass-card p-4" data-testid="recent-trips">
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="flex items-center gap-2 text-sm font-medium text-slate-200">
                  <Route className="h-4 w-4 text-tesla" /> 最近行程
                </h2>
                <Link to="/trips" className="flex items-center gap-1 text-xs text-slate-400 transition hover:text-tesla">
                  全部 <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
              {data.recentTrips.length === 0 ? (
                <EmptyState icon={Route} title="暂无行程数据" description="TeslaMate 记录到行程后会自动出现在这里" />
              ) : (
                <ul className="divide-y divide-white/[0.05]">
                  {data.recentTrips.map((t) => (
                    <RecentTripRow key={t.id} trip={t} />
                  ))}
                </ul>
              )}
            </section>

            <section className="glass-card p-4" data-testid="recent-charges">
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="flex items-center gap-2 text-sm font-medium text-slate-200">
                  <Flame className="h-4 w-4 text-tesla" /> 最近充电
                </h2>
                <Link to="/charging" className="flex items-center gap-1 text-xs text-slate-400 transition hover:text-tesla">
                  全部 <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
              {data.recentCharges.length === 0 ? (
                <EmptyState icon={BatteryCharging} title="暂无充电记录" />
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
  return (
    <li className="flex items-center gap-3 px-1 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-slate-200">{charge.locationName}</div>
        <div className="num mt-0.5 text-[11px] text-slate-500">
          {fmtDateTime(charge.startAt)} · {fmtKwh(charge.energyAddedKWh)} · {charge.startBattery}%→{charge.endBattery}%
        </div>
      </div>
      <div className="num text-sm font-medium text-slate-300">{fmtCny(charge.costCny)}</div>
    </li>
  )
}
