import { useQuery } from '@tanstack/react-query'
import { BatteryCharging } from 'lucide-react'
import { api } from '@/api/client'
import { useI18n } from '@/i18n'
import { useCar } from '@/contexts/CarContext'
import type { ChargingHabits } from '@/types'

/**
 * 充电习惯画像卡（v2.5，电池保养视角）——老车主都懂"别充满、别耗尽"，
 * 这张卡回答"我实际做得怎样"：起止 SoC 均值、充到 >90% 收枪 / <15% 起充占比、
 * 起/止 SoC 十格直方图（收枪高度集中在哪个档一看便知）。
 * 样本 <10（sufficient=false）或查询失败 → 整卡隐藏（同电池健康卡，不占版面）。
 */

/** 双直方图行：起始(天蓝描边)与结束(翠绿填充)叠加，bin 高度按各自 max 归一 */
function SocHistogram({ habits }: { habits: ChargingHabits }) {
  const { t } = useI18n()
  const max = Math.max(...habits.startHist, ...habits.endHist, 1)
  return (
    <div data-testid="habits-histogram">
      <div className="flex h-16 items-end gap-[3px]">
        {habits.endHist.map((end, i) => {
          const start = habits.startHist[i]
          return (
            <div key={i} className="relative flex h-full min-w-[2px] flex-1 flex-col justify-end">
              {/* 结束 SoC：实心翠绿柱 */}
              <div className="w-full rounded-t-[2px] bg-emerald-500/80" style={{ height: `${Math.max((end / max) * 100, end > 0 ? 4 : 0)}%` }} />
              {/* 起始 SoC：底部天蓝条（贴柱根，起充档位一眼可辨） */}
              {start > 0 && (
                <div
                  className="absolute bottom-0 w-full rounded-[2px] bg-sky-500"
                  style={{ height: `${Math.max((start / max) * 100, 5)}%` }}
                  title={`${i * 10}~${i * 10 + 10}%`}
                />
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-500">
        <span>0%</span>
        <span>50%</span>
        <span>100%</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-sky-500" />
          {t('habits.legend.start', '起充 SoC')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
          {t('habits.legend.end', '收枪 SoC')}
        </span>
      </div>
    </div>
  )
}

function Chip({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 rounded-xl bg-white/[0.04] px-3 py-2" data-testid="habits-chip">
      <span className="shrink-0 text-[11px] text-slate-400">{label}</span>
      <span className={`num text-sm font-medium ${warn ? 'text-amber-400' : 'text-slate-200'}`}>{value}</span>
    </div>
  )
}

export function ChargingHabitsCard() {
  const { t } = useI18n()
  const { currentCarId } = useCar()
  const { data } = useQuery({
    queryKey: ['charging-habits', currentCarId],
    queryFn: () => api.chargingHabits(currentCarId ?? undefined),
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
          {t('habits.samples', '近{d}天 · {n}次').replace('{d}', String(data.days)).replace('{n}', String(data.sessions))}
        </span>
      </div>
      <p className="mb-3 text-xs text-slate-500">{t('habits.desc', '别充满、别耗尽——看看实际做得怎样')}</p>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Chip label={t('habits.avgStart', '平均起充')} value={data.avgStartSoc != null ? `${data.avgStartSoc}%` : '--'} warn={data.avgStartSoc != null && data.avgStartSoc < 20} />
        <Chip label={t('habits.avgEnd', '平均收枪')} value={data.avgEndSoc != null ? `${data.avgEndSoc}%` : '--'} warn={data.avgEndSoc != null && data.avgEndSoc > 90} />
        <Chip label={t('habits.above90', '充到 >90%')} value={data.endAbove90Pct != null ? `${data.endAbove90Pct}%` : '--'} warn={data.endAbove90Pct != null && data.endAbove90Pct >= 30} />
        <Chip label={t('habits.below15', '<15% 才充')} value={data.startBelow15Pct != null ? `${data.startBelow15Pct}%` : '--'} warn={data.startBelow15Pct != null && data.startBelow15Pct >= 30} />
      </div>
      <div className="mt-4">
        <SocHistogram habits={data} />
      </div>
    </section>
  )
}
