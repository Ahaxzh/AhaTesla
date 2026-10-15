import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  BellRing,
  Calculator,
  Database,
  KeyRound,
  LogOut,
  RefreshCw,
  Save,
  Settings as SettingsIcon,
  ShieldCheck,

} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { api } from '@/api/client'
import { useToast } from '@/components/Toast'
import { Toggle } from '@/components/Toggle'
import type { PushEventId, PushChannelId } from '@/types'

const CURRENCIES = [
  { symbol: '¥', code: 'CNY', label: '¥ 人民币' },
  { symbol: '$', code: 'USD', label: '$ 美元' },
  { symbol: '€', code: 'EUR', label: '€ 欧元' },
  { symbol: '£', code: 'GBP', label: '£ 英镑' },
]

const EVENTS: { id: PushEventId; label: string; desc: string }[] = [
  { id: 'tripEnd', label: '行程结束小结', desc: '每次行程结束推送费用与路线概要' },
  { id: 'chargingStart', label: '充电开始提醒', desc: '插入充电枪开始充电时' },
  { id: 'chargingDone', label: '充电完成账单', desc: '充电结束推送电量与费用' },
  { id: 'weekly', label: '每周周报', desc: '每周一 08:00 汇总上周' },
  { id: 'monthly', label: '每月月报', desc: '每月 1 日 08:00 汇总上月' },
]
const CHANNELS: { id: PushChannelId; label: string }[] = [
  { id: 'webpush', label: 'Web Push' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'feishu', label: '飞书' },
]

/** 设置页分区导航（桌面侧栏锚点 / 移动横向滚动） */
function SettingsNav({ active }: { active: string }) {
  const items = [
    { id: 'datasource', label: '数据与账本', icon: Database },
    { id: 'push', label: '推送', icon: BellRing },
    { id: 'security', label: '账户安全', icon: KeyRound },
  ]
  return (
    <nav className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0" data-testid="settings-nav">
      {items.map(({ id, label, icon: Icon }) => (
        <a
          key={id}
          href={`#settings-${id}`}
          className={`flex shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[13px] font-medium transition ${
            active === id
              ? 'bg-white/[0.06] text-white shadow-[0_1px_2px_rgba(0,0,0,0.3)]'
              : 'text-slate-400 hover:bg-white/[0.03] hover:text-slate-200'
          }`}
        >
          <Icon className={`h-4 w-4 ${active === id ? 'text-tesla' : 'text-slate-500'}`} />
          {label}
        </a>
      ))}
    </nav>
  )
}

