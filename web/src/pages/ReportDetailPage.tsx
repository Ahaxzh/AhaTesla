import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, BatteryCharging, CalendarRange, Coins, Gauge, Route as RouteIcon, TrendingDown, TrendingUp, Trophy } from 'lucide-react'
import { api } from '@/api/client'
import { StatCard } from '@/components/StatCard'
import { useI18n } from '@/i18n'
import { fmtMoney, fmtKm, fmtKwh } from '@/utils/format'
import type { ReportInsights } from '@/types'

/** 洞察小卡：null 字段直接不渲染（旧快照/无数据的维度自动缺位） */
function InsightChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 rounded-xl bg-white/[0.04] px-3 py-2">
      <span className="shrink-0 text-[11px] text-slate-400">{label}</span>
      <span className="num text-sm font-medium text-slate-200">{value}</span>
    </div>
  )
}

function InsightsSection({ insights }: { insights: ReportInsights }) {
  const { t } = useI18n()
  const chips: { label: string; value: string }[] = []
  if (insights.avgTempC != null) {
    chips.push({
      label: t('rep.ins.temp', '气温'),
      value: insights.tempRangeC ?? `${insights.avgTempC}°C`,
    })
  }
  if (insights.kwhPer100km != null) chips.push({ label: t('rep.ins.consumption', '百公里能耗'), value: `${insights.kwhPer100km} kWh` })
  if (insights.avgSpeedKmh != null) chips.push({ label: t('rep.ins.avgSpeed', '平均时速'), value: `${insights.avgSpeedKmh} km/h` })
  if (insights.maxSpeedKmh != null) chips.push({ label: t('rep.ins.maxSpeed', '最高时速'), value: `${insights.maxSpeedKmh} km/h` })
  if (insights.idlePct != null) chips.push({ label: t('rep.ins.idle', '怠速占比'), value: `${insights.idlePct}%` })
  if (insights.powerMaxKw != null) chips.push({ label: t('rep.ins.power', '最高充电功率'), value: `${insights.powerMaxKw} kW` })
  if (insights.tireFlBar != null || insights.tireRrBar != null) {
    chips.push({
      label: t('rep.ins.tires', '胎压 (FL/RR)'),
      value: `${insights.tireFlBar?.toFixed(1) ?? '--'} / ${insights.tireRrBar?.toFixed(1) ?? '--'} bar`,
    })
  }
  if (chips.length === 0) return null
  return (
    <section className="glass-card-flat mt-4 p-5" data-testid="report-insights">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-200">
        <Gauge className="h-4 w-4 text-tesla" /> {t('rep.ins.title', '驾驶洞察')}
      </h2>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {chips.map((c) => <InsightChip key={c.label} label={c.label} value={c.value} />)}
      </div>
      {insights.tireMinBar != null && (
        <p className="mt-2 text-[11px] text-slate-500">
          {t('rep.ins.tireMin', '期间最低胎压')} <span className="num">{insights.tireMinBar.toFixed(2)}</span> bar
        </p>
      )}
    </section>
  )
}

/** P5 报告详情（/reports/:id）：KPI 四宫格 + 驾驶洞察 + 环比/年度累计 + 主跑路线 TOP3 + 账本结语。
 *  v2.4：insights/ytd/compare/topRoutes 明细此前已在快照响应里但被类型丢弃，本次全量露出（旧快照缺字段 → 判空降级）。 */
