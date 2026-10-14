import { Loader2 } from 'lucide-react'

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return <Loader2 className={`animate-spin text-slate-400 ${className}`} aria-label="加载中" />
}

export function FullPageLoader() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center" data-testid="page-loader">
      <Spinner className="h-7 w-7" />
    </div>
  )
}
