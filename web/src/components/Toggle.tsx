import type { ReactNode } from 'react'

interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
  'aria-label'?: string
}

export function Toggle({ checked, onChange, disabled, label, ...rest }: ToggleProps) {
  const ariaLabel = rest['aria-label'] ?? label
  const handle = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      data-state={checked ? 'checked' : 'unchecked'}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tesla/70 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'border-tesla/60 bg-tesla' : 'border-white/10 bg-white/[0.08]'
      }`}
    >
      <span
        className={`inline-block h-4.5 h-[18px] w-4.5 w-[18px] transform rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? 'translate-x-[22px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  )
  if (!label) return handle
  return (
    <label className="flex cursor-pointer items-center gap-3" data-testid="toggle-row">
      {handle}
      <span className="text-sm text-slate-200">{label}</span>
    </label>
  )
}

interface ToggleRowProps {
  title: ReactNode
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

export function ToggleRow({ title, description, checked, onChange, disabled }: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-3.5">
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-100">{title}</div>
        {description && <div className="mt-0.5 text-xs leading-5 text-slate-500">{description}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} aria-label={typeof title === 'string' ? title : undefined} />
    </div>
  )
}
