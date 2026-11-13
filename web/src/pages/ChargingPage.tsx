import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, BatteryCharging, Coins, MapPin, Pencil, Repeat, X, Zap } from 'lucide-react'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { BatteryHealthCard } from '@/components/BatteryHealthCard'
import { EmptyState } from '@/components/EmptyState'
import { SkeletonList } from '@/components/Skeletons'
import { StatCard } from '@/components/StatCard'
import { useToast } from '@/components/Toast'
import { useI18n } from '@/i18n'
import { useCar } from '@/contexts/CarContext'
import { fmtCny, fmtDateTime, fmtDuration, fmtKwh, fmtPrice, getCurrencySymbol, toInputDate } from '@/utils/format'
import type { ChargeDetail } from '@/types'

const PAGE_SIZE = 20
/** 默认筛选窗口（v0.3 与行程页统一）：近 90 天 */
const DEFAULT_WINDOW_DAYS = 90

/** 费用来源三态标记（P4 视图A）— labelKey/labelZh 由调用点 t() 双语 */
const COST_SOURCE_TAG = {
  manual: { labelKey: 'charging.tag.manual', labelZh: '已录入', cls: 'bg-emerald-400/15 text-emerald-400 border border-emerald-400/30' },
  geofence: { labelKey: 'charging.tag.geofence', labelZh: '规则计价', cls: 'bg-sky-400/10 text-sky-400 border border-sky-400/25' },
  default: { labelKey: 'charging.tag.default', labelZh: '默认估算', cls: 'bg-white/[0.05] text-slate-400 border border-white/[0.08]' },
  unknown: { labelKey: 'charging.tag.unknown', labelZh: '未计价', cls: 'bg-white/[0.05] text-slate-400 border border-white/[0.08]' },
} as const

