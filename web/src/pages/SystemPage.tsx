import { useQuery } from '@tanstack/react-query'
import { Activity, Database, HardDrive, Radio, ScrollText } from 'lucide-react'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { fmtDateTime, timeAgo } from '@/utils/format'
import type { SystemEvent } from '@/types'

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-2 text-sm">
      <span className="relative flex h-2.5 w-2.5">
        {ok && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        )}
        <span
          className={`relative inline-flex h-2.5 w-2.5 rounded-full ${ok ? 'bg-emerald-400' : 'bg-tesla'}`}
          data-testid={`status-dot-${label}`}
        />
      </span>
      <span className={ok ? 'text-slate-200' : 'text-tesla-soft'}>{label}</span>
    </span>
  )
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  return `${m} 分钟`
}

const levelStyle: Record<SystemEvent['level'], string> = {
  info: 'text-slate-400 bg-white/[0.05]',
  warn: 'text-amber-400 bg-amber-400/10',
  error: 'text-tesla-soft bg-tesla/10',
}

export default function SystemPage() {
  const { data: status } = useQuery({
    queryKey: ['system-status'],
    queryFn: api.systemStatus,
    refetchInterval: 30_000,
  })
  const { data: events, isLoading } = useQuery({
    queryKey: ['system-events'],
    queryFn: () => api.systemEvents(100),
  })

  return (
    <div>
      <PageHeader icon={Activity} title="系统" subtitle="运行状态与事件日志" />

      {/* 连接状态 */}
      <section className="glass-card mb-4 grid gap-4 p-5 sm:grid-cols-3" data-testid="system-status">
        <div className="space-y-2.5">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <Database className="h-3.5 w-3.5" /> TeslaMate DB
          </div>
          <StatusDot ok={status?.teslamate.dbOk ?? false} label={status?.teslamate.dbOk ? 'PostgreSQL 正常' : '数据库断开'} />
        </div>
        <div className="space-y-2.5">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <Radio className="h-3.5 w-3.5" /> Mosquitto MQTT
          </div>
          {/* AC-5.1/§7.1：MQTT 为可选增强，仅在已配置（后端返回 teslamate.mqtt）时显示 */}
          {status?.teslamate.mqtt ? (
            <StatusDot ok={status.teslamate.mqtt.ok} label={status.teslamate.mqtt.ok ? 'MQTT 正常' : 'MQTT 断开'} />
          ) : (
            <div className="text-sm text-slate-500">未配置（轮询基线）</div>
          )}
        </div>
        <div className="space-y-2.5">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <HardDrive className="h-3.5 w-3.5" /> 服务
          </div>
          <div className="text-sm text-slate-200">
            运行 <span className="num">{status ? fmtUptime(status.uptime) : '--'}</span>
          </div>
          <div className="num text-xs text-slate-500">
            v{status?.version ?? '--'} · 最近行车 {status ? timeAgo(status.teslamate.lastDriveAt) : '--'}
          </div>
        </div>
      </section>

      {/* 事件日志 */}
      <section className="glass-card overflow-hidden p-0" data-testid="event-log">
        <div className="flex items-center gap-2 px-5 py-4">
          <ScrollText className="h-4 w-4 text-tesla" />
          <h2 className="text-sm font-medium text-slate-200">事件日志</h2>
          <span className="num rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] text-slate-400">
            {events?.length ?? 0} 条
          </span>
        </div>
        {isLoading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="skeleton h-12" />
            ))}
          </div>
        ) : !events || events.length === 0 ? (
          <EmptyState icon={ScrollText} title="暂无事件" description="推送记录与错误会显示在这里" />
        ) : (
          <ul className="max-h-[480px] divide-y divide-white/[0.04] overflow-y-auto" data-testid="event-list">
            {events.map((ev) => (
              <li key={ev.id} className="flex items-start gap-3 px-5 py-3">
                <span className={`num shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase ${levelStyle[ev.level as keyof typeof levelStyle] ?? levelStyle.info}`}>
                  {ev.level}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-slate-200">{ev.message}</div>
                  <div className="num mt-0.5 text-[10px] text-slate-500">
                    {ev.type} · {fmtDateTime(ev.at)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
