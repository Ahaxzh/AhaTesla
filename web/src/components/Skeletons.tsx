export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2.5" data-testid="skeleton-list" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="glass-card-flat flex items-center gap-4 p-4">
          <div className="skeleton h-10 w-10 rounded-xl" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3.5 w-2/5" />
            <div className="skeleton h-3 w-3/5" />
          </div>
          <div className="skeleton h-5 w-16" />
        </div>
      ))}
    </div>
  )
}

export function SkeletonCards({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="skeleton-cards" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="glass-card-flat space-y-3 p-4">
          <div className="skeleton h-3 w-1/2" />
          <div className="skeleton h-6 w-2/3" />
        </div>
      ))}
    </div>
  )
}
