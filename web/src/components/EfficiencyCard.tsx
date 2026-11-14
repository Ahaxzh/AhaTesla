import { useQuery } from '@tanstack/react-query'
import { Gauge, Trophy } from 'lucide-react'
import { api } from '@/api/client'
import { useI18n } from '@/i18n'
import { useCar } from '@/contexts/CarContext'
import type { DisplayAccuracy } from '@/types'

/**
 * 能效画像卡（v2.6.1 重设计，行程页）——只回答车主关心的两件事，一眼可读：
 * ① 跑赢表显了吗？→「表显达成率」一个大数（实际里程 ÷ 表显续航消耗，>100% = 跑赢）
 * ② 什么情况最省？→ 温度/均速分箱，**相对区间平均的 Δ**（绿=更省 红/琥珀=更费），
 *    每行：区间标签 · Wh/km · Δ% · 条长按能耗比例——"冷天比平均费 14%"这种结论直接可读。
 * 数据完全跟随页面筛选区间（from/to）；样本不足（<5 趟）整卡隐藏。
 * v2.6 的月度柱状图已删——无坐标无标注，看不出在说什么（用户反馈）。
 */

function DeltaBinRow({ label, whPerKm, avg, max }: { label: string; whPerKm: number | null; avg: number | null; max: number }) {
  const pct = whPerKm != null && max > 0 ? Math.min((whPerKm / max) * 100, 100) : 0
  const delta = whPerKm != null && avg ? Math.round(((whPerKm - avg) / avg) * 100) : null
  const better = delta != null && delta < 0
  const notable = delta != null && Math.abs(delta) >= 5
  return (
    <div className="flex items-center gap-2" title={`${label} · ${whPerKm ?? '--'} Wh/km`}>
      <span className="num w-[68px] shrink-0 text-right text-[11px] text-slate-400">{label}</span>
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.05]" role="presentation">
        {whPerKm != null && (
          <div className={`h-full rounded-full ${better ? 'bg-emerald-500/80' : 'bg-amber-500/70'}`} style={{ width: `${Math.max(pct, 4)}%` }} />
        )}
      </div>
      <span className="num w-[46px] shrink-0 text-[11px] text-slate-300">{whPerKm ?? '--'}</span>
      <span className={`num w-[44px] shrink-0 text-right text-[11px] ${delta == null ? 'text-slate-500' : notable ? (better ? 'text-emerald-400' : 'text-amber-400') : 'text-slate-400'}`}>
        {delta == null ? '--' : `${delta > 0 ? '+' : ''}${delta}%`}
      </span>
    </div>
  )
}

export function EfficiencyCard({ from, to }: { from?: string; to?: string }) {
  const { t } = useI18n()
  const { currentCarId } = useCar()
  const params = { from, to, carId: currentCarId ?? undefined }
  const { data: profile } = useQuery({
    queryKey: ['efficiency-profile', params],
    queryFn: () => api.efficiencyProfile(params),
    staleTime: 10 * 60_000,
    retry: false,
  })
  const { data: accuracy } = useQuery({
    queryKey: ['display-accuracy', params],
    queryFn: () => api.displayAccuracy(params),
    staleTime: 10 * 60_000,
    retry: false,
  })

  if (!profile || !Array.isArray(profile.tempBins) || !Array.isArray(profile.speedBins) || profile.samples < 5) return null

  const avgRatio = (accuracy as DisplayAccuracy | undefined)?.avgRatio ?? null
  const avg = profile.avgWhPerKm ?? null
  const binsMax = Math.max(...profile.tempBins.map((b) => b.whPerKm ?? 0), ...profile.speedBins.map((b) => b.whPerKm ?? 0), 1)

  return (
    <section className="glass-card-flat p-4" data-testid="trip-efficiency-card">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium text-slate-200">
          <Gauge className="h-4 w-4 text-tesla" /> {t('eff.title', '能效画像')}
        </h3>
        <span className="num text-[11px] text-slate-500">
          {t('eff.samples', '{d} 天 · {n} 趟').replace('{d}', String(profile.days)).replace('{n}', String(profile.samples))}
        </span>
      </div>

      {/* 两个大结论：表显达成率 + 个人最佳 */}
      <div className="mb-4 grid grid-cols-2 gap-2.5">
        <div className="rounded-xl bg-white/[0.04] px-3 py-2.5" data-testid="eff-accuracy">
          <p className="text-[11px] text-slate-400">{t('eff.displayRatio', '表显达成率')}</p>
          <p className="num mt-0.5 text-lg font-semibold">
            {avgRatio != null ? (
              <span className={avgRatio >= 1 ? 'text-emerald-400' : 'text-amber-400'}>{(avgRatio * 100).toFixed(0)}%</span>
            ) : '--'}
            {avgRatio != null && (
              <span className="ml-1.5 text-[11px] font-normal text-slate-500">
                {avgRatio >= 1 ? t('eff.beats', '跑赢表显') : t('eff.behind', '未跑赢')}
              </span>
            )}
          </p>
          <p className="mt-0.5 text-[10px] text-slate-500">{t('eff.displayRatioDesc', '实际里程 ÷ 表显续航消耗，>100% 为跑赢')}</p>
        </div>
        {profile.best && (
          <div className="rounded-xl bg-white/[0.04] px-3 py-2.5" data-testid="eff-best">
            <p className="flex items-center gap-1 text-[11px] text-slate-400">
              <Trophy className="h-3 w-3 text-amber-400" /> {t('eff.bestLabel', '个人最佳')}
            </p>
            <p className="num mt-0.5 text-lg font-semibold text-amber-300">{profile.best.whPerKm} <span className="text-[11px] font-normal text-slate-400">Wh/km</span></p>
            <p className="num mt-0.5 truncate text-[10px] text-slate-500">
              {profile.best.distanceKm} km
              {profile.best.tempC != null && ` · ${profile.best.tempC}°C`}
              {profile.best.avgSpeedKmh != null && ` · ${t('eff.avgSpeed', '均')} ${profile.best.avgSpeedKmh} km/h`}
            </p>
          </div>
        )}
      </div>

      {/* 什么情况最省：分箱 Δ 相对区间平均 */}
      <p className="mb-2 text-[11px] font-medium text-slate-300">
        {t('eff.whenBest', '什么情况最省？')}
        <span className="ml-1.5 font-normal text-slate-500">{t('eff.whenBestHint', '相对区间平均能耗（Wh/km），绿=更省 · 琥珀=更费')}</span>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-1.5 text-[11px] text-slate-400">{t('eff.byTemp', '按气温')}</p>
          <div className="space-y-1.5">
            {profile.tempBins.filter((b) => b.count > 0).map((b) => (
              <DeltaBinRow key={b.label} label={b.label} whPerKm={b.whPerKm} avg={avg} max={binsMax} />
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-[11px] text-slate-400">{t('eff.bySpeed', '按均速')}</p>
          <div className="space-y-1.5">
            {profile.speedBins.filter((b) => b.count > 0).map((b) => (
              <DeltaBinRow key={b.label} label={b.label} whPerKm={b.whPerKm} avg={avg} max={binsMax} />
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
