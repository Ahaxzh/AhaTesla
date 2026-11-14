import { useQuery } from '@tanstack/react-query'
import { BatteryCharging } from 'lucide-react'
import { api } from '@/api/client'
import { useI18n } from '@/i18n'
import { useCar } from '@/contexts/CarContext'

/**
 * 充电习惯画像卡（v2.6.1 重设计）——"别充满、别耗尽，我实际做得怎样？"
 * ① 四个指标：平均起充 / 平均收枪 / 充到 >90% 占比 / <15% 才充占比（超阈值琥珀提醒）
 * ② 两张**独立标注**的分布图（v2.6 起止叠加在同一坐标里意义不明已废）：
 *    「从多少开始充」「充到多少收枪」各一行 10 格，格子高度=占区间次数比例，
 *    0-20% 与 90-100% 两端（深充深放区）底色微红提示。
 * 数据跟随充电页筛选区间（from/to）；样本 <10 整卡隐藏。
 */

function DistRow({ title, hist, total }: { title: string; hist: number[]; total: number }) {
  const max = Math.max(...hist, 1)
  return (
    <div>
      <p className="mb-1 text-[11px] text-slate-400">{title}</p>
      <div className="flex h-12 items-end gap-[3px]">
        {hist.map((n, i) => {
          const pct = total > 0 ? (n / total) * 100 : 0
          const edge = i <= 1 || i >= 9 // 0-20% / 90-100% 深充深放区
          return (
            <div
              key={i}
              className={`min-w-[8px] flex-1 rounded-t-[3px] ${n > 0 ? (edge ? 'bg-amber-500/70' : 'bg-emerald-500/75') : 'bg-white/[0.05]'}`}
              style={{ height: `${Math.max((n / max) * 100, n > 0 ? 8 : 4)}%` }}
              title={`${i * 10}~${i * 10 + 10}%：${n} 次（${pct.toFixed(0)}%）`}
            />
          )
        })}
      </div>
      <div className="num mt-1 flex justify-between text-[10px] text-slate-500">
        <span>0%</span>
        <span>50%</span>
        <span>100%</span>
      </div>
    </div>
  )
}

function Metric({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-xl bg-white/[0.04] px-3 py-2" data-testid="habits-chip">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`num mt-0.5 text-sm font-semibold ${warn ? 'text-amber-400' : 'text-slate-200'}`}>{value}</div>
    </div>
  )
}

export function ChargingHabitsCard({ from, to }: { from?: string; to?: string }) {
  const { t } = useI18n()
  const { currentCarId } = useCar()
  const params = { from, to, carId: currentCarId ?? undefined }
  const { data } = useQuery({
    queryKey: ['charging-habits', params],
    queryFn: () => api.chargingHabits(params),
    staleTime: 10 * 60_000,
    retry: false,
  })

  if (!data || !data.sufficient) return null

  return (
    <section className="glass-card-flat p-5" data-testid="habits-card">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-medium text-slate-200">
          <BatteryCharging className="h-4 w-4 text-tesla" /> {t('habits.title', '充电习惯')}
        </h2>
        <span className="num text-[11px] text-slate-500">
          {t('habits.samples', '{d} 天 · {n} 次').replace('{d}', String(data.days)).replace('{n}', String(data.sessions))}
        </span>
      </div>
      <p className="mb-3 text-xs text-slate-500">{t('habits.desc', '别充满、别耗尽——看看实际做得怎样（两端格子=深充深放）')}</p>

      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Metric label={t('habits.avgStart', '平均起充')} value={data.avgStartSoc != null ? `${data.avgStartSoc}%` : '--'} warn={data.avgStartSoc != null && data.avgStartSoc < 20} />
        <Metric label={t('habits.avgEnd', '平均收枪')} value={data.avgEndSoc != null ? `${data.avgEndSoc}%` : '--'} warn={data.avgEndSoc != null && data.avgEndSoc > 90} />
        <Metric label={t('habits.above90', '充到 >90%')} value={data.endAbove90Pct != null ? `${data.endAbove90Pct}%` : '--'} warn={data.endAbove90Pct != null && data.endAbove90Pct >= 30} />
        <Metric label={t('habits.below15', '<15% 才充')} value={data.startBelow15Pct != null ? `${data.startBelow15Pct}%` : '--'} warn={data.startBelow15Pct != null && data.startBelow15Pct >= 30} />
      </div>

      <div className="space-y-4">
        <DistRow title={t('habits.startDist', '从多少开始充（每格 = 次数占比）')} hist={data.startHist} total={data.sessions} />
        <DistRow title={t('habits.endDist', '充到多少收枪（每格 = 次数占比）')} hist={data.endHist} total={data.sessions} />
      </div>
    </section>
  )
}
