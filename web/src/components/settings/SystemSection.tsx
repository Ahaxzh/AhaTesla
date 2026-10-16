/**
 * 系统状态分区（v2.2 从独立「系统」页并入设置页）。
 * 内容：服务状态（DB/MQTT/运行时长）· 只读安全盾 · 事件日志
 */
import { useQuery } from '@tanstack/react-query'
import { Database, HardDrive, Radio, ScrollText, ShieldCheck } from 'lucide-react'
import { api } from '@/api/client'
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

export function SystemSection() {
  const { data: status, isLoading } = useQuery({ queryKey: ['system-status-full'], queryFn: api.systemStatus, refetchInterval: 60_000 })
  const { data: events } = useQuery({ queryKey: ['events'], queryFn: () => api.systemEvents(50), refetchInterval: 30_000 })

  return (
    <div className="space-y-5">
      {/* 连接状态 */}
      <div className="grid gap-4 sm:grid-cols-3" data-testid="system-status">
        <div className="space-y-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <Database className="h-3.5 w-3.5" /> TeslaMate DB
          </div>
          <StatusDot ok={status?.teslamate.dbOk ?? false} label={status?.teslamate.dbOk ? 'PostgreSQL 正常' : '数据库断开'} />
          {status?.teslamate.latencyMs != null && (
            <div className="num text-[11px] text-slate-500" data-testid="db-latency">
              Ping 延迟 {status.teslamate.latencyMs}ms
            </div>
          )}
        </div>
        <div className="space-y-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <Radio className="h-3.5 w-3.5" /> Mosquitto MQTT
          </div>
          {status?.teslamate.mqtt ? (
            <StatusDot ok={status.teslamate.mqtt.ok} label={status.teslamate.mqtt.ok ? 'MQTT 正常' : 'MQTT 断开'} />
          ) : (
            <div className="text-sm text-slate-500">未配置（轮询基线）</div>
          )}
        </div>
        <div className="space-y-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
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
      </div>

      {/* 只读安全盾章 */}
      {status?.teslamate.readonlyVerified != null && (
        <div
          className={`flex items-center gap-3 rounded-xl border p-3.5 text-sm ${status.teslamate.readonlyVerified ? 'border-white/[0.06] bg-white/[0.02]' : '!border-red-400/30 bg-red-400/[0.06]'}`}
          data-testid="readonly-shield"
        >
          <ShieldCheck className={`h-5 w-5 ${status.teslamate.readonlyVerified ? 'text-emerald-400' : 'text-red-400'}`} />
          {status.teslamate.readonlyVerified ? (
            <span className="text-emerald-400">只读模式运行中（写入已强阻断）</span>
          ) : (
            <span className="text-red-400">⚠ 只读校验失败：当前数据库账号疑似具备写权限，请检查账号配置</span>
          )}
        </div>
      )}

      {/* 事件日志 */}
      <div className="overflow-hidden rounded-xl border border-white/[0.06]" data-testid="event-log">
        <div className="flex items-center gap-2 px-4 py-3">
          <ScrollText className="h-4 w-4 text-tesla" />
          <span className="text-xs font-medium text-slate-200">事件日志</span>
          <span className="num rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] text-slate-400">
            {events?.length ?? 0} 条
          </span>
        </div>
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="skeleton h-12" />
            ))}
          </div>
        ) : !events || events.length === 0 ? (
          <EmptyState icon={ScrollText} title="暂无事件" description="推送记录与错误会显示在这里" />
        ) : (
          <ul className="max-h-[420px] divide-y divide-white/[0.04] overflow-y-auto" data-testid="event-list">
            {events.map((ev) => (
              <li key={ev.id ?? ev.at} className="flex items-start gap-3 px-4 py-2.5">
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
      </div>
    </div>
  )
}
