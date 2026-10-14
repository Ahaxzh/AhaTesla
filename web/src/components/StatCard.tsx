import type { LucideIcon } from 'lucide-react'

interface StatCardProps {
  icon: LucideIcon
  label: string
  value: string
  hint?: string
  accent?: boolean
  'data-testid'?: string
}

export function StatCard({ icon: Icon, label, value, hint, accent, ...rest }: StatCardProps) {
  return (
    <div
      className={`glass-card fade-up flex items-center gap-3.5 p-4 ${accent ? 'border-tesla/25' : ''}`}
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
        <div className="num mt-0.5 truncate text-lg font-semibold text-white" title={value}>
          {value}
        </div>
        {hint && <div className="mt-0.5 truncate text-[11px] text-slate-500">{hint}</div>}
      </div>
    </div>
  )
}
