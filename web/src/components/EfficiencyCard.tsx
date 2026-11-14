import { useQuery } from '@tanstack/react-query'
import { Gauge, Trophy } from 'lucide-react'
import { api } from '@/api/client'
import { useI18n } from '@/i18n'
import { useCar } from '@/contexts/CarContext'
import type { DisplayAccuracy } from '@/types'

/**
 * 能效画像卡（v2.6，行程页）——车主第一关注："能否跑赢表显？什么情况能耗最低？"
 * 三块：① 个人最佳战绩（Wh/km 最低一程 + 当时温度/均速）② 表显达成率月趋势
 * （实际 ÷ 表显消耗，>100% = 跑赢）③ 温度/均速分箱能耗（冷天热泵、高速风阻一目了然）。
 * 数据不足（<2 个月 / 无样本）整卡隐藏。
 */

const fmtDate = (iso: string | null): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function BinRow({ label, whPerKm, max }: { label: string; whPerKm: number | null; max: number }) {
  const pct = whPerKm != null && max > 0 ? Math.min((whPerKm / max) * 100, 100) : 0
  return (
    <div className="flex items-center gap-2">
      <span className="num w-[64px] shrink-0 text-right text-[11px] text-slate-400">{label}</span>
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.05]" role="presentation">
        {whPerKm != null && (
          <div
            className={`h-full rounded-full ${whPerKm <= 150 ? 'bg-emerald-500/80' : whPerKm <= 200 ? 'bg-sky-500/80' : 'bg-amber-500/80'}`}
            style={{ width: `${Math.max(pct, 4)}%` }}
          />
        )}
      </div>
      <span className="num w-[52px] shrink-0 text-[11px] text-slate-300">{whPerKm ?? '--'}</span>
    </div>
  )
}

export function EfficiencyCard() {
  const { t } = useI18n()
  const { currentCarId } = useCar()
  const { data: profile } = useQuery({
    queryKey: ['efficiency-profile', currentCarId],
    queryFn: () => api.efficiencyProfile(currentCarId ?? undefined),
    staleTime: 10 * 60_000,
    retry: false,
  })
  const { data: accuracy } = useQuery({
    queryKey: ['display-accuracy', currentCarId],
    queryFn: () => api.displayAccuracy(currentCarId ?? undefined),
    staleTime: 10 * 60_000,
    retry: false,
  })

  // 防御：bins 缺失（异常响应/旧缓存）不渲染，不白屏
  if (!profile || !Array.isArray(profile.tempBins) || !Array.isArray(profile.speedBins) || profile.samples < 5) return null
  const binsMax = Math.max(
    ...profile.tempBins.map((b) => b.whPerKm ?? 0),
    ...profile.speedBins.map((b) => b.whPerKm ?? 0),
    1,
  )
  const months = (accuracy as DisplayAccuracy | undefined)?.months ?? []
  const avgRatio = (accuracy as DisplayAccuracy | undefined)?.avgRatio ?? null

  return (
    <section className="glass-card-flat p-4" data-testid="trip-efficiency-card">
      <div className="mb-2.5 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium text-slate-200">
          <Gauge className="h-4 w-4 text-tesla" /> {t('eff.title', '能效画像')}
        </h3>
        <span className="num text-[11px] text-slate-500">
          {t('eff.samples', '近一年 {n} 趟').replace('{n}', String(profile.samples))}
        </span>
      </div>

      {/* 个人最佳 + 表显达成均值 */}
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {profile.best && (
          <div className="flex items-center gap-2 rounded-xl bg-white/[0.04] px-3 py-2" data-testid="eff-best">
            <Trophy className="h-4 w-4 shrink-0 text-amber-400" />
            <p className="num min-w-0 truncate text-xs text-slate-300">
              {t('eff.best', '最佳')} <span className="font-semibold text-amber-300">{profile.best.whPerKm} Wh/km</span>
              {profile.best.at && <span className="text-slate-500"> · {fmtDate(profile.best.at)}</span>}
              {profile.best.tempC != null && <span className="text-slate-500"> · {profile.best.tempC}°C</span>}
              {profile.best.avgSpeedKmh != null && <span className="text-slate-500"> · {t('eff.avgSpeed', '均')} {profile.best.avgSpeedKmh} km/h</span>}
            </p>
          </div>
        )}
        {avgRatio != null && months.length >= 2 && (
          <div className="flex items-center gap-2 rounded-xl bg-white/[0.04] px-3 py-2" data-testid="eff-accuracy">
            <p className="num min-w-0 truncate text-xs text-slate-300">
              {t('eff.displayRatio', '表显达成率')}
              <span className={`ml-1.5 font-semibold ${avgRatio >= 1 ? 'text-emerald-400' : 'text-amber-400'}`}>
                {(avgRatio * 100).toFixed(0)}%
              </span>
              <span className="ml-1.5 text-slate-500">{t('eff.displayRatioHint', avgRatio >= 1 ? '跑赢表显' : '未跑赢')}</span>
            </p>
          </div>
        )}
      </div>

      {/* 表显达成率月趋势：细柱 + 100% 参考线 */}
      {months.length >= 2 && (
        <div className="mb-3" data-testid="eff-monthly">
          <div className="relative h-12">
            <div className="absolute inset-x-0 border-t border-dashed border-white/20" style={{ top: `${100 - Math.min((100 / 1.3) * 100, 92)}%` }} />
            <div className="flex h-full items-end gap-[2px]">
              {months.map((m) => {
                const pct = Math.min((m.ratio / 1.3) * 100, 100)
                return (
                  <div
                    key={m.month}
                    className={`min-w-[3px] flex-1 rounded-t-[2px] ${m.ratio >= 1 ? 'bg-emerald-500/70' : 'bg-sky-500/60'}`}
                    style={{ height: `${Math.max(pct, 4)}%` }}
                    title={`${m.month} · ${(m.ratio * 100).toFixed(0)}% · ${m.trips} 趟`}
                  />
                )
              })}
            </div>
          </div>
          <div className="num mt-1 flex justify-between text-[10px] text-slate-500">
            <span>{months[0].month}</span>
            <span>{t('eff.monthly', '月度表显达成率（虚线 100%）')}</span>
            <span>{months[months.length - 1].month}</span>
          </div>
        </div>
      )}

      {/* 温度 / 速度分箱 */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-1.5 text-[11px] text-slate-400">{t('eff.byTemp', '按气温')}</p>
          <div className="space-y-1.5">
            {profile.tempBins.filter((b) => b.count > 0).map((b) => (
              <BinRow key={b.label} label={b.label} whPerKm={b.whPerKm} max={binsMax} />
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-[11px] text-slate-400">{t('eff.bySpeed', '按均速')}</p>
          <div className="space-y-1.5">
            {profile.speedBins.filter((b) => b.count > 0).map((b) => (
              <BinRow key={b.label} label={b.label} whPerKm={b.whPerKm} max={binsMax} />
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
