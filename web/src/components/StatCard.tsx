import type { LucideIcon } from 'lucide-react'

interface StatCardProps {
  icon: LucideIcon
  label: string
  value: string
  hint?: string
  accent?: boolean
  /** v2.6.3 紧凑变体（行程详情等）：小图标/更紧的 padding/hint 内联值尾——大卡在详情页显得空 */
  compact?: boolean
  'data-testid'?: string
}

export function StatCard({ icon: Icon, label, value, hint, accent, compact, ...rest }: StatCardProps) {
  if (compact) {
    return (
      <div
        className={`glass-card-flat flex min-h-[52px] items-center gap-2.5 px-3 py-2.5 ${accent ? 'border-tesla/25' : ''}`}
        data-testid={rest['data-testid'] ?? 'stat-card'}
      >
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
            accent ? 'bg-tesla/15 text-tesla' : 'bg-white/[0.06] text-slate-300'
          }`}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] text-slate-400">{label}</div>
          <div className="num truncate text-sm font-semibold text-slate-100" title={hint ? `${value} (${hint})` : value}>
            {value}
            {hint && <span className="ml-1 text-[10px] font-normal text-slate-500">{hint}</span>}
          </div>
        </div>
      </div>
    )
  }
  return (
    <div
      className={`glass-card-flat fade-up flex items-center gap-3.5 p-4 ${accent ? 'border-tesla/25' : ''}`}
      data-testid={rest['data-testid'] ?? 'stat-card'}
    >
      <div
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
          accent ? 'bg-tesla/15 text-tesla' : 'bg-white/[0.06] text-slate-300'
        }`}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-slate-400">{label}</div>
        <div className="num mt-0.5 truncate text-base font-semibold text-slate-100" title={value}>
          {value}
        </div>
        {/* hint 行恒占位（无 hint 也保留行高）：同排卡片尺寸一致（v2.6.1） */}
        <div className="num mt-0.5 min-h-[15px] truncate text-[11px] text-slate-400">{hint ?? ' '}</div>
      </div>
    </div>
  )
}
