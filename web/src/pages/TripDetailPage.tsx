import { lazy, Suspense } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  CircleDot,
  Clock,
  Coins,
  Gauge as GaugeIcon,
  Layers,
  MapPin,
  Route as RouteIcon,
  Thermometer,
  Timer,
  TrendingDown,
  Wind,
  Zap,
} from 'lucide-react'
import { api } from '@/api/client'
// leaflet(轨迹图)二级懒加载:不阻塞行程详情首屏,轨迹区渲染时才拉 map chunk
const RouteMap = lazy(() => import('@/components/RouteMap').then((m) => ({ default: m.RouteMap })))
import { ElevationProfile } from '@/components/ElevationProfile'
import { EmptyState } from '@/components/EmptyState'
import { SkeletonCards } from '@/components/Skeletons'
import { StatCard } from '@/components/StatCard'
import { useI18n } from '@/i18n'
import { fmtCny, fmtDateTime, fmtDuration, fmtKm, fmtKwh, fmtPrice, getCurrencySymbol } from '@/utils/format'

/** 能效达成率标签（P3 模块1）：≥100% 绿 / <85% 橙 */
function EfficiencyBadge({ ratio }: { ratio: number | null | undefined }) {
  const { t } = useI18n()
  if (ratio == null) return null
  const pct = Math.round(ratio * 100)
  const good = ratio >= 1
  const warn = ratio < 0.85
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${
        good ? 'bg-emerald-400/10 text-emerald-400' : warn ? 'bg-amber-400/10 text-amber-400' : 'bg-white/[0.06] text-slate-300'
      }`}
      data-testid="efficiency-badge"
    >
      <Zap className="h-3 w-3" />
      {good
        ? t('tripDetail.eff.good', '超预期续航（{pct}%）').replace('{pct}', String(pct))
        : warn
          ? t('tripDetail.eff.warn', '激进驾驶/低温损耗（{pct}%）').replace('{pct}', String(pct))
          : t('tripDetail.eff.normal', '能效达成 {pct}%').replace('{pct}', String(pct))}
    </span>
  )
}

export default function TripDetailPage() {
  const { t } = useI18n()
  const { id } = useParams<{ id: string }>()
  const { data: trip, isLoading, isError, refetch } = useQuery({
    queryKey: ['trip', id],
    queryFn: () => api.trip(id!),
    enabled: !!id,
    retry: false,
  })

  return (
    <div>
      <div className="mb-5 flex items-center gap-3">
        <Link to="/trips" className="btn-ghost !px-3" aria-label={t('tripDetail.back', '返回行程列表')}>
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="page-title">{t('tripDetail.title', '行程详情')}</h1>
          {trip && <p className="mt-0.5 text-xs text-slate-400">{fmtDateTime(trip.startAt)}</p>}
        </div>
      </div>

      {isError ? (
        <div className="glass-card-flat" data-testid="trip-error">
          <EmptyState
            icon={AlertTriangle}
            title={t('tripDetail.error.title', '行程详情加载失败')}
            description={t('tripDetail.error.desc', '数据源暂时不可用，请稍后重试')}
            action={{ label: t('charging.modal.retry', '重试'), onClick: () => void refetch() }}
          />
        </div>
      ) : isLoading || !trip ? (
        <div className="space-y-4">
          <SkeletonCards count={4} />
          <div className="skeleton h-56 rounded-2xl" />
        </div>
      ) : (
        <div className="space-y-4">
          {/* 模块1：基础概览 + 能效达成率 */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon={RouteIcon} label={t('tripDetail.kpi.distance', '里程')} value={`${fmtKm(trip.distanceKm)} km`} />
            <StatCard icon={Clock} label={t('tripDetail.kpi.duration', '时长')} value={fmtDuration(trip.durationMin)} />
            <StatCard icon={Zap} label={t('tripDetail.kpi.energy', '能耗')} value={fmtKwh(trip.energyKWh)} hint={`${fmtKm(trip.kwhPer100km)} kWh/100km`} />
            <StatCard icon={Coins} label={t('tripDetail.kpi.cost', '电费')} value={fmtCny(trip.costCny)} accent data-testid="trip-cost" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <EfficiencyBadge ratio={trip.efficiency?.ratio} />
            {/* 口径标注（AC-6.3） */}
            <span className="text-[11px] text-slate-400" data-testid="energy-formula-note">
              {t('tripDetail.energyNote', '耗电口径：基于起止表显续航差 × 车辆效率系数')}
            </span>
          </div>

          {/* 模块2：路线轨迹（速度着色 + 悬停速度提示） */}
          <Suspense fallback={<div className="skeleton h-72 w-full rounded-xl" data-testid="route-map-fallback" />}>
            <RouteMap points={trip.route ?? []} />
          </Suspense>
          <div className="mt-3">
            <ElevationProfile points={trip.route ?? []} />
          </div>

          {/* 模块3：环境剖析微卡片（6 卡 = 移动 2×3 / 桌面 3×2，栅格不落单） */}
          {trip.environment && (
            <section className="grid grid-cols-2 gap-3 lg:grid-cols-3" data-testid="environment-card">
              <div className="glass-card-flat flex items-center gap-3 p-4">
                <Thermometer className="h-4 w-4 shrink-0 text-tesla" />
                <div>
                  <div className="text-xs text-slate-400">{t('tripDetail.env.avgTemp', '平均室外温度')}</div>
                  <div className="num mt-0.5 text-sm text-slate-200">{trip.environment.avgTempC != null ? `${trip.environment.avgTempC.toFixed(1)}°C` : '--'}</div>
                </div>
              </div>
              <div className="glass-card-flat flex items-center gap-3 p-4">
                <Wind className="h-4 w-4 shrink-0 text-tesla" />
                <div>
                  <div className="text-xs text-slate-400">{t('tripDetail.env.ac', '空调耗电估算')}</div>
                  <div className="num mt-0.5 text-sm text-slate-200">{trip.environment.acEstimateKwh != null ? fmtKwh(trip.environment.acEstimateKwh) : '--'}</div>
                </div>
              </div>
              <div className="glass-card-flat flex items-center gap-3 p-4">
                <GaugeIcon className="h-4 w-4 shrink-0 text-tesla" />
                <div>
                  <div className="text-xs text-slate-400">{t('tripDetail.env.speed', '均速 / 最高')}</div>
                  <div className="num mt-0.5 text-sm text-slate-200">
                    {trip.environment.avgSpeedKmh?.toFixed(0) ?? '--'} / {trip.environment.maxSpeedKmh?.toFixed(0) ?? '--'} km/h
                  </div>
                </div>
              </div>
              {trip.tirePressure ? (
                <div className="glass-card-flat flex items-center gap-3 p-4" data-testid="trip-tire-pressure">
                  <CircleDot className="h-4 w-4 shrink-0 text-tesla" />
                  <div>
                    <div className="text-xs text-slate-400">{t('tripDetail.env.tire', '胎压（行程末）')}</div>
                    {/* 主值=四轮最低（<2.6 bar 变红，对齐推送告警阈值）；副行四轮缩写明细（语言中立） */}
                    <div className={`num mt-0.5 text-sm ${Math.min(trip.tirePressure.fl, trip.tirePressure.fr, trip.tirePressure.rl, trip.tirePressure.rr) < 2.6 ? 'text-tesla' : 'text-slate-200'}`}>
                      {t('tripDetail.env.tireMin', '最低')} {Math.min(trip.tirePressure.fl, trip.tirePressure.fr, trip.tirePressure.rl, trip.tirePressure.rr).toFixed(1)} bar
                      <span className="ml-2 text-[11px] font-normal text-slate-400">
                        FL {trip.tirePressure.fl.toFixed(1)}/{trip.tirePressure.fr.toFixed(1)} · RL {trip.tirePressure.rl.toFixed(1)}/{trip.tirePressure.rr.toFixed(1)}
                      </span>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="glass-card-flat flex items-center gap-3 p-4" data-testid="trip-gps-count">
                <Layers className="h-4 w-4 shrink-0 text-tesla" />
                <div>
                  <div className="text-xs text-slate-400">{t('tripDetail.env.gps', 'GPS 采样点')}</div>
                  <div className="num mt-0.5 text-sm text-slate-200">{trip.positionCount ?? trip.route?.length ?? 0}</div>
                </div>
              </div>
              {/* 采样间隔 = 时长 ÷ 原始点数（route 是 LTTB 抽稀后的 ≤300 点，不能用）；数据齐才渲染，与 GPS 卡凑成一对 */}
              {trip.positionCount != null && trip.positionCount > 0 && (
                <div className="glass-card-flat flex items-center gap-3 p-4" data-testid="trip-sample-interval">
                  <Timer className="h-4 w-4 shrink-0 text-tesla" />
                  <div>
                    <div className="text-xs text-slate-400">{t('tripDetail.env.sampleInterval', '平均采样间隔')}</div>
                    <div className="num mt-0.5 text-sm text-slate-200">
                      {t('tripDetail.env.approxPrefix', '≈')} {Math.max(1, Math.round((trip.durationMin * 60) / trip.positionCount))} s/{t('tripDetail.env.perPoint', '点')}
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* 模块4：FIFO 电费分摊明细（核心价值卡） */}
          {trip.fifo && (
            <section className="glass-card-flat p-5" data-testid="fifo-card">
              <h2 className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
                <Coins className="h-4 w-4 text-tesla" /> {t('tripDetail.fifo.title', 'FIFO 电费分摊明细')}
              </h2>
              <p className="mb-4 text-[11px] text-slate-500">
                {t('tripDetail.fifo.desc', '批次单价已含充电损耗折算（实付总额 ÷ 电池净吸收电量）；总耗电量基于电池包净释放能量')}
              </p>

              {trip.fifo.batches.length === 0 ? (
                <p className="py-3 text-center text-xs text-slate-500">{t('tripDetail.fifo.empty', '无可分摊批次')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/[0.06] text-left text-[11px] text-slate-500">
                        <th className="py-2 pr-3 font-medium">{t('tripDetail.fifo.batch', '批次（充电来源）')}</th>
                        <th className="py-2 px-3 text-right font-medium">{t('tripDetail.fifo.kwh', '电量 kWh')}</th>
                        <th className="py-2 px-3 text-right font-medium">{t('tripDetail.fifo.price', '单价')}</th>
                        <th className="py-2 pl-3 text-right font-medium">{t('tripDetail.fifo.amount', '金额')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04]" data-testid="fifo-batch-rows">
                      {trip.fifo.batches.map((b, i) => (
                        <tr key={i}>
                          <td className="max-w-[220px] truncate py-2.5 pr-3 text-slate-200">{b.source}</td>
                          <td className="num py-2.5 px-3 text-right text-slate-300">{b.kwh.toFixed(1)}</td>
                          <td className="num py-2.5 px-3 text-right text-slate-300">{getCurrencySymbol()}{fmtPrice(b.price)}</td>
                          <td className="num py-2.5 pl-3 text-right font-medium text-white">{fmtCny(b.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {trip.fifo.blendedPrice != null && (
                <div className="num mt-3 flex items-center justify-between border-t border-white/[0.06] pt-3 text-sm">
                  <span className="text-slate-400">
                    {t('tripDetail.fifo.total', '本次总电费')} <span className="ml-1 text-base font-semibold text-tesla">{fmtCny(trip.fifo.totalCost)}</span>
                  </span>
                  <span className="text-slate-500">{t('tripDetail.fifo.blended', '综合单价 ¥{v}/kWh').replace('{v}', fmtPrice(trip.fifo.blendedPrice))}</span>
                </div>
              )}
              {trip.fifo.exhaustedNote && (
                <div className="mt-3 rounded-lg bg-amber-400/10 px-3 py-2 text-[11px] text-amber-400" data-testid="fifo-exhausted">
                  {trip.fifo.exhaustedNote}
                </div>
              )}

              {/* 油车对比栏 */}
              {trip.fuelComparison && trip.fuelComparison.saved != null && (
                <div className="mt-4 rounded-xl bg-white/[0.03] p-4" data-testid="fuel-compare">
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-1.5 text-slate-300">
                      <TrendingDown className="h-4 w-4 text-emerald-400" />
                      {t('tripDetail.fuel.title', '油车对比')}
                    </span>
                    <span className="num font-medium text-emerald-400">
                      {t('tripDetail.fuel.saved', '净节省')} {fmtCny(trip.fuelComparison.saved)}
                      {trip.fuelComparison.savedPct != null && `（↓${trip.fuelComparison.savedPct}%）`}
                    </span>
                  </div>
                  <p className="num mt-2 text-[11px] text-slate-500">
                    {trip.fuelComparison.baseline} → {t('tripDetail.fuel.cost', '对比油费')} {fmtCny(trip.fuelComparison.fuelCost)}
                  </p>
                </div>
              )}
            </section>
          )}

          {/* 起终点 */}
          <div className="glass-card-flat space-y-4 p-5" data-testid="trip-endpoints">
            <div className="flex gap-3">
              <span className="mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full border-2 border-emerald-400" aria-hidden />
              <div className="min-w-0">
                <div className="text-[11px] text-slate-400">{t('tripDetail.start', '起点')} · {fmtDateTime(trip.startAt)}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-sm text-slate-200">
                  <MapPin className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <span className="break-all">{trip.startAddress || t('tripDetail.unnamedStart', '起点（未命名位置）')}</span>
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <span className="mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full border-2 border-tesla bg-tesla/40" aria-hidden />
              <div className="min-w-0">
                <div className="text-[11px] text-slate-400">{t('tripDetail.end', '终点')} · {fmtDateTime(trip.endAt)}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-sm text-slate-200">
                  <MapPin className="h-3.5 w-3.5 shrink-0 text-tesla" />
                  <span className="break-all">{trip.endAddress || t('tripDetail.unnamedEnd', '终点（未命名位置）')}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
