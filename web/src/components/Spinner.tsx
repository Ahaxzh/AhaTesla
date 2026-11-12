import { Loader2 } from 'lucide-react'
import { useI18n } from '@/i18n'

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  const { t } = useI18n()
  return <Loader2 className={`animate-spin text-slate-400 ${className}`} aria-label={t('common.loading', '加载中')} />
}

export function FullPageLoader() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center" data-testid="page-loader">
      <Spinner className="h-7 w-7" />
    </div>
  )
}
