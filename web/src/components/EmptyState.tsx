import type { LucideIcon } from 'lucide-react'
import { PackageOpen } from 'lucide-react'

export function EmptyState({
  icon: Icon = PackageOpen,
  title,
  description,
  action,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  /** 可选操作（如失败态重试） */
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center" data-testid="empty-state">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.05] text-slate-500">
        <Icon className="h-7 w-7" />
      </div>
      <div className="mt-1 text-sm font-medium text-slate-300">{title}</div>
      {description && <div className="max-w-xs text-xs leading-5 text-slate-500">{description}</div>}
      {action && (
        <button type="button" className="btn-mini mt-3" onClick={action.onClick} data-testid="empty-state-action">
          {action.label}
        </button>
      )}
    </div>
  )
}