export default function ReportDetailPage() {
  const { t } = useI18n()
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
  const titleKey = report.type === 'daily' ? 'rep.detail.title.daily'
    : report.type === 'weekly' ? 'rep.detail.title.weekly'
      : report.type === 'annual' ? 'rep.detail.title.annual'
        : 'rep.detail.title.monthly'

  return (
    <div>
      <div className="mb-5 flex items-center gap-3">
        <Link to="/reports" className="btn-ghost !px-3" aria-label={t('rep.detail.back', '返回报告列表')}>
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="page-title">
            {t(titleKey, report.type === 'daily' ? '日报' : report.type === 'weekly' ? '周报' : report.type === 'annual' ? '年报' : '月报')} · {report.periodLabel}
          </h1>
          {report.carName && <p className="mt-0.5 text-xs text-slate-400">{report.carName}</p>}
        </div>
      </div>

      {/* KPI 四宫格 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="report-kpi">
        <StatCard icon={RouteIcon} label={t('rep.detail.kpi.distance', '总里程')} value={`${fmtKm(kpi.distanceKm)} km`} hint={`${kpi.driveCount} ${t('dash.tripsUnit', '趟')}`} />
        <StatCard icon={BatteryCharging} label={t('rep.detail.kpi.charge', '总充电量')} value={fmtKwh(kpi.chargeKwh)} hint={fmtKwh(kpi.energyKwh)} />
        <StatCard icon={Coins} label={t('rep.detail.kpi.cost', '总电费')} value={fmtMoney(kpi.totalCost)} accent hint={kpi.costPerKm != null ? `${fmtMoney(kpi.costPerKm, 3)}/km` : undefined} />
        <StatCard
          icon={TrendingDown}
          label={t('rep.detail.kpi.saved', '较油车节省')}
          value={kpi.saved >= 0 ? fmtMoney(kpi.saved) : `${t('rep.detail.more', '多')} ${fmtMoney(-kpi.saved)}`}
          hint={kpi.savedPct != null ? `${kpi.savedPct}%` : undefined}
        />
      </div>

      {/* 日报：上周同日环比 + 本月累计 */}
      {report.compare && (
        <section className="glass-card-flat mt-4 p-5" data-testid="report-compare">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-200">
            <CalendarRange className="h-4 w-4 text-tesla" /> {t('rep.detail.compare.title', '对比')}
          </h2>
          <div className="num grid grid-cols-2 gap-2.5 text-sm sm:grid-cols-4">
            <div>
              <p className="text-[11px] text-slate-400">{t('rep.detail.compare.lastWeek', '上周同日')}</p>
              <p className="mt-0.5 text-slate-200">{fmtKm(report.compare.lastWeek.distanceKm, 0)} km · {fmtMoney(report.compare.lastWeek.totalCost)}</p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400">{t('rep.detail.compare.kmDelta', '里程环比')}</p>
              <p className={`mt-0.5 ${report.compare.kmDeltaPct == null ? 'text-slate-500' : report.compare.kmDeltaPct >= 0 ? 'text-emerald-400' : 'text-sky-400'}`}>
                {report.compare.kmDeltaPct == null ? '--' : `${report.compare.kmDeltaPct >= 0 ? '+' : ''}${report.compare.kmDeltaPct}%`}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400">{t('rep.detail.compare.monthKm', '本月累计')}</p>
              <p className="mt-0.5 text-slate-200">{fmtKm(report.compare.month.distanceKm, 0)} km</p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400">{t('rep.detail.compare.monthCost', '本月电费')}</p>
              <p className="mt-0.5 text-slate-200">{fmtMoney(report.compare.month.totalCost)}</p>
            </div>
          </div>
        </section>
      )}

      {/* 月报：年度至今累计 */}
      {report.ytd && (
        <section className="glass-card-flat mt-4 p-5" data-testid="report-ytd">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-200">
            <TrendingUp className="h-4 w-4 text-tesla" /> {t('rep.detail.ytd.title', '年度至今')}
          </h2>
          <p className="num text-sm text-slate-300">
            {fmtKm(report.ytd.distanceKm, 0)} km · {fmtMoney(report.ytd.totalCost)} ·{' '}
            {report.ytd.saved >= 0
              ? `${t('rep.detail.kpi.saved', '较油车节省')} ${fmtMoney(report.ytd.saved)}`
              : `${t('rep.detail.more', '多')} ${fmtMoney(-report.ytd.saved)}`}
          </p>
        </section>
      )}

      {/* 年报：年度之最（v2.5）——朋友圈年度账单的料 */}
      {report.annual && (
        <section className="glass-card-flat mt-4 p-5" data-testid="report-annual">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-200">
            <Trophy className="h-4 w-4 text-tesla" /> {t('rep.detail.annual.title', '年度之最')}
          </h2>
          <div className="num grid grid-cols-2 gap-2.5 text-sm sm:grid-cols-4">
            <div>
              <p className="text-[11px] text-slate-400">{t('rep.detail.annual.maxDay', '最长单日')}</p>
              <p className="mt-0.5 text-slate-200">{fmtKm(report.annual.maxDayKm, 0)} km</p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400">{t('rep.detail.annual.maxTrip', '最长单程')}</p>
              <p className="mt-0.5 text-slate-200">
                {report.annual.maxTripKm != null ? `${fmtKm(report.annual.maxTripKm, 0)} km` : '--'}
                {report.annual.maxTripRoute && <span className="ml-1 text-[11px] text-slate-500">{report.annual.maxTripRoute}</span>}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400">{t('rep.detail.annual.sessions', '充电次数')}</p>
              <p className="mt-0.5 text-slate-200">{report.annual.chargeSessions}</p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400">{t('rep.detail.annual.superPct', '超充占比')}</p>
              <p className="mt-0.5 text-slate-200">{report.annual.superPct != null ? `${report.annual.superPct}%` : '--'}</p>
            </div>
          </div>
        </section>
      )}

      {/* 驾驶洞察（server v2.2 起随快照返回） */}
      {report.insights && <InsightsSection insights={report.insights} />}

      {/* 主跑路线 TOP3（v2.4 补里程/电费明细） */}
      <section className="glass-card-flat mt-4 p-5" data-testid="report-routes">
        <h2 className="mb-3 text-sm font-medium text-slate-200">{t('rep.detail.routes.title', '主跑路线 TOP 3')}</h2>
        {report.topRoutes.length === 0 ? (
          <p className="py-3 text-center text-xs text-slate-500">{t('rep.detail.routes.empty', '本期无行程记录')}</p>
        ) : (
          <ol className="space-y-2.5">
            {report.topRoutes.map((r, i) => (
              <li key={r.route} className="flex items-center gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-tesla/[0.12] text-xs font-semibold text-tesla">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{r.route}</span>
                <span className="num shrink-0 text-xs text-slate-400">
                  {r.count} {t('rep.detail.routes.count', '次')}
                  {r.distanceKm != null && <span className="text-slate-500"> · {fmtKm(r.distanceKm, 0)} km</span>}
                  {r.costCny != null && <span className="text-slate-500"> · {fmtMoney(r.costCny)}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* 账本结语 */}
      <section className="glass-card-flat mt-4 p-5" data-testid="report-closing">
        <h2 className="mb-2 text-sm font-medium text-slate-200">{t('rep.detail.closing', '账本结语')}</h2>
        <p className="text-sm leading-6 text-slate-300">{report.closing}</p>
        <p className="mt-3 text-[11px] text-slate-400">{report.baselineNote}</p>
      </section>
    </div>
  )
}
