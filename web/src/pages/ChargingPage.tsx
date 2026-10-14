import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { BatteryCharging, Coins, MapPin, Zap } from 'lucide-react'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { Pagination } from '@/components/Pagination'
import { EmptyState } from '@/components/EmptyState'
import { SkeletonList } from '@/components/Skeletons'
import { StatCard } from '@/components/StatCard'
import { fmtCny, fmtDateTime, fmtDuration, fmtKwh } from '@/utils/format'

const PAGE_SIZE = 20

export default function ChargingPage() {
  const [page, setPage] = useState(1)
  const listParams = { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }

  const { data, isLoading } = useQuery({
    queryKey: ['charging', listParams],
    queryFn: () => api.charging(listParams),
    placeholderData: keepPreviousData,
  })
  const { data: stats } = useQuery({
    queryKey: ['charging-stats'],
    queryFn: () => api.chargingStats('month'),
  })

  const pageCount = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  const byLocation = stats?.byLocation ?? []
  const maxKwh = Math.max(...byLocation.map((l) => l.kwh), 1)

  return (
    <div>
      <PageHeader icon={BatteryCharging} title="充电" subtitle="本月充电统计与记录" />

      {stats && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
          <StatCard icon={Zap} label="本月充电量" value={fmtKwh(stats.totalKWh)} />
          <StatCard icon={Coins} label="本月电费" value={fmtCny(stats.totalCostCny)} accent data-testid="charge-total-cost" />
          <StatCard icon={BatteryCharging} label="平均单价" value={`¥${stats.avgPricePerKWh.toFixed(2)}/kWh`} />
        </div>
      )}

      {/* 按地点统计条形图（纯 CSS） */}
      <section className="glass-card mb-4 p-5" data-testid="location-chart">
        <h2 className="mb-4 text-sm font-medium text-slate-200">按地点统计（本月）</h2>
        {byLocation.length === 0 ? (
          <EmptyState icon={MapPin} title="暂无地点数据" description="充电后按地点聚合的统计会显示在这里" />
        ) : (
          <div className="space-y-3.5">
            {byLocation.map((loc) => (
              <div key={loc.name} data-testid="location-bar">
                <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                  <span className="truncate font-medium text-slate-200">{loc.name}</span>
                  <span className="num shrink-0 text-slate-400">
                    {fmtKwh(loc.kwh)} · ¥{loc.pricePerUnit.toFixed(2)}/kWh · {loc.count} 次
                  </span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-white/[0.05]" role="presentation">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max((loc.kwh / maxKwh) * 100, 2)}%`,
                      background: 'linear-gradient(90deg, #FF4A50, #C21822)',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 充电列表 */}
      {isLoading ? (
        <SkeletonList rows={6} />
      ) : !data || data.items.length === 0 ? (
        <div className="glass-card">
          <EmptyState icon={BatteryCharging} title="暂无充电记录" description="TeslaMate 记录到充电会话后会自动同步" />
        </div>
      ) : (
        <div>
          <ul className="space-y-2.5" data-testid="charge-list">
            {data.items.map((c) => (
              <li key={c.id} className="glass-card p-4" data-testid="charge-item">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-slate-100">
                    <MapPin className="h-4 w-4 shrink-0 text-tesla" />
                    <span className="truncate">{c.locationName}</span>
                  </div>
                  <div className="num shrink-0 text-sm font-semibold text-tesla">{fmtCny(c.costCny)}</div>
                </div>
                <div className="num mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
                  <span>{fmtDateTime(c.startAt)}</span>
                  <span>{fmtDuration(c.durationMin)}</span>
                  <span>{fmtKwh(c.energyAddedKWh)}</span>
                  <span>¥{c.pricePerUnit.toFixed(2)}/kWh</span>
                  <span>峰值 {c.powerMaxKw.toFixed(1)} kW</span>
                </div>
                {/* 电量变化条 */}
                <div className="mt-2.5 flex items-center gap-2">
                  <span className="num text-[11px] text-slate-500">{c.startBattery}%</span>
                  <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="absolute inset-y-0 rounded-full bg-gradient-to-r from-sky-500/60 to-emerald-400/80"
                      style={{
                        left: `${c.startBattery}%`,
                        width: `${Math.max(c.endBattery - c.startBattery, 1)}%`,
                      }}
                    />
                  </div>
                  <span className="num text-[11px] text-slate-300">{c.endBattery}%</span>
                </div>
              </li>
            ))}
          </ul>
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        </div>
      )}
    </div>
  )
}