export default function SettingsPage() {
  const { user, logout } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [activeSection, setActiveSection] = useState('datasource')

  // 滚动监听高亮当前分区（IntersectionObserver 不可用时静默降级）
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const ids = ['datasource', 'ledger', 'push', 'security']
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActiveSection(e.target.id.replace('settings-', ''))
        }
      },
      { rootMargin: '-30% 0px -60% 0px' },
    )
    ids.forEach((id) => {
      const el = document.getElementById(`settings-${id}`)
      if (el) obs.observe(el)
    })
    return () => obs.disconnect()
  }, [])

  // ---- 分组1：数据源健康 ----
  const { data: sys, refetch: refetchSys } = useQuery({
    queryKey: ['system-status'],
    queryFn: api.systemStatus,
    refetchInterval: 60_000,
  })

  // ---- 分组2：账本参数 ----
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const { data: pricing } = useQuery({ queryKey: ['pricing'], queryFn: api.pricing })

  const [currency, setCurrency] = useState('¥')
  const [distanceUnit, setDistanceUnit] = useState<'km' | 'mi'>('km')
  const [liter, setLiter] = useState('8.0')
  const [fuelPrice, setFuelPrice] = useState('8.20')
  const [touGeofence, setTouGeofence] = useState<number | null>(null)
  const [touMode, setTouMode] = useState(false)
  const [touOffPeakStart, setTouOffPeakStart] = useState('23:00')
  const [touOffPeakEnd, setTouOffPeakEnd] = useState('07:00')
  const [touOffPeakRate, setTouOffPeakRate] = useState('0.30')
  const [touPeakRate, setTouPeakRate] = useState('1.00')

  useEffect(() => {
    if (settings) {
      setCurrency(settings.currency.symbol)
      setDistanceUnit(settings.distanceUnit)
      setLiter(String(settings.fuelBaseline.literPer100km))
      setFuelPrice(String(settings.fuelBaseline.fuelPriceCnyPerL))
    }
  }, [settings])

  // 围栏 TOU 回填
  useEffect(() => {
    if (pricing && touGeofence != null) {
      const loc = pricing.locations.find((l) => l.id === touGeofence)
      setTouMode(loc?.priceMode === 'tou')
      if (loc?.priceMode === 'tou' && loc.tou) {
        setTouOffPeakStart(loc.tou.offPeakStart)
        setTouOffPeakEnd(loc.tou.offPeakEnd)
        setTouOffPeakRate(String(loc.tou.offPeakRate))
        setTouPeakRate(String(loc.tou.peakRate))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touGeofence])

  const saveSettings = useMutation({
    mutationFn: () =>
      api.saveSettings({
        currency: { symbol: currency, code: CURRENCIES.find((c) => c.symbol === currency)?.code ?? 'CNY' },
        distanceUnit,
        fuelBaseline: { literPer100km: Number(liter), fuelPriceCnyPerL: Number(fuelPrice) },
      }),
    onSuccess: () => {
      toast('设置已保存', 'success')
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  const saveTou = useMutation({
    mutationFn: async (id: number) =>
      api.setLocationPricing(id, touMode
        ? {
            priceMode: 'tou',
            tou: {
              offPeakStart: touOffPeakStart,
              offPeakEnd: touOffPeakEnd,
              offPeakRate: Number(touOffPeakRate),
              peakRate: Number(touPeakRate),
            },
          }
        : { priceMode: 'fixed' }),
    onSuccess: () => {
      toast('围栏电价已保存', 'success')
      void queryClient.invalidateQueries({ queryKey: ['pricing'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  // ---- 重算历史账本 ----
  const [recalcJob, setRecalcJob] = useState<string | null>(null)
  const [recalcProgress, setRecalcProgress] = useState(0)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startRecalc = useMutation({
    mutationFn: () => api.startRecalculate({ all: true }),
    onSuccess: ({ jobId }) => {
      setRecalcJob(jobId)
      setRecalcProgress(0)
      toast('重算已启动', 'success')
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        try {
          const job = await api.recalculateStatus(jobId)
          setRecalcProgress(Math.round(job.progress * 100))
          if (job.status !== 'running') {
            if (pollRef.current) clearInterval(pollRef.current)
            toast(job.status === 'done' ? '历史账本重算完成' : '重算失败', job.status === 'done' ? 'success' : 'error')
            setRecalcJob(null)
          }
        } catch {
          if (pollRef.current) clearInterval(pollRef.current)
          setRecalcJob(null)
        }
      }, 1000)
    },
    onError: (err) => toast(err.message, 'error'),
  })

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  // ---- 推送矩阵 ----
  const { data: pushRules } = useQuery({ queryKey: ['push-rules-v2'], queryFn: api.pushRulesV2 })
  const [matrix, setMatrix] = useState<Record<string, Record<string, boolean>> | null>(null)
  useEffect(() => {
    if (pushRules?.matrix) setMatrix(pushRules.matrix)
  }, [pushRules])

  const saveMatrix = useMutation({
    mutationFn: (m: Record<string, Record<string, boolean>>) =>
      api.setPushRulesV2({ matrix: m as never, weeklyReportDay: pushRules?.weeklyReportDay ?? 1 }),
    onSuccess: () => toast('推送矩阵已保存', 'success'),
    onError: (err) => toast(err.message, 'error'),
  })

  const toggleMatrix = (event: PushEventId, channel: PushChannelId) => {
    if (!matrix) return
    const next = {
      ...matrix,
      [event]: { ...matrix[event], [channel]: !matrix[event]?.[channel] },
    }
    setMatrix(next)
    saveMatrix.mutate(next)
  }

  // ---- 修改密码 ----
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const onSubmitPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!oldPassword || !newPassword) {
      setError('请填写完整')
      return
    }
    if (newPassword.length < 8) {
      setError('新密码至少 8 位')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致')
      return
    }
    setSubmitting(true)
    try {
      await api.changePassword(oldPassword, newPassword)
      toast('密码已修改', 'success')
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '修改失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fade-up">
      {/* 页头 + 账户 */}
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="page-title flex items-center gap-2.5">
            <SettingsIcon className="h-5 w-5 text-tesla" />
            设置
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            {user?.username} · 单用户模式
          </p>
        </div>
        <button
          className="btn-mini"
          onClick={async () => {
            await logout()
            navigate('/login', { replace: true })
          }}
          data-testid="settings-logout"
        >
          <LogOut className="h-3.5 w-3.5" /> 退出登录
        </button>
      </div>

      {/* 桌面：左侧锚点导航 + 右侧分区；移动：仅分区 */}
      <div className="flex gap-6">
        <aside className="hidden w-48 shrink-0 lg:block">
          <div className="sticky top-6">
            <SettingsNav active={activeSection} />
          </div>
        </aside>

        <div className="min-w-0 flex-1 space-y-5">
          {/* 移动端横向导航 */}
          <div className="lg:hidden">
            <SettingsNav active={activeSection} />
          </div>

          {/* ===== 分区1：数据与账本（数据源健康 + 账本参数整合为一组） ===== */}
          <section id="settings-datasource" className="glass-card-flat scroll-mt-6 p-5" data-testid="settings-datasource">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="section-title">
                  <Database className="h-4 w-4 text-tesla" /> 数据与账本
                </h2>
                <p className="section-desc mt-1">数据源健康 · 货币单位 · 油车基准 · 分时电价 · 历史重算</p>
              </div>
              <button className="btn-mini" onClick={() => refetchSys()} data-testid="resync-meta">
                <RefreshCw className="h-3.5 w-3.5" /> 同步
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3.5">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${sys?.teslamate.dbOk ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]' : 'bg-amber-400'}`} />
                  <span className="text-xs text-slate-400">PostgreSQL</span>
                </div>
                <div className={`num mt-2 text-lg font-semibold ${sys?.teslamate.dbOk ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {sys?.teslamate.dbOk ? '正常' : '断开'}
                  {sys?.teslamate.latencyMs != null && <span className="ml-1.5 text-xs font-normal text-slate-500">{sys.teslamate.latencyMs}ms</span>}
                </div>
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3.5">
                <div className="text-xs text-slate-400">累计行程</div>
                <div className="num mt-2 text-lg font-semibold text-white">{sys?.teslamate.driveCount ?? '--'} <span className="text-xs font-normal text-slate-500">次</span></div>
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3.5">
                <div className="text-xs text-slate-400">只读保护</div>
                <div className="mt-2 flex items-center gap-1.5 text-sm font-medium">
                  {sys?.teslamate.readonlyVerified === true ? (
                    <><ShieldCheck className="h-4 w-4 text-emerald-400" /><span className="text-emerald-400">已启用</span></>
                  ) : sys?.teslamate.readonlyVerified === false ? (
                    <span className="text-red-400">校验失败</span>
                  ) : (
                    <span className="text-slate-500">检测中</span>
                  )}
                </div>
              </div>
            </div>
            {sys?.teslamate.readonlyVerified === false && (
              <div className="mt-3 rounded-xl border border-red-400/30 bg-red-400/[0.08] px-3.5 py-2.5 text-xs text-red-400" data-testid="readonly-warning">
                ⚠ 只读校验失败：当前账号疑似具备写权限，请检查数据库账号配置
              </div>
            )}
          </section>

          {/* 账本参数（同一组内，锚点保留） */}
          <div id="settings-ledger" className="scroll-mt-6" data-testid="settings-ledger">
          <div className="mt-6 border-t border-white/[0.06] pt-5">

            {/* 货币 + 单位：分段控件 */}
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <div className="mb-2 text-xs font-medium text-slate-400">货币单位</div>
                <div className="seg w-full" role="radiogroup" aria-label="货币单位">
                  {CURRENCIES.map((c) => (
                    <button
                      key={c.symbol}
                      onClick={() => setCurrency(c.symbol)}
                      className={`seg-item ${currency === c.symbol ? 'seg-item-active' : ''}`}
                      role="radio"
                      aria-checked={currency === c.symbol}
                      data-testid={`currency-${c.code}`}
                    >
                      {c.symbol}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-2 text-xs font-medium text-slate-400">距离单位</div>
                <div className="seg w-full" role="radiogroup" aria-label="距离单位">
                  {(['km', 'mi'] as const).map((u) => (
                    <button
                      key={u}
                      onClick={() => setDistanceUnit(u)}
                      className={`seg-item ${distanceUnit === u ? 'seg-item-active' : ''}`}
                      role="radio"
                      aria-checked={distanceUnit === u}
                      data-testid={`unit-${u}`}
                    >
                      {u === 'km' ? '公里' : '英里'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 油车基准 */}
            <div className="mt-5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium text-slate-300">油车对比基准</div>
                <div className="num text-[11px] text-slate-500">
                  ≈ {((Number(liter) || 0) / 100 * (Number(fuelPrice) || 0)).toFixed(3)} {currency}/km
                </div>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-[11px] text-slate-500">百公里油耗</label>
                  <div className="relative">
                    <input type="number" step="0.1" min="1" max="30" inputMode="decimal" className="input-dark num pr-16" value={liter} onChange={(e) => setLiter(e.target.value)} aria-label="百公里油耗（升）" data-testid="fuel-liter" />
                    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-500">L/100km</span>
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block text-[11px] text-slate-500">油价</label>
                  <div className="relative">
                    <input type="number" step="0.01" min="1" max="50" inputMode="decimal" className="input-dark num pr-10" value={fuelPrice} onChange={(e) => setFuelPrice(e.target.value)} aria-label="油价（每升）" data-testid="fuel-price" />
                    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-500">{currency}/L</span>
                  </div>
                </div>
              </div>
            </div>

            <button
              className="btn-primary mt-4 w-full sm:w-auto sm:min-w-40"
              onClick={() => saveSettings.mutate()}
              disabled={saveSettings.isPending || !settings}
              data-testid="save-settings"
            >
              <Save className="h-4 w-4" />
              {saveSettings.isPending ? '保存中…' : '保存参数'}
            </button>

            {/* 围栏分时电价 */}
            <div className="mt-6 border-t border-white/[0.06] pt-5" data-testid="settings-tou">
              <h3 className="text-xs font-medium text-slate-300">围栏分时电价</h3>
              <p className="section-desc mt-1">为常用充电地点配置谷/峰两档电价，按充电起止跨时段比例计价</p>
              <div className="mt-3 flex max-w-md flex-col gap-2 sm:flex-row">
                <select
                  className="input-dark flex-1"
                  value={touGeofence ?? ''}
                  onChange={(e) => setTouGeofence(e.target.value ? Number(e.target.value) : null)}
                  aria-label="选择围栏"
                  data-testid="tou-geofence-select"
                >
                  <option value="">选择地点…</option>
                  {(pricing?.locations ?? []).map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}{loc.priceMode === 'tou' ? '（分时）' : ''}
                    </option>
                  ))}
                </select>
                {touGeofence != null && (
                  <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4">
                    <span className="text-xs text-slate-400">分时</span>
                    <Toggle checked={touMode} onChange={setTouMode} label="分时计价" />
                  </div>
                )}
              </div>
              {touGeofence != null && touMode && (
                <div className="mt-3 grid max-w-2xl gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:grid-cols-2" data-testid="tou-form">
                  <div className="sm:col-span-2 flex items-center gap-4 text-[11px] text-slate-500">
                    <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-sky-400" />谷段（如夜间家充）</span>
                    <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-amber-400" />峰段（日间快充）</span>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] text-slate-500">谷段开始</label>
                    <input type="time" className="input-dark num" value={touOffPeakStart} onChange={(e) => setTouOffPeakStart(e.target.value)} data-testid="tou-off-start" />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] text-slate-500">谷段结束</label>
                    <input type="time" className="input-dark num" value={touOffPeakEnd} onChange={(e) => setTouOffPeakEnd(e.target.value)} data-testid="tou-off-end" />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] text-slate-500">谷段单价（{currency}/kWh）</label>
                    <input type="number" step="0.001" min="0" inputMode="decimal" className="input-dark num" value={touOffPeakRate} onChange={(e) => setTouOffPeakRate(e.target.value)} data-testid="tou-off-rate" />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] text-slate-500">峰段单价（{currency}/kWh）</label>
                    <input type="number" step="0.001" min="0" inputMode="decimal" className="input-dark num" value={touPeakRate} onChange={(e) => setTouPeakRate(e.target.value)} data-testid="tou-peak-rate" />
                  </div>
                  <button
                    className="btn-primary col-span-full mt-1 sm:w-auto"
                    onClick={() => touGeofence != null && saveTou.mutate(touGeofence)}
                    disabled={saveTou.isPending}
                    data-testid="tou-save"
                  >
                    保存分时电价
                  </button>
                </div>
              )}
            </div>

            {/* 重算历史账本 */}
            <div className="mt-6 border-t border-white/[0.06] pt-5" data-testid="settings-recalc">
              <h3 className="text-xs font-medium text-slate-300">重算历史账本</h3>
              <p className="section-desc mt-1">按当前电价规则与补录费用全量重算（不影响已推送小结快照）</p>
              <div className="mt-3 flex max-w-md items-center gap-4">
                <button
                  className="btn-ghost flex-1"
                  onClick={() => startRecalc.mutate()}
                  disabled={startRecalc.isPending || recalcJob != null}
                  data-testid="recalc-button"
                >
                  <Calculator className="h-4 w-4" />
                  {recalcJob ? `重算中 ${recalcProgress}%` : '开始重算'}
                </button>
              </div>
              {recalcJob != null && (
                <div className="mt-3 h-1.5 max-w-md overflow-hidden rounded-full bg-white/[0.06]" data-testid="recalc-progress">
                  <div className="h-full rounded-full bg-tesla transition-all duration-500" style={{ width: `${recalcProgress}%` }} />
                </div>
              )}
            </div>
          </div>
          </div>

          {/* ===== 分区2：推送 ===== */}
          <section id="settings-push" className="glass-card-flat scroll-mt-6 p-5" data-testid="settings-push-matrix">
            <h2 className="section-title">
              <BellRing className="h-4 w-4 text-tesla" /> 推送
            </h2>
            <p className="section-desc mt-1">5 类事件 × 3 渠道独立开关 · 渠道密钥在「推送」页配置</p>
            {matrix ? (
              <div className="mt-4 divide-y divide-white/[0.05]" data-testid="push-matrix-list">
                {EVENTS.map((ev) => {
                  const enabledCount = CHANNELS.filter((ch) => matrix[ev.id]?.[ch.id]).length
                  return (
                    <div key={ev.id} className="flex flex-col gap-2.5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-[13px] text-slate-200">
                          {ev.label}
                          {enabledCount > 0 ? (
                            <span className="rounded-full bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">{enabledCount} 渠道</span>
                          ) : (
                            <span className="rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-slate-500">已静音</span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-600">{ev.desc}</div>
                      </div>
                      {/* 渠道 chips：点亮即启用，一行搞定 3 渠道 */}
                      <div className="flex shrink-0 gap-1.5">
                        {CHANNELS.map((ch) => {
                          const on = Boolean(matrix[ev.id]?.[ch.id])
                          return (
                            <button
                              key={ch.id}
                              onClick={() => toggleMatrix(ev.id, ch.id)}
                              aria-pressed={on}
                              aria-label={`${ev.label} ${ch.label}`}
                              data-testid={`matrix-${ev.id}-${ch.id}`}
                              className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition active:scale-[0.96] ${
                                on
                                  ? 'border-tesla/50 bg-tesla/15 text-tesla-soft shadow-[0_0_0_1px_rgba(232,33,39,0.15)]'
                                  : 'border-white/[0.08] text-slate-500 hover:border-white/20 hover:text-slate-300'
                              }`}
                            >
                              {ch.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="mt-4 space-y-2">
                {Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton h-10" />)}
              </div>
            )}
          </section>

          {/* ===== 分区3：账户安全 ===== */}
          <section id="settings-security" className="glass-card-flat scroll-mt-6 p-5" data-testid="change-password-card">
            <h2 className="section-title">
              <KeyRound className="h-4 w-4 text-tesla" /> 账户安全
            </h2>
            <p className="section-desc mt-1">修改密码后其他已登录会话将被吊销</p>
            <form onSubmit={onSubmitPassword} className="mt-4 max-w-sm space-y-3.5" noValidate>
              <div>
                <label htmlFor="old-password" className="mb-1.5 block text-xs font-medium text-slate-400">当前密码</label>
                <input id="old-password" type="password" className="input-dark" autoComplete="current-password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
              </div>
              <div>
                <label htmlFor="new-password" className="mb-1.5 block text-xs font-medium text-slate-400">新密码</label>
                <input id="new-password" type="password" className="input-dark" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              </div>
              <div>
                <label htmlFor="confirm-password" className="mb-1.5 block text-xs font-medium text-slate-400">确认新密码</label>
                <input id="confirm-password" type="password" className="input-dark" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
              </div>
              {error && (
                <div role="alert" data-testid="password-error" className="rounded-lg border border-tesla/30 bg-tesla/10 px-3 py-2 text-xs text-tesla-soft">
                  {error}
                </div>
              )}
              <button type="submit" className="btn-primary w-full" disabled={submitting} data-testid="password-submit">
                {submitting ? '提交中…' : '修改密码'}
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  )
}
