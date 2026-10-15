import { useState } from 'react'
import type { TimelineData } from '@/types'

/**
 * P2 模块2【Grafana Timeline 提炼】24 小时状态时间轴。
 * 彩色胶囊时间条（类 iOS 屏幕使用时间）：行驶蓝/充电绿/哨兵橙/睡眠紫/离线灰。
 * 触控色块 → Tooltip；底部 24h 占比汇总。
 */
const STATE_META: Record<string, { label: string; color: string; bar: string }> = {
  driving: { label: '行驶', color: 'text-sky-400', bar: 'bg-sky-500' },
  charging: { label: '充电', color: 'text-emerald-400', bar: 'bg-emerald-500' },
  online: { label: '哨兵/在线', color: 'text-amber-400', bar: 'bg-amber-500' },
  asleep: { label: '睡眠', color: 'text-violet-400', bar: 'bg-violet-500' },
  offline: { label: '离线', color: 'text-slate-500', bar: 'bg-slate-600' },
}

function hhmm(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

export function Timeline24h({ data }: { data: TimelineData }) {
  const [active, setActive] = useState<number | null>(null)
  const windowStart = Date.now() - data.windowHours * 3600_000
  const windowEnd = Date.now()
  const span = windowEnd - windowStart

  const seg = active != null ? data.segments[active] : null
  const s = seg ? STATE_META[seg.state] : null
  const summary = data.summary

  return (
    <section className="glass-card p-5" data-testid="timeline-card">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-200">24 小时状态</h2>
        <span className="text-[11px] text-slate-500">最近 {data.windowHours} 小时</span>
      </div>
      <p className="mb-4 text-xs text-slate-500">行驶 · 充电 · 哨兵 · 睡眠 的时间分布</p>

      {/* 时间轴条 */}
      <div className="relative" data-testid="timeline-bar">
        <div className="flex h-8 w-full gap-[2px] overflow-hidden rounded-lg">
          {data.segments.map((segment, i) => {
            const leftPct = ((new Date(segment.from).getTime() - windowStart) / span) * 100
            const widthPct = Math.max(
              ((new Date(segment.to).getTime() - new Date(segment.from).getTime()) / span) * 100,
              0.3,
            )
            const meta = STATE_META[segment.state]
            return (
              <button
                key={i}
                className="group relative h-full cursor-pointer"
                style={{ width: `${widthPct}%`, minWidth: 2, marginLeft: i === 0 ? `${leftPct}%` : undefined }}
                aria-label={`${meta.label} ${hhmm(segment.from)} 至 ${hhmm(segment.to)}`}
                data-testid={`timeline-seg-${segment.state}`}
                data-active={active === i}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onClick={() => setActive(active === i ? null : i)}
              >
                <span className={`block h-full w-full rounded-[3px] ${meta.bar} ${active === i ? 'opacity-100' : 'opacity-75'}`} />
              </button>
            )
          })}
        </div>
        {/* 小时刻度 */}
        <div className="mt-1.5 flex justify-between text-[10px] text-slate-600">
          <span>{hhmm(new Date(windowStart).toISOString())}</span>
          <span>{hhmm(new Date(windowStart + span / 2).toISOString())}</span>
          <span>现在</span>
        </div>

        {/* Tooltip（触控/悬停） */}
        {seg && s && (
          <div
            className="pointer-events-none absolute -top-2 left-1/2 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-white/10 bg-base-900/95 px-3 py-2 text-xs shadow-lg"
            data-testid="timeline-tooltip"
            role="tooltip"
          >
            <span className={`font-medium ${s.color}`}>{s.label}</span>
            <span className="num ml-2 text-slate-300">
              {hhmm(seg.from)}~{hhmm(seg.to)}
            </span>
            <span className="num ml-2 text-slate-400">
              {((new Date(seg.to).getTime() - new Date(seg.from).getTime()) / 60000).toFixed(0)} 分钟
            </span>
          </div>
        )}
      </div>

      {/* 底部汇总 */}
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px]" data-testid="timeline-summary">
        {(['driving', 'charging', 'online', 'asleep', 'offline'] as const).map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-sm ${STATE_META[k].bar}`} />
            <span className={STATE_META[k].color}>{STATE_META[k].label}</span>
            <span className="num text-slate-400">{summary[`${k}H` as keyof typeof summary]?.toFixed?.(1) ?? 0}h</span>
          </span>
        ))}
      </div>
    </section>
  )
}
