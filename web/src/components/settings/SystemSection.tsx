/**
 * 系统状态分区（v2.2 从独立「系统」页并入设置页；v2.4 按 Uptime Kuma 式状态面板重设计）。
 * 结构：整体状态总览横幅（版本 pill）· 状态瓦片 ×3（DB 延迟 / MQTT / 服务运行时长）·
 * 只读安全盾 · 事件日志（等级筛选 chips + 色点 + 相对时间）
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Database, HardDrive, MapPin, Radio, ScrollText, ShieldCheck } from 'lucide-react'
import { useToast } from '@/components/Toast'
import { Toggle } from '@/components/Toggle'
import { useI18n } from '@/i18n'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { fmtDateTime, getUiLang, timeAgo } from '@/utils/format'
import type { SystemEvent } from '@/types'

/** 状态点 + 文案行（保留 status-dot-{label} 语义供测试定位） */
function StatusDot({ ok, label, loading }: { ok: boolean; label: string; loading?: boolean }) {
  const { t } = useI18n()
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
        {loading ? t('system.detecting', '检测中…') : label}
      </span>
    </span>
  )
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const en = getUiLang() === 'en'
  if (d > 0) return en ? `${d}d ${h}h` : `${d} 天 ${h} 小时`
  if (h > 0) return en ? `${h}h ${m}m` : `${h} 小时 ${m} 分`
  return en ? `${m}m` : `${m} 分钟`
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

/** 事件等级 → 色点/筛选标签（key 交给调用点 t() 双语） */
const LEVEL_META: Record<SystemEvent['level'], { dot: string; key: string; label: string }> = {
  info: { dot: 'bg-slate-400', key: 'system.level.info', label: '信息' },
  warn: { dot: 'bg-amber-400', key: 'system.level.warn', label: '警告' },
  error: { dot: 'bg-tesla', key: 'system.level.error', label: '错误' },
}
type LevelFilter = 'all' | SystemEvent['level']

