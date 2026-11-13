import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, ChevronDown } from 'lucide-react'
import { api } from '@/api/client'
import { useI18n } from '@/i18n'
import { useCar } from '@/contexts/CarContext'
import type { BatteryHealth } from '@/types'

/** 大卡主体（v0.3 抽出：full 卡与 slim 展开态共用同一份身体） */
function FullBody({ data }: { data: BatteryHealth }) {
  const { t } = useI18n()
  const health = data.healthPct as number
  const healthColor = health >= 90 ? 'text-emerald-400' : health >= 80 ? 'text-amber-400' : 'text-red-400'
  const trend = data.trend ?? []
  const trendMax = Math.max(...trend.map((p) => p.maxRangeKm), 1)
  const trendMin = Math.min(...trend.map((p) => p.maxRangeKm), trendMax)
  const span = Math.max(trendMax - trendMin, 1)

  return (
    <>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className={`num text-3xl font-bold ${healthColor}`}>
            {health.toFixed(1)}<span className="text-base font-medium text-slate-400">%</span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">{t('battery.health', '健康度')}</div>
          <div className="mt-0.5 text-[10px] text-slate-600">
            {t('battery.rangeDelta', '满电续航')} {data.baselineMaxRangeKm?.toFixed(0)}→{data.currentMaxRangeKm?.toFixed(0)} km
          </div>
        </div>
        <div>
          <div className="num text-3xl font-bold text-slate-100">
            {data.capacityKwh?.toFixed(1) ?? '--'}<span className="text-base font-medium text-slate-400"> kWh</span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">{t('battery.capacity', '可用容量')}</div>
        </div>
        <div>
          <div className="num text-3xl font-bold text-slate-100">{data.cycles?.toFixed(0) ?? '--'}</div>
          <div className="mt-0.5 text-[11px] text-slate-500">{t('battery.cycles', '完整循环')}</div>
        </div>
        <div>
          <div className="num text-3xl font-bold text-slate-100">
            {data.rechargeEfficiency != null ? `${data.rechargeEfficiency.toFixed(1)}` : '--'}<span className="text-base font-medium text-slate-400">%</span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">{t('battery.efficiency', '充电效率')}</div>
          <div className="mt-0.5 text-[10px] text-slate-600">{t('battery.efficiencyHint', '充入 ÷ 桩端')}</div>
        </div>
      </div>

      {trend.length >= 3 && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between text-[11px] text-slate-500">
            <span>{t('battery.trend', '满电表显续航 · 按月')}</span>
            <span className="num">{trend[0].month.slice(2)} ~ {trend[trend.length - 1].month.slice(2)}</span>
          </div>
          <div className="flex h-14 items-end gap-[3px]" data-testid="battery-trend">
            {trend.map((p) => (
              <div
                key={p.month}
                className="flex-1 rounded-t bg-gradient-to-t from-tesla/25 to-tesla/70"
                style={{ height: `${12 + ((p.maxRangeKm - trendMin) / span) * 88}%` }}
                title={`${p.month} · ${p.maxRangeKm} km`}
              />
            ))}
          </div>
        </div>
      )}

      <p className="mt-4 text-[10px] leading-4 text-slate-600">
        {t('battery.method', '口径：基于有效充电会话（≥10kWh 且电量增幅 ≥10%）的表显续航折算；健康度 = 近期 ÷ 提车初期投影。')}
      </p>
    </>
  )
}

/** 电池健康卡(TeslaMate BatteryHealthV2 提炼):
 *  健康度% / 当前满电续航 / 可用容量 / 完整循环 / 充电效率 + 满电续航月度趋势条。
 *  样本不足(insufficient)整卡隐藏 —— 数据可得才显示。
 *  variant='full'（充电页）：完整大卡；variant='slim'（首页）：紧凑单行，
 *  点击就地展开成大卡（折叠效果 v0.3），再点收起。 */
export function BatteryHealthCard({ variant = 'full' }: { variant?: 'full' | 'slim' }) {
  const { t } = useI18n()
  const { currentCarId } = useCar()
  const [expanded, setExpanded] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['battery-health', currentCarId],
    queryFn: () => api.batteryHealth(currentCarId),
    staleTime: 10 * 60_000,
    retry: false,
  })

  if (isLoading) {
    if (variant === 'slim') return <div className="skeleton h-9 w-full rounded-xl" data-testid="battery-health-skeleton" />
    return (
      <section className="glass-card fade-up p-5" data-testid="battery-health-skeleton">
        <div className="skeleton h-4 w-32 rounded" />
        <div className="skeleton mt-4 h-16 w-full rounded-xl" />
      </section>
    )
  }
  if (!data || data.insufficient || data.healthPct == null) return null

  const health = data.healthPct
  const healthColor = health >= 90 ? 'text-emerald-400' : health >= 80 ? 'text-amber-400' : 'text-red-400'
  const trend = data.trend ?? []
  const trendMax = Math.max(...trend.map((p) => p.maxRangeKm), 1)
  const trendMin = Math.min(...trend.map((p) => p.maxRangeKm), trendMax)
  const span = Math.max(trendMax - trendMin, 1)

  // 紧凑单行（首页）：健康度 · 容量 · 循环 + 迷你趋势条；点击就地展开成完整大卡
  if (variant === 'slim') {
    return (
      <section className="glass-card p-4" data-testid={expanded ? 'battery-health-card' : 'battery-health-slim'}>
        <button
          type="button"
          className="flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 text-left text-[11px]"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          data-testid="battery-health-toggle"
        >
          <span className="font-medium text-slate-200">{t('battery.title', '电池健康')}</span>
          <span className={`num font-semibold ${healthColor}`}>{health.toFixed(1)}%</span>
          <span className="num text-slate-400">{data.capacityKwh?.toFixed(1) ?? '--'} kWh</span>
          <span className="num text-slate-400">{data.cycles?.toFixed(0) ?? '--'} {t('battery.cycles', '完整循环')}</span>
          {trend.length >= 3 && !expanded && (
            <span className="ml-auto flex h-4 items-end gap-[2px]" aria-hidden>
              {trend.map((p) => (
                <span key={p.month} className="w-[3px] rounded-t bg-tesla/70" style={{ height: `${Math.max(20 + ((p.maxRangeKm - trendMin) / span) * 80, 20)}%` }} />
              ))}
            </span>
          )}
          <ChevronDown className={`ml-auto h-4 w-4 shrink-0 text-slate-500 transition-transform ${expanded ? 'rotate-180' : ''} ${trend.length >= 3 && !expanded ? '!ml-2' : ''}`} />
        </button>
        {expanded && (
          <div className="fade-up" data-testid="battery-health-expanded">
            <FullBody data={data} />
          </div>
        )}
      </section>
    )
  }

  return (
    <section className="glass-card fade-up p-5" data-testid="battery-health-card">
      <h2 className="section-title">
        <Activity className="h-4 w-4 text-tesla" /> {t('battery.title', '电池健康')}
      </h2>
      <FullBody data={data} />
    </section>
  )
}
