import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useI18n } from '@/i18n'

export function Pagination({
  page,
  pageCount,
  onChange,
}: {
  page: number
  pageCount: number
  onChange: (page: number) => void
}) {
  const { t } = useI18n()
  if (pageCount <= 1) return null
  return (
    <nav className="flex items-center justify-center gap-1.5 pt-4" data-testid="pagination" aria-label={t('pagination.label', '分页')}>
      <button
        className="btn-ghost !px-3 !py-2"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        aria-label={t('pagination.prev', '上一页')}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      {Array.from({ length: pageCount }, (_, i) => i + 1)
        .filter((p) => p === 1 || p === pageCount || Math.abs(p - page) <= 1)
        .map((p, idx, arr) => (
          <span key={p} className="flex items-center">
            {idx > 0 && p - arr[idx - 1] > 1 && <span className="px-1.5 text-xs text-slate-500">…</span>}
            <button
              onClick={() => onChange(p)}
              aria-current={p === page ? 'page' : undefined}
              className={`page-btn ${p === page ? 'page-btn-active' : ''}`}
            >
              {p}
            </button>
          </span>
        ))}
      <button
        className="btn-ghost !px-3 !py-2"
        onClick={() => onChange(page + 1)}
        disabled={page >= pageCount}
        aria-label={t('pagination.next', '下一页')}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </nav>
  )
}