export function SystemSection() {
  const { toast } = useToast()
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data: status, isLoading } = useQuery({ queryKey: ['system-status-full'], queryFn: api.systemStatus, refetchInterval: 60_000 })
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings, retry: false })

  // ---- 地点识别（可选高德逆地理,默认关） ----
  const [geoEnabled, setGeoEnabled] = useState(false)
  const [geoKey, setGeoKey] = useState('')
  useEffect(() => {
    setGeoEnabled(Boolean(settings?.geocoding?.enabled))
  }, [settings?.geocoding?.enabled])
  const saveGeo = useMutation({
    mutationFn: () => api.saveSettings({ geocoding: { enabled: geoEnabled, ...(geoKey.trim() ? { amapKey: geoKey.trim() } : {}) } }),
    onSuccess: () => {
      toast(t('settings.geo.saved', '地点识别设置已保存'), 'success')
      setGeoKey('')
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
      void queryClient.invalidateQueries({ queryKey: ['trips'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })
  const { data: events, isLoading: eventsLoading } = useQuery({ queryKey: ['events'], queryFn: () => api.systemEvents(50), refetchInterval: 30_000 })

  // ---- 整体健康判定（MQTT 未配置视为正常基线） ----
  const mqtt = status?.teslamate.mqtt
  const mqttConfigured = mqtt != null
  const faults: string[] = []
  if (status && !status.teslamate.dbOk) faults.push(t('system.dbDown', '数据库断开'))
  if (mqtt && !mqtt.ok) faults.push(t('system.mqttDown', 'MQTT 断开'))

  // ---- 事件筛选 ----
  const [filter, setFilter] = useState<LevelFilter>('all')
  const filtered = filter === 'all' ? events : events?.filter((e) => e.level === filter)

  return (
    <div className="space-y-5">
      {/* ===== 地点识别（可选高德逆地理,默认关） ===== */}
      <div className="glass-card-flat p-4" data-testid="settings-geocoding">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <MapPin className="h-4 w-4 shrink-0 text-tesla" />
            <span className="truncate text-[13px] font-medium text-slate-200">{t('settings.geo.title', '地点识别（未知点位地名）')}</span>
            {settings?.geocoding?.hasKey ? (
              <span className="rounded-full bg-emerald-400/10 px-1.5 py-0.5 text-[10px] text-emerald-400">Key ····{settings.geocoding.keyAlias ?? '****'}</span>
            ) : null}
          </div>
          <Toggle checked={geoEnabled} onChange={setGeoEnabled} aria-label={t('settings.geo.title', '地点识别')} />
        </div>
        <p className="mt-2 text-[11px] leading-5 text-slate-500">
          {t('settings.geo.desc', '起终点不在任何围栏 1.5km 内时，将坐标（WGS84→GCJ02 纠偏后）发送高德逆地理服务换取地名（如"山姆会员商店"），结果本地缓存。默认关闭；开启即视为你授权该坐标外发。')}
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="password"
            className="input-dark flex-1"
            placeholder={settings?.geocoding?.hasKey ? t('settings.geo.keyKeep', '已保存（留空保持不变）') : t('settings.geo.keyPlaceholder', '高德 Web 服务 Key（lbs.amap.com 免费申请）')}
            value={geoKey}
            onChange={(e) => setGeoKey(e.target.value)}
            data-testid="geocoding-key"
            autoComplete="off"
          />
          <button
            type="button"
            className="btn-primary px-4"
            disabled={saveGeo.isPending}
            onClick={() => saveGeo.mutate()}
            data-testid="geocoding-save"
          >
            {saveGeo.isPending ? t('common.working', '处理中…') : t('common.save', '保存')}
          </button>
        </div>
        {geoEnabled && !settings?.geocoding?.hasKey && !geoKey.trim() ? (
          <p className="mt-2 text-[11px] text-amber-400">{t('settings.geo.needKey', '开启需要先填入高德 Key，否则不会生效')}</p>
        ) : null}
      </div>

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
                <div className="text-sm font-medium text-emerald-400">{t('system.allOk', '全部系统正常运行')}</div>
                <div className="mt-0.5 text-[11px] text-slate-400">{t('system.allOkDesc', '数据源与推送服务工作正常')}</div>
              </div>
            </>
          ) : (
            <>
              <AlertTriangle className={`h-5 w-5 shrink-0 ${status.teslamate.dbOk ? 'text-amber-400' : 'text-tesla-soft'}`} />
              <div className="min-w-0">
                <div className={`text-sm font-medium ${status.teslamate.dbOk ? 'text-amber-400' : 'text-tesla-soft'}`}>
                  {faults.join(' · ')}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">{t('system.faultDesc', '请检查对应服务与凭据配置')}</div>
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
            {isLoading ? <Pill tone="neutral">--</Pill> : <Pill tone={status?.teslamate.dbOk ? 'ok' : 'bad'}>{status?.teslamate.dbOk ? t('system.ok', '正常') : t('system.down', '断开')}</Pill>}
          </div>
          {isLoading ? (
            <div className="skeleton h-8 w-24" />
          ) : (
            <div className="flex items-baseline gap-1.5" data-testid="db-latency">
              <span className="num text-2xl font-semibold text-white">{status?.teslamate.latencyMs ?? '--'}</span>
              <span className="text-xs text-slate-500">{t('system.pingLatency', 'ms Ping 延迟')}</span>
            </div>
          )}
          <StatusDot
            ok={status?.teslamate.dbOk ?? false}
            loading={!status}
            label={status?.teslamate.dbOk ? t('system.pgOk', 'PostgreSQL 正常') : t('system.dbDown', '数据库断开')}
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
              <Pill tone={mqtt.ok ? 'ok' : 'bad'}>{mqtt.ok ? t('system.ok', '正常') : t('system.down', '断开')}</Pill>
            ) : (
              <Pill tone="neutral">{t('system.notConfigured', '未配置')}</Pill>
            )}
          </div>
          {isLoading ? (
            <div className="skeleton h-8 w-24" />
          ) : mqttConfigured ? (
            <StatusDot ok={mqtt.ok} label={mqtt.ok ? t('system.mqttOk', 'MQTT 正常') : t('system.mqttDown', 'MQTT 断开')} />
          ) : (
            <div className="text-sm text-slate-300">{t('system.pollingBaseline', '未配置（轮询基线）')}</div>
          )}
        </div>

        {/* 服务本体 */}
        <div className="space-y-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
              <HardDrive className="h-3.5 w-3.5" /> {t('system.service', '服务')}
            </div>
            <Pill tone="ok">{t('system.running', '运行中')}</Pill>
          </div>
          {isLoading ? (
            <div className="skeleton h-8 w-28" />
          ) : (
            <div className="num text-2xl font-semibold text-white">{status ? fmtUptime(status.uptime) : '--'}</div>
          )}
          <div className="text-[11px] text-slate-500">{t('system.lastDrive', '最近行车')} {status ? timeAgo(status.teslamate.lastDriveAt) : '--'}</div>
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
            <span className="text-emerald-400">{t('system.readonlyOk', '只读模式运行中（写入已强阻断）')}</span>
          ) : (
            <span className="text-tesla-soft">{t('system.readonlyBad', '⚠ 只读校验失败：当前数据库账号疑似具备写权限，请检查账号配置')}</span>
          )}
        </div>
      )}

      {/* 事件日志 */}
      <div className="overflow-hidden rounded-xl border border-white/[0.06]" data-testid="event-log">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <ScrollText className="h-4 w-4 text-tesla" />
          <span className="text-xs font-medium text-slate-200">{t('system.eventLog', '事件日志')}</span>
          <span className="num rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] text-slate-400">
            {filtered ? t('system.eventCount', '{n} 条').replace('{n}', String(filtered.length)) : '—'}
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
                {lv === 'all' ? t('system.filterAll', '全部') : t(LEVEL_META[lv].key, LEVEL_META[lv].label)}
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
            <EmptyState icon={ScrollText} title={t('system.noEvents', '暂无事件')} description={t('system.noEventsDesc', '推送记录与错误会显示在这里')} />
          ) : (
            <EmptyState
              icon={ScrollText}
              title={t('system.noLevelEvents', '没有{lv}级事件').replace('{lv}', t(LEVEL_META[filter].key, LEVEL_META[filter].label))}
              description={t('system.tryAll', '试试切回「全部」')}
            />
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
