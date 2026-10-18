/**
 * 系统状态分区（v2.2 从独立「系统」页并入设置页；v2.4 按 Uptime Kuma 式状态面板重设计）。
 * 结构：整体状态总览横幅（版本 pill）· 状态瓦片 ×3（DB 延迟 / MQTT / 服务运行时长）·
 * 只读安全盾 · 事件日志（等级筛选 chips + 色点 + 相对时间）
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Database, HardDrive, Radio, ScrollText, ShieldCheck } from 'lucide-react'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { fmtDateTime, timeAgo } from '@/utils/format'
import type { SystemEvent } from '@/types'

/** 状态点 + 文案行（保留 status-dot-{label} 语义供测试定位） */
function StatusDot({ ok, label, loading }: { ok: boolean; label: string; loading?: boolean }) {
  // loading=true 显示中性灰点，避免首帧误报"断开"
  return (
    <span className="flex items-center gap-2 text-[13px]">
      <span className="relative flex h-2 w-2">
        {ok && !loading && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        )}
        <span
          className={`relative inline-flex h-2 w-2 rounded-full ${loading ? 'bg-slate-600' : ok ? 'bg-emerald-400' : 'bg-tesla'}`}
          data-testid={`status-dot-${label}`}
        />
      </span>
      <span className={loading ? 'text-slate-400' : ok ? 'text-slate-200' : 'text-tesla-soft'}>
        {loading ? '检测中…' : label}
      </span>
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

/** 状态瓦片头部的小 pill */
function Pill({ tone, children }: { tone: 'ok' | 'bad' | 'neutral'; children: string }) {
  const cls =
    tone === 'ok'
      ? 'bg-emerald-400/10 text-emerald-400'
      : tone === 'bad'
        ? 'bg-tesla/10 text-tesla-soft'
        : 'bg-white/[0.06] text-slate-400'
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>{children}</span>
}

/** 事件等级 → 色点/筛选标签 */
const LEVEL_META: Record<SystemEvent['level'], { dot: string; label: string }> = {
  info: { dot: 'bg-slate-400', label: '信息' },
  warn: { dot: 'bg-amber-400', label: '警告' },
  error: { dot: 'bg-tesla', label: '错误' },
}
type LevelFilter = 'all' | SystemEvent['level']

export function SystemSection() {
  const { data: status, isLoading } = useQuery({ queryKey: ['system-status-full'], queryFn: api.systemStatus, refetchInterval: 60_000 })
  const { data: events, isLoading: eventsLoading } = useQuery({ queryKey: ['events'], queryFn: () => api.systemEvents(50), refetchInterval: 30_000 })

  // ---- 整体健康判定（MQTT 未配置视为正常基线） ----
  const mqtt = status?.teslamate.mqtt
  const mqttConfigured = mqtt != null
  const faults: string[] = []
  if (status && !status.teslamate.dbOk) faults.push('数据库断开')
  if (mqtt && !mqtt.ok) faults.push('MQTT 断开')

  // ---- 事件筛选 ----
  const [filter, setFilter] = useState<LevelFilter>('all')
  const filtered = filter === 'all' ? events : events?.filter((e) => e.level === filter)

  return (
    <div className="space-y-5">
      {/* 整体状态总览横幅 */}
      <div
        data-testid="system-overview"
        className={`flex items-center justify-between gap-3 rounded-xl border p-3.5 ${
          isLoading || !status
            ? 'border-white/[0.06] bg-white/[0.02]'
            : faults.length === 0
              ? 'border-emerald-400/20 bg-emerald-400/[0.06]'
              : status.teslamate.dbOk
                ? 'border-amber-400/25 bg-amber-400/[0.06]'
                : 'border-tesla/25 bg-tesla/[0.06]'
        }`}
      >
        <div className="flex min-w-0 items-center gap-3">
          {isLoading || !status ? (
            <div className="skeleton h-5 w-40" />
          ) : faults.length === 0 ? (
            <>
              <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-emerald-400">全部系统正常运行</div>
                <div className="mt-0.5 text-[11px] text-slate-400">数据源与推送服务工作正常</div>
              </div>
            </>
          ) : (
            <>
              <AlertTriangle className={`h-5 w-5 shrink-0 ${status.teslamate.dbOk ? 'text-amber-400' : 'text-tesla-soft'}`} />
              <div className="min-w-0">
                <div className={`text-sm font-medium ${status.teslamate.dbOk ? 'text-amber-400' : 'text-tesla-soft'}`}>
                  {faults.join(' · ')}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">请检查对应服务与凭据配置</div>
              </div>
            </>
          )}
        </div>
        <span className="num shrink-0 rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[11px] text-slate-300">
          v{status?.version ?? '--'}
        </span>
      </div>

      {/* 状态瓦片 ×3 */}
      <div className="grid gap-4 sm:grid-cols-3" data-testid="system-status">
        {/* TeslaMate DB */}
        <div className="space-y-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
              <Database className="h-3.5 w-3.5" /> TeslaMate DB
            </div>
            {isLoading ? <Pill tone="neutral">--</Pill> : <Pill tone={status?.teslamate.dbOk ? 'ok' : 'bad'}>{status?.teslamate.dbOk ? '正常' : '断开'}</Pill>}
          </div>
          {isLoading ? (
            <div className="skeleton h-8 w-24" />
          ) : (
            <div className="flex items-baseline gap-1.5" data-testid="db-latency">
              <span className="num text-2xl font-semibold text-white">{status?.teslamate.latencyMs ?? '--'}</span>
              <span className="text-xs text-slate-500">ms Ping 延迟</span>
            </div>
          )}
          <StatusDot
            ok={status?.teslamate.dbOk ?? false}
            loading={!status}
            label={status?.teslamate.dbOk ? 'PostgreSQL 正常' : '数据库断开'}
          />
        </div>

        {/* Mosquitto MQTT（可选增强，未配置走轮询基线） */}
        <div className="space-y-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
              <Radio className="h-3.5 w-3.5" /> Mosquitto MQTT
            </div>
            {isLoading ? (
              <Pill tone="neutral">--</Pill>
            ) : mqttConfigured ? (
              <Pill tone={mqtt.ok ? 'ok' : 'bad'}>{mqtt.ok ? '正常' : '断开'}</Pill>
            ) : (
              <Pill tone="neutral">未配置</Pill>
            )}
          </div>
          {isLoading ? (
            <div className="skeleton h-8 w-24" />
          ) : mqttConfigured ? (
            <StatusDot ok={mqtt.ok} label={mqtt.ok ? 'MQTT 正常' : 'MQTT 断开'} />
          ) : (
            <div className="text-sm text-slate-300">未配置（轮询基线）</div>
          )}
        </div>

        {/* 服务本体 */}
        <div className="space-y-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
              <HardDrive className="h-3.5 w-3.5" /> 服务
            </div>
            <Pill tone="ok">运行中</Pill>
          </div>
          {isLoading ? (
            <div className="skeleton h-8 w-28" />
          ) : (
            <div className="num text-2xl font-semibold text-white">{status ? fmtUptime(status.uptime) : '--'}</div>
          )}
          <div className="text-[11px] text-slate-500">最近行车 {status ? timeAgo(status.teslamate.lastDriveAt) : '--'}</div>
        </div>
      </div>

      {/* 只读安全盾章 */}
      {status?.teslamate.readonlyVerified != null && (
        <div
          className={`flex items-center gap-2.5 rounded-xl border p-3.5 text-xs ${status.teslamate.readonlyVerified ? 'border-white/[0.06] bg-white/[0.02]' : '!border-tesla/30 bg-tesla/[0.06]'}`}
          data-testid="readonly-shield"
        >
          <ShieldCheck className={`h-5 w-5 shrink-0 ${status.teslamate.readonlyVerified ? 'text-emerald-400' : 'text-tesla-soft'}`} />
          {status.teslamate.readonlyVerified ? (
            <span className="text-emerald-400">只读模式运行中（写入已强阻断）</span>
          ) : (
            <span className="text-tesla-soft">⚠ 只读校验失败：当前数据库账号疑似具备写权限，请检查账号配置</span>
          )}
        </div>
      )}

      {/* 事件日志 */}
      <div className="overflow-hidden rounded-xl border border-white/[0.06]" data-testid="event-log">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <ScrollText className="h-4 w-4 text-tesla" />
          <span className="text-xs font-medium text-slate-200">事件日志</span>
          <span className="num rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] text-slate-400">
            {filtered ? `${filtered.length} 条` : '—'}
          </span>
          {/* 等级筛选 chips */}
          <div className="ml-auto flex gap-1" data-testid="event-filter">
            {(['all', 'info', 'warn', 'error'] as const).map((lv) => (
              <button
                key={lv}
                onClick={() => setFilter(lv)}
                aria-pressed={filter === lv}
                data-testid={`event-filter-${lv}`}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                  filter === lv
                    ? 'bg-white/[0.08] text-white shadow-[0_1px_2px_rgba(0,0,0,0.3)]'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {lv === 'all' ? '全部' : LEVEL_META[lv].label}
              </button>
            ))}
          </div>
        </div>
        {eventsLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="skeleton h-10" />
            ))}
          </div>
        ) : !filtered || filtered.length === 0 ? (
          filter === 'all' ? (
            <EmptyState icon={ScrollText} title="暂无事件" description="推送记录与错误会显示在这里" />
          ) : (
            <EmptyState icon={ScrollText} title={`没有${LEVEL_META[filter].label}级事件`} description="试试切回「全部」" />
          )
        ) : (
          <ul className="max-h-[420px] divide-y divide-white/[0.04] overflow-y-auto" data-testid="event-list">
            {filtered.map((ev) => (
              <li key={ev.id ?? ev.at} className="flex items-start gap-3 px-4 py-2.5">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${LEVEL_META[ev.level as keyof typeof LEVEL_META]?.dot ?? LEVEL_META.info.dot}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-slate-200">{ev.message}</div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[10px] uppercase text-slate-500">{ev.level}</span>
                    <span className="text-[10px] text-slate-500">{ev.type}</span>
                  </div>
                </div>
                <span className="num shrink-0 text-[10px] text-slate-500" title={fmtDateTime(ev.at)}>
                  {timeAgo(ev.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
