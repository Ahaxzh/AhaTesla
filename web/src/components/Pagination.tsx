import { ChevronLeft, ChevronRight } from 'lucide-react'

export function Pagination({
  page,
  pageCount,
  onChange,
}: {
  page: number
  pageCount: number
  onChange: (page: number) => void
}) {
  if (pageCount <= 1) return null
  return (
    <nav className="flex items-center justify-center gap-1.5 pt-4" data-testid="pagination" aria-label="分页">
      <button
        className="btn-ghost !px-3 !py-2"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        aria-label="上一页"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      {Array.from({ length: pageCount }, (_, i) => i + 1)
        .filter((p) => p === 1 || p === pageCount || Math.abs(p - page) <= 1)
        .map((p, idx, arr) => (
          <span key={p} className="flex items-center">
            {idx > 0 && p - arr[idx - 1] > 1 && <span className="px-1.5 text-xs text-slate-600">…</span>}
            <button
              onClick={() => onChange(p)}
              aria-current={p === page ? 'page' : undefined}
              className={`num h-9 min-w-9 rounded-lg px-2 text-sm transition ${
                p === page
                  ? 'bg-tesla font-semibold text-white'
                  : 'text-slate-400 hover:bg-white/[0.06] hover:text-slate-200'
              }`}
            >
              {p}
            </button>
          </span>
        ))}
      <button
        className="btn-ghost !px-3 !py-2"
        onClick={() => onChange(page + 1)}
        disabled={page >= pageCount}
        aria-label="下一页"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </nav>
  )
}
