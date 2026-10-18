import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'

type ToastKind = 'success' | 'error' | 'info'
interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

interface ToastCtx {
  toast: (message: string, kind?: ToastKind) => void
}

const ToastContext = createContext<ToastCtx | null>(null)

let nextId = 1

const icons = {
  success: <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />,
  error: <AlertTriangle className="h-4 w-4 shrink-0 text-tesla" />,
  info: <Info className="h-4 w-4 shrink-0 text-sky-400" />,
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])

  const toast = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = nextId++
    // 栈上限 3：错误突发时只保留最新的（AppLayout 会把每次失败查询都 toast）
    setItems((prev) => [...prev, { id, kind, message }].slice(-3))
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id))
    }, 3500)
  }, [])

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        data-testid="toast-root"
        className="pointer-events-none fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-[100] flex flex-col items-center gap-2 px-4"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className={`glass-card fade-up pointer-events-auto flex w-full max-w-sm items-center gap-2.5 px-4 py-3 text-sm text-slate-100 ${
              t.kind === 'error' ? 'border-tesla/40' : ''
            }`}
          >
            {icons[t.kind]}
            <span className="flex-1">{t.message}</span>
            <button
              aria-label="关闭提示"
              className="-mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-200"
              onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastCtx {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast 必须在 ToastProvider 内使用')
  return ctx
}
