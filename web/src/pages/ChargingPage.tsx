import { useEffect, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, BatteryCharging, Coins, MapPin, Pencil, X, Zap } from 'lucide-react'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { Pagination } from '@/components/Pagination'
import { EmptyState } from '@/components/EmptyState'
import { SkeletonList } from '@/components/Skeletons'
import { StatCard } from '@/components/StatCard'
import { useToast } from '@/components/Toast'
import { fmtCny, fmtDateTime, fmtDuration, fmtKwh, fmtPrice } from '@/utils/format'
import type { ChargeDetail } from '@/types'

const PAGE_SIZE = 20

/** 费用来源三态标记（P4 视图A） */
const COST_SOURCE_TAG = {
  manual: { label: '已录入', cls: 'bg-emerald-400/15 text-emerald-400 border border-emerald-400/30' },
  geofence: { label: '规则计价', cls: 'bg-sky-400/10 text-sky-400 border border-sky-400/25' },
  default: { label: '默认估算', cls: 'bg-white/[0.05] text-slate-400 border border-white/[0.08]' },
  unknown: { label: '未计价', cls: 'bg-white/[0.05] text-slate-400 border border-white/[0.08]' },
} as const

/** 功率曲线（SVG，SoC 横轴 × kW 纵轴，峰值打点） */
function PowerCurve({ detail }: { detail: ChargeDetail }) {
  const pts = detail.powerCurve
  if (pts.length < 2) {
    return <p className="py-6 text-center text-xs text-slate-500">该会话无功率采样数据</p>
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
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[420px]" role="img" aria-label="充电功率曲线">
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
  const [page, setPage] = useState(1)
  const [month, setMonth] = useState('')
  const [detailId, setDetailId] = useState<number | null>(null)
  const [costInput, setCostInput] = useState('')
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const currentMonth = () => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  }

  const listParams = { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, month: month || undefined }
  const { data, isLoading } = useQuery({
    queryKey: ['charging', listParams],
    queryFn: () => api.charging(listParams),
    placeholderData: keepPreviousData,
  })
  const { data: stats } = useQuery({
    queryKey: ['charging-stats', month],
    queryFn: () => api.chargingStats('month', month || currentMonth()),
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
      toast('实付电费已录入，账本将在后台重算', 'success')
      setCostInput('')
      void queryClient.invalidateQueries({ queryKey: ['charging'] })
      void queryClient.invalidateQueries({ queryKey: ['charging-detail', detailId] })
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

  const pageCount = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  const byLocation = stats?.byLocation ?? []
  const maxKwh = Math.max(...byLocation.map((l) => l.kwh), 1)

  return (
    <div>
      <PageHeader icon={BatteryCharging} title="充电" subtitle="充电账本与站点统计" />

      {/* 月份筛选（P4 DatePicker 简化为原生 month input） */}
      <div className="mb-4 flex items-center gap-3">
        <label htmlFor="charge-month" className="text-xs text-slate-400">月份筛选</label>
        <input
          id="charge-month"
          type="month"
          className="input-dark num max-w-[170px]"
          value={month}
          onChange={(e) => { setMonth(e.target.value); setPage(1) }}
          data-testid="month-filter"
        />
        {month && (
          <button className="btn-ghost !py-2 text-xs" onClick={() => setMonth('')} data-testid="month-clear">
            清除
          </button>
        )}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="charge-stats">
        {stats ? (
          <>
            <StatCard icon={Zap} label="本月充电量" value={fmtKwh(stats.totalKWh)} />
            <StatCard icon={Coins} label="本月电费" value={fmtCny(stats.totalCostCny)} accent data-testid="charge-total-cost" />
            <StatCard icon={BatteryCharging} label="平均单价" value={`¥${fmtPrice(stats.avgPricePerKWh)}/kWh`} />
          </>
        ) : (
          <div className="glass-card-flat col-span-2 space-y-3 p-4 sm:col-span-3">
            <div className="skeleton h-3 w-1/4" />
            <div className="skeleton h-6 w-2/5" />
          </div>
        )}
      </div>

      {/* 按地点统计条形图（纯 CSS） */}
      <section className="glass-card-flat mb-4 p-5" data-testid="location-chart">
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
                    {fmtKwh(loc.kwh)} · ¥{fmtPrice(loc.pricePerUnit)}/kWh · {loc.count} 次
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
        <div className="glass-card-flat">
          <EmptyState icon={BatteryCharging} title="暂无充电记录" description="TeslaMate 记录到充电会话后会自动同步" />
        </div>
      ) : (
        <div>
          <ul className="space-y-2.5" data-testid="charge-list">
            {data.items.map((c) => {
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
                        {tag.label}
                      </span>
                      <span className="num text-sm font-semibold text-tesla">{fmtCny(c.costCny)}</span>
                    </div>
                  </div>
                  <div className="num mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
                    <span>{fmtDateTime(c.startAt)}</span>
                    <span>{fmtDuration(c.durationMin)}</span>
                    <span>{fmtKwh(c.energyAddedKWh)}</span>
                    <span>¥{fmtPrice(c.pricePerUnit)}/kWh</span>
                    <span>峰值 {c.powerMaxKw.toFixed(1)} kW</span>
                  </div>
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
                </li>
              )
            })}
          </ul>
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
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
                title="详情加载失败"
                description="数据源暂时不可用，请稍后重试"
                action={{ label: '重试', onClick: () => void refetchDetail() }}
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
                  <button onClick={() => setDetailId(null)} aria-label="关闭" autoFocus className="btn-ghost !p-2" data-testid="charge-detail-close">
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="num mb-4 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-white/[0.04] p-3">
                    <div className="text-[11px] text-slate-400">充入</div>
                    <div className="mt-1 text-sm font-semibold text-white">{fmtKwh(detail.energyAddedKWh)}</div>
                  </div>
                  <div className="rounded-xl bg-white/[0.04] p-3">
                    <div className="text-[11px] text-slate-400">费用</div>
                    <div className="mt-1 text-sm font-semibold text-tesla">{fmtCny(detail.costCny)}</div>
                  </div>
                  <div className="rounded-xl bg-white/[0.04] p-3">
                    <div className="text-[11px] text-slate-400">单价</div>
                    <div className="mt-1 text-sm font-semibold text-white">¥{fmtPrice(detail.pricePerUnit)}</div>
                  </div>
                </div>

                {/* 功率曲线 */}
                <section className="mb-4">
                  <h3 className="mb-2 text-xs font-medium text-slate-300">充电功率曲线</h3>
                  <PowerCurve detail={detail} />
                </section>

                {/* 桩端效率（数据未上报时隐藏） */}
                {detail.efficiency && (
                  <section className="mb-4 rounded-xl bg-white/[0.03] p-4" data-testid="efficiency-card">
                    <h3 className="mb-2 text-xs font-medium text-slate-300">充电损耗与真实效率</h3>
                    <div className="num grid grid-cols-3 gap-2 text-center text-xs">
                      <div>
                        <div className="text-slate-500">桩端注入</div>
                        <div className="mt-1 text-slate-200">{detail.efficiency.meterKwh} kWh</div>
                      </div>
                      <div>
                        <div className="text-slate-500">电池净吸收</div>
                        <div className="mt-1 text-slate-200">{detail.efficiency.batteryKwh} kWh</div>
                      </div>
                      <div>
                        <div className="text-slate-500">真实效率</div>
                        <div className="mt-1 font-semibold text-emerald-400">{(detail.efficiency.ratio * 100).toFixed(1)}%</div>
                      </div>
                    </div>
                    <p className="num mt-2 text-[11px] text-amber-400/80">
                      耗散 {detail.efficiency.lossKwh} kWh（线损与电池散热）——「充进车的电」与「付钱买的电」的差额
                    </p>
                  </section>
                )}

                {/* 录入实付电费（AC-7.6/7.1 第①层） */}
                <section className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-4" data-testid="cost-override">
                  <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                    <Pencil className="h-3.5 w-3.5" /> 录入实付电费
                  </h3>
                  <p className="mb-2.5 text-[11px] text-slate-500">
                    以发票/账单为准，保存后账本将按实际金额重算（最近 7 天内生效）
                    {detail.overrideCost != null && <span className="ml-1 text-emerald-400">当前已录入 ¥{detail.overrideCost.toFixed(2)}</span>}
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      inputMode="decimal"
                      className="input-dark num flex-1"
                      placeholder={detail.overrideCost != null ? String(detail.overrideCost) : '实付金额'}
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
                      保存
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