/** 功率曲线（SVG，SoC 横轴 × kW 纵轴，峰值打点） */
function PowerCurve({ detail }: { detail: ChargeDetail }) {
  const { t } = useI18n()
  const pts = detail.powerCurve
  if (pts.length < 2) {
    return <p className="py-6 text-center text-xs text-slate-500">{t('charging.modal.noCurve', '该会话无功率采样数据')}</p>
  }
  const W = 560
  const H = 180
  const PAD = 30
  const socs = pts.map((p) => p.soc)
  const kws = pts.map((p) => p.kw)
  const minSoc = Math.min(...socs)
  const maxSoc = Math.max(...socs)
  const maxKw = Math.max(...kws, 1)
  const x = (soc: number) => PAD + ((soc - minSoc) / (maxSoc - minSoc || 1)) * (W - PAD * 2)
  const y = (kw: number) => H - PAD - (kw / maxKw) * (H - PAD * 2)
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.soc).toFixed(1)},${y(p.kw).toFixed(1)}`).join(' ')
  const peakX = detail.maxKwSoc != null ? x(detail.maxKwSoc) : null
  const peakY = detail.maxKw != null ? y(detail.maxKw) : null

  return (
    <div data-testid="power-curve" className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[420px]" role="img" aria-label={t('charging.modal.curve', '充电功率曲线')}>
        {/* 网格 */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={PAD} x2={W - PAD} y1={PAD + f * (H - PAD * 2)} y2={PAD + f * (H - PAD * 2)} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
        ))}
        <path d={path} fill="none" stroke="#34d399" strokeWidth="2" strokeLinejoin="round" />
        {peakX != null && peakY != null && (
          <>
            <circle cx={peakX} cy={peakY} r="4" fill="#f59e0b" />
            <text x={peakX} y={peakY - 9} textAnchor="middle" fontSize="14" fontWeight="600" fill="#f59e0b">
              {detail.maxKw}kW @ {detail.maxKwSoc}%
            </text>
          </>
        )}
        <text x={PAD} y={H - 8} fontSize="13" fill="#94a3b8">{minSoc}% SoC</text>
        <text x={W - PAD} y={H - 8} fontSize="13" fill="#94a3b8" textAnchor="end">{maxSoc}% SoC</text>
        <text x={4} y={PAD + 4} fontSize="13" fill="#94a3b8">{maxKw}kW</text>
      </svg>
    </div>
  )
}

export default function ChargingPage() {
  const { t } = useI18n()
  const today = useMemo(() => new Date(), [])
  const defaultFrom = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - DEFAULT_WINDOW_DAYS)
    return toInputDate(d)
  }, [])
  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState('')
  const [detailId, setDetailId] = useState<number | null>(null)
  const [costInput, setCostInput] = useState('')
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const { currentCarId } = useCar()
  const rangeParams = useMemo(
    () => ({
      from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
      carId: currentCarId,
    }),
    [from, to, currentCarId],
  )

  // 无限滚动（v0.3 与行程页统一交互；替代底部页码）
  const {
    data, isLoading, isFetching, isError, refetch, fetchNextPage, hasNextPage,
  } = useInfiniteQuery({
    queryKey: ['charging', rangeParams],
    queryFn: ({ pageParam }) => api.charging({ limit: PAGE_SIZE, offset: pageParam, ...rangeParams }),
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
      { rootMargin: '400px 0px' },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasNextPage, isFetching, fetchNextPage])

  const { data: stats } = useQuery({
    queryKey: ['charging-stats', rangeParams],
    queryFn: () => api.chargingStats(rangeParams),
  })
  const { data: detail, isError: detailError, refetch: refetchDetail } = useQuery({
    queryKey: ['charging-detail', detailId],
    queryFn: () => api.chargingDetail(detailId!),
    enabled: detailId != null,
    retry: false,
  })

  const saveCost = useMutation({
    mutationFn: () => api.putChargeCost(detailId!, Number(costInput)),
    onSuccess: () => {
      toast(t('charging.toast.saved', '实付电费已录入，账本将在后台重算'), 'success')
      setCostInput('')
      void queryClient.invalidateQueries({ queryKey: ['charging'] })
      void queryClient.invalidateQueries({ queryKey: ['charging-stats'] })
      void queryClient.invalidateQueries({ queryKey: ['charging-detail', detailId] })
      // 补录影响全站账本口径（本月电费/行程卡片/仪表盘）
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      void queryClient.invalidateQueries({ queryKey: ['ledger-summary'] })
      void queryClient.invalidateQueries({ queryKey: ['trips'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  // 弹窗键盘交互：Escape 关闭
  useEffect(() => {
    if (detailId == null) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDetailId(null)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [detailId])

  const byLocation = stats?.byLocation ?? []
  const maxKwh = Math.max(...byLocation.map((l) => l.kwh), 1)

  return (
    <div>
      <PageHeader icon={BatteryCharging} title={t('charging.title', '充电')} subtitle={t('charging.subtitle', '充电账本与站点统计')} />

      {/* 日期区间筛选（v0.3：与行程页统一；默认近 90 天，清除=全部） */}
      <div className="glass-card-flat mb-4 flex flex-wrap items-end gap-3 p-4" data-testid="charge-filter">
        <div>
          <label htmlFor="charge-from" className="mb-1 block text-[11px] text-slate-400">{t('charging.filterFrom', '开始日期')}</label>
          <input
            id="charge-from"
            type="date"
            className="input-dark !w-auto"
            value={from}
            max={to || toInputDate(today)}
            onChange={(e) => setFrom(e.target.value)}
            data-testid="charge-from"
          />
        </div>
        <div>
          <label htmlFor="charge-to" className="mb-1 block text-[11px] text-slate-400">{t('charging.filterTo', '结束日期')}</label>
          <input
            id="charge-to"
            type="date"
            className="input-dark !w-auto"
            value={to}
            min={from || undefined}
            max={toInputDate(today)}
            onChange={(e) => setTo(e.target.value)}
            data-testid="charge-to"
          />
        </div>
        {(from || to) && (
          <button
            className="btn-ghost !px-2.5 !py-2"
            onClick={() => { setFrom(''); setTo('') }}
            aria-label={t('charging.clear', '清除')}
            title={t('charging.clear', '清除')}
            data-testid="charge-filter-clear"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="charge-stats">
        {stats ? (
          <>
            <StatCard icon={Zap} label={t('charging.stat.kwh', '本月充电量')} value={fmtKwh(stats.totalKWh)} />
            <StatCard icon={Coins} label={t('charging.stat.cost', '本月电费')} value={fmtCny(stats.totalCostCny)} accent data-testid="charge-total-cost" />
            <StatCard icon={BatteryCharging} label={t('charging.stat.price', '平均单价')} value={`${getCurrencySymbol()}${fmtPrice(stats.avgPricePerKWh)}/kWh`} />
            {/* 会话数（server stats.sessionCount；月份筛选联动） */}
            <StatCard
              icon={Repeat}
              label={t('charging.stat.sessions', '充电次数')}
              value={`${stats.sessionCount ?? byLocation.reduce((s, l) => s + l.count, 0)} ${t('charging.chart.countUnit', '次')}`}
            />
          </>
        ) : (
          <div className="glass-card-flat col-span-2 space-y-3 p-4 sm:col-span-4">
            <div className="skeleton h-3 w-1/4" />
            <div className="skeleton h-6 w-2/5" />
          </div>
        )}
      </div>

      {/* 电池健康（v0.3 调换：充电页放完整大卡——电池语境；首页为紧凑可展开行） */}
      <div className="mb-4">
        <BatteryHealthCard />
      </div>

      {/* 成本构成三分 + 免费充电 + 月度趋势（Grafana charging-costs-stats 提炼） */}
      {stats && stats.byType && (stats.byType.ac.count + stats.byType.super.count + stats.byType.dc.count) > 0 && (
        <section className="glass-card-flat mb-4 p-5" data-testid="cost-composition">
          <h2 className="mb-3 text-sm font-medium text-slate-200">{t('charging.composition.title', '充电成本构成')}</h2>
          <div className="grid grid-cols-3 gap-3 text-center">
            {([
              { key: 'ac', label: t('charging.composition.ac', '家充/交流'), cls: 'from-emerald-500/25 to-emerald-400/70' },
              { key: 'super', label: t('charging.composition.super', '特斯拉超充'), cls: 'from-tesla/25 to-tesla/70' },
              { key: 'dc', label: t('charging.composition.dc', '其他快充'), cls: 'from-sky-500/25 to-sky-400/70' },
            ] as const).map(({ key, label, cls }) => {
              const g = stats.byType[key]
              return (
                <div key={key} data-testid={`cost-type-${key}`}>
                  <div className="text-[11px] text-slate-400">{label}</div>
                  <div className="num mt-1 text-lg font-semibold text-slate-100">{fmtCny(g.cost)}</div>
                  <div className="num mt-0.5 text-[11px] text-slate-500">{fmtKwh(g.kwh)} · {g.count} {t('charging.chart.countUnit', '次')}</div>
                  <div className={`mt-2 h-1.5 rounded-full bg-gradient-to-r ${cls}`} style={{ width: '100%', opacity: 0.8 }} role="presentation" />
                </div>
              )
            })}
          </div>
          {stats.freeKwh > 0.5 && (
            <div className="mt-3 text-[11px] text-emerald-400" data-testid="free-charged">
              🎁 {t('charging.composition.free', '免费充电')} {stats.freeKwh.toFixed(1)} kWh
            </div>
          )}
          {stats.monthly.length >= 2 && (
            <div className="mt-4">
              <div className="mb-2 text-[11px] text-slate-500">{t('charging.composition.monthly', '月度电费趋势')}</div>
              <div className="flex h-16 items-end gap-1" data-testid="monthly-cost-chart">
                {stats.monthly.map((m) => {
                  const max = Math.max(...stats.monthly.map((x) => x.cost), 1)
                  return (
                    <div
                      key={m.month}
                      className="flex-1 rounded-t bg-gradient-to-t from-tesla/20 to-tesla/60"
                      style={{ height: `${Math.max((m.cost / max) * 100, 4)}%` }}
                      title={`${m.month} · ${fmtCny(m.cost)} · ${m.kwh} kWh`}
                    />
                  )
                })}
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-slate-600 num">
                <span>{stats.monthly[0].month}</span>
                <span>{stats.monthly[stats.monthly.length - 1].month}</span>
              </div>
            </div>
          )}
        </section>
      )}

      {/* 按地点统计条形图（纯 CSS） */}
      <section className="glass-card-flat mb-4 p-5" data-testid="location-chart">
        <h2 className="mb-4 text-sm font-medium text-slate-200">{t('charging.chart.title', '按地点统计（本月）')}</h2>
        {byLocation.length === 0 ? (
          <EmptyState icon={MapPin} title={t('charging.chart.empty.title', '暂无地点数据')} description={t('charging.chart.empty.desc', '充电后按地点聚合的统计会显示在这里')} />
        ) : (
          <div className="space-y-3.5">
            {byLocation.map((loc) => (
              <div key={loc.name} data-testid="location-bar">
                <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                  <span className="truncate font-medium text-slate-200">{loc.name}</span>
                  <span className="num shrink-0 text-slate-400">
                    {fmtKwh(loc.kwh)} · {getCurrencySymbol()}{fmtPrice(loc.pricePerUnit)}/kWh · {loc.count} {t('charging.chart.countUnit', '次')}
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
      ) : isError ? (
        <div className="glass-card-flat">
          <EmptyState
            icon={BatteryCharging}
            title={t('common.loadError.title', '加载失败')}
            description={t('common.loadError.desc', '数据源连接异常，数据不会丢失')}
            action={{ label: t('common.retry', '重试'), onClick: () => void refetch() }}
          />
        </div>
      ) : items.length === 0 ? (
        <div className="glass-card-flat">
          <EmptyState icon={BatteryCharging} title={t('charging.list.empty.title', '暂无充电记录')} description={t('charging.list.empty.desc', 'TeslaMate 记录到充电会话后会自动同步')} />
        </div>
      ) : (
        <div className={isFetching ? 'opacity-60 transition' : 'transition'}>
          <ul className="space-y-2.5" data-testid="charge-list">
            {items.map((c) => {
              const tag = COST_SOURCE_TAG[c.costSource ?? 'unknown']
              return (
                <li key={c.id} className="glass-card-flat p-4" data-testid="charge-item">
                  <div className="flex items-center justify-between gap-3">
                    <button
                      className="flex min-w-0 items-center gap-2 rounded-lg py-1.5 text-left text-sm font-medium text-slate-100 transition hover:text-tesla"
                      onClick={() => { setDetailId(c.id); setCostInput('') }}
                      data-testid={`charge-detail-open-${c.id}`}
                    >
                      <MapPin className="h-4 w-4 shrink-0 text-tesla" />
                      <span className="min-w-0 truncate">{c.locationName}</span>
                    </button>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] ${tag.cls}`} data-testid={`cost-source-${c.id}`}>
                        {t(tag.labelKey, tag.labelZh)}
                      </span>
                      <span className="num text-sm font-semibold text-tesla">{fmtCny(c.costCny)}</span>
                    </div>
                  </div>
                  <div className="num mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
                    <span>{fmtDateTime(c.startAt)}</span>
                    <span>{fmtDuration(c.durationMin)}</span>
                    <span>{fmtKwh(c.energyAddedKWh)}</span>
                    <span>{getCurrencySymbol()}{fmtPrice(c.pricePerUnit)}/kWh</span>
                    {c.powerMaxKw != null && (
                      <span>{t('charging.peakPrefix', '峰值')} {c.powerMaxKw.toFixed(1)} kW</span>
                    )}
                  </div>
                  {c.startBattery != null && c.endBattery != null && (
                    <div className="mt-2.5 flex items-center gap-2">
                      <span className="num text-[11px] text-slate-400">{c.startBattery}%</span>
                      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                        <div
                          className="absolute inset-y-0 rounded-full bg-gradient-to-r from-sky-500/60 to-emerald-400/80"
                          style={{ left: `${c.startBattery}%`, width: `${Math.max(c.endBattery - c.startBattery, 1)}%` }}
                        />
                      </div>
                      <span className="num text-[11px] text-slate-300">{c.endBattery}%</span>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          {/* 无限滚动哨兵（v0.3 替代页码） */}
          <div ref={sentinelRef} data-testid="charge-scroll-sentinel" className="h-2" />
          <div className="num pt-3 pb-1 text-center text-[11px] text-slate-500" data-testid="charge-load-state">
            {hasNextPage
              ? isFetching ? t('trips.loadingMore', '加载中…') : t('trips.scrollHint', '下滑加载更多')
              : t('trips.allLoaded', '已加载全部 {n} 条').replace('{n}', String(total))}
          </div>
        </div>
      )}

      {/* 单次充电详情模态（P4）：功率曲线 + 桩端效率 + 录入实付电费 */}
      {detailId != null && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          data-testid="charge-detail-modal"
          onClick={(e) => { if (e.target === e.currentTarget) setDetailId(null) }}
        >
          <div className="glass-card max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-b-none p-5 sm:rounded-2xl">
            {detailError ? (
              <EmptyState
                icon={AlertTriangle}
                title={t('charging.modal.error.title', '详情加载失败')}
                description={t('charging.modal.error.desc', '数据源暂时不可用，请稍后重试')}
                action={{ label: t('charging.modal.retry', '重试'), onClick: () => void refetchDetail() }}
              />
            ) : detail ? (
              <>
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-100">{detail.locationName}</h2>
                    <p className="num mt-0.5 text-[11px] text-slate-400">
                      {fmtDateTime(detail.startAt)} · {fmtDuration(detail.durationMin)}
                    </p>
                  </div>
                  <button onClick={() => setDetailId(null)} aria-label={t('charging.modal.close', '关闭')} autoFocus className="btn-ghost !p-2" data-testid="charge-detail-close">
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="num mb-4 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-white/[0.04] p-3">
                    <div className="text-[11px] text-slate-400">{t('charging.modal.energy', '充入')}</div>
                    <div className="mt-1 text-sm font-semibold text-white">{fmtKwh(detail.energyAddedKWh)}</div>
                  </div>
                  <div className="rounded-xl bg-white/[0.04] p-3">
                    <div className="text-[11px] text-slate-400">{t('charging.modal.cost', '费用')}</div>
                    <div className="mt-1 text-sm font-semibold text-tesla">{fmtCny(detail.costCny)}</div>
                  </div>
                  <div className="rounded-xl bg-white/[0.04] p-3">
                    <div className="text-[11px] text-slate-400">{t('charging.modal.price', '单价')}</div>
                    <div className="mt-1 text-sm font-semibold text-white">{getCurrencySymbol()}{fmtPrice(detail.pricePerUnit)}</div>
                  </div>
                </div>

                {/* 功率曲线 */}
                <section className="mb-4">
                  <h3 className="mb-2 text-xs font-medium text-slate-300">{t('charging.modal.curve', '充电功率曲线')}</h3>
                  <PowerCurve detail={detail} />
                </section>

                {/* 桩端效率（数据未上报时隐藏） */}
                {detail.efficiency && (
                  <section className="mb-4 rounded-xl bg-white/[0.03] p-4" data-testid="efficiency-card">
                    <h3 className="mb-2 text-xs font-medium text-slate-300">{t('charging.eff.title', '充电损耗与真实效率')}</h3>
                    <div className="num grid grid-cols-3 gap-2 text-center text-xs">
                      <div>
                        <div className="text-slate-500">{t('charging.eff.meter', '桩端注入')}</div>
                        <div className="mt-1 text-slate-200">{detail.efficiency.meterKwh} kWh</div>
                      </div>
                      <div>
                        <div className="text-slate-500">{t('charging.eff.battery', '电池净吸收')}</div>
                        <div className="mt-1 text-slate-200">{detail.efficiency.batteryKwh} kWh</div>
                      </div>
                      <div>
                        <div className="text-slate-500">{t('charging.eff.ratio', '真实效率')}</div>
                        <div className="mt-1 font-semibold text-emerald-400">{(detail.efficiency.ratio * 100).toFixed(1)}%</div>
                      </div>
                    </div>
                    <p className="num mt-2 text-[11px] text-amber-400/80">
                      {t('charging.eff.loss', '耗散 {kwh} kWh（线损与电池散热）——「充进车的电」与「付钱买的电」的差额').replace('{kwh}', String(detail.efficiency.lossKwh))}
                    </p>
                  </section>
                )}

                {/* 录入实付电费（AC-7.6/7.1 第①层） */}
                <section className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-4" data-testid="cost-override">
                  <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                    <Pencil className="h-3.5 w-3.5" /> {t('charging.override.title', '录入实付电费')}
                  </h3>
                  <p className="mb-2.5 text-[11px] text-slate-500">
                    {t('charging.override.desc', '以发票/账单为准，保存后账本将按实际金额重算（最近 7 天内生效）')}
                    {detail.overrideCost != null && <span className="ml-1 text-emerald-400">{t('charging.override.current', '当前已录入 ¥{v}').replace('{v}', detail.overrideCost.toFixed(2))}</span>}
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      inputMode="decimal"
                      className="input-dark num flex-1"
                      placeholder={detail.overrideCost != null ? String(detail.overrideCost) : t('charging.override.placeholder', '实付金额')}
                      value={costInput}
                      onChange={(e) => setCostInput(e.target.value)}
                      data-testid="cost-override-input"
                    />
                    <button
                      className="btn-primary shrink-0"
                      onClick={() => saveCost.mutate()}
                      disabled={saveCost.isPending || !costInput}
                      data-testid="cost-override-save"
                    >
                      {t('charging.override.save', '保存')}
                    </button>
                  </div>
                </section>
              </>
            ) : (
              <div className="space-y-3 py-4">
                {Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton h-16" />)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
