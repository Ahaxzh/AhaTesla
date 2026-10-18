import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, BatteryCharging, Coins, Route as RouteIcon, TrendingDown } from 'lucide-react'
import { api } from '@/api/client'
import { StatCard } from '@/components/StatCard'
import { fmtCny, fmtKm, fmtKwh } from '@/utils/format'

/** P5 报告详情（/reports/:id）：KPI 四宫格 + 主跑路线 TOP3 + 账本结语 */
export default function ReportDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: report, isLoading } = useQuery({
    queryKey: ['report', id],
    queryFn: () => api.reportDetail(id!),
    enabled: !!id,
  })

  if (isLoading || !report) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-10 w-48 rounded-xl" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton h-24 rounded-2xl" />
          ))}
        </div>
        <div className="skeleton h-40 rounded-2xl" />
      </div>
    )
  }

  const kpi = report.kpi

  return (
    <div>
      <div className="mb-5 flex items-center gap-3">
        <Link to="/reports" className="btn-ghost !px-3" aria-label="返回报告列表">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="page-title">
            {report.type === 'weekly' ? '周报' : '月报'} · {report.periodLabel}
          </h1>
          {report.carName && <p className="mt-0.5 text-xs text-slate-400">{report.carName}</p>}
        </div>
      </div>

      {/* KPI 四宫格 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="report-kpi">
        <StatCard icon={RouteIcon} label="总里程" value={`${fmtKm(kpi.distanceKm)} km`} hint={`${kpi.driveCount} 趟`} />
        <StatCard icon={BatteryCharging} label="总充电量" value={fmtKwh(kpi.chargeKwh)} hint={`能耗 ${fmtKwh(kpi.energyKwh)}`} />
        <StatCard icon={Coins} label="总电费" value={fmtCny(kpi.totalCost)} accent hint={kpi.costPerKm != null ? `¥${kpi.costPerKm.toFixed(3)}/km` : undefined} />
        <StatCard
          icon={TrendingDown}
          label="较油车节省"
          value={kpi.saved >= 0 ? fmtCny(kpi.saved) : `多 ${fmtCny(-kpi.saved)}`}
          hint={kpi.savedPct != null ? `${kpi.savedPct}%` : undefined}
        />
      </div>

      {/* 主跑路线 TOP3 */}
      <section className="glass-card-flat mt-4 p-5" data-testid="report-routes">
        <h2 className="mb-3 text-sm font-medium text-slate-200">主跑路线 TOP 3</h2>
        {report.topRoutes.length === 0 ? (
          <p className="py-3 text-center text-xs text-slate-500">本期无行程记录</p>
        ) : (
          <ol className="space-y-2.5">
            {report.topRoutes.map((r, i) => (
              <li key={r.route} className="flex items-center gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-tesla/[0.12] text-xs font-semibold text-tesla">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{r.route}</span>
                <span className="num shrink-0 text-xs text-slate-400">{r.count} 次</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* 账本结语 */}
      <section className="glass-card-flat mt-4 p-5" data-testid="report-closing">
        <h2 className="mb-2 text-sm font-medium text-slate-200">账本结语</h2>
        <p className="text-sm leading-6 text-slate-300">{report.closing}</p>
        <p className="mt-3 text-[11px] text-slate-400">{report.baselineNote}</p>
      </section>
    </div>
  )
}
