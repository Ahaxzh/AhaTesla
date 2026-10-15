import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  Calculator,
  Database,
  KeyRound,
  LogOut,
  RefreshCw,
  Save,
  Settings as SettingsIcon,
  ShieldCheck,
  UserRound,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { useToast } from '@/components/Toast'
import { Toggle } from '@/components/Toggle'
import type { PushEventId, PushChannelId } from '@/types'

const CURRENCIES = [
  { symbol: '¥', code: 'CNY', label: '¥ 人民币' },
  { symbol: '$', code: 'USD', label: '$ 美元' },
  { symbol: '€', code: 'EUR', label: '€ 欧元' },
  { symbol: '£', code: 'GBP', label: '£ 英镑' },
]

export default function SettingsPage() {
  const { user, logout } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // ---- 修改密码 ----
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // ---- 分组1：数据源健康（system status） ----
  const { data: sys, refetch: refetchSys } = useQuery({
    queryKey: ['system-status'],
    queryFn: api.systemStatus,
    refetchInterval: 60_000,
  })

  // ---- 分组2：账本参数（settings + pricing locations） ----
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const { data: pricing } = useQuery({ queryKey: ['pricing'], queryFn: api.pricing })

  const [currency, setCurrency] = useState('¥')
  const [distanceUnit, setDistanceUnit] = useState<'km' | 'mi'>('km')
  const [liter, setLiter] = useState('8.0')
  const [fuelPrice, setFuelPrice] = useState('8.20')
  const [touGeofence, setTouGeofence] = useState<number | null>(null)
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

  // 围栏列表已有 TOU 时回填
  useEffect(() => {
    if (pricing && touGeofence != null) {
      const loc = pricing.locations.find((l) => l.id === touGeofence)
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
    mutationFn: async (id: number) => {
      const useTou = touMode
      return api.setLocationPricing(id, useTou
        ? {
            priceMode: 'tou',
            tou: {
              offPeakStart: touOffPeakStart,
              offPeakEnd: touOffPeakEnd,
              offPeakRate: Number(touOffPeakRate),
              peakRate: Number(touPeakRate),
            },
          }
        : { priceMode: 'fixed' })
    },
    onSuccess: () => {
      toast('围栏电价已保存', 'success')
      void queryClient.invalidateQueries({ queryKey: ['pricing'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  const [touMode, setTouMode] = useState(false)
  useEffect(() => {
    if (pricing && touGeofence != null) {
      const loc = pricing.locations.find((l) => l.id === touGeofence)
      setTouMode(loc?.priceMode === 'tou')
    }
  }, [pricing, touGeofence])

  // ---- 重算历史账本（AC-7.3） ----
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

  // ---- 推送矩阵（5 事件 × 3 渠道，P6 分组3） ----
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

  const EVENTS: { id: PushEventId; label: string }[] = [
    { id: 'tripEnd', label: '行程结束小结' },
    { id: 'chargingStart', label: '充电开始提醒' },
    { id: 'chargingDone', label: '充电完成账单' },
    { id: 'weekly', label: '每周里程周报' },
    { id: 'monthly', label: '每月账本月报' },
  ]
  const CHANNELS: { id: PushChannelId; label: string }[] = [
    { id: 'webpush', label: 'Web Push' },
    { id: 'telegram', label: 'Telegram' },
    { id: 'feishu', label: '飞书' },
  ]

  return (
    <div>
      <PageHeader icon={SettingsIcon} title="设置" />

      {/* 账户信息 */}
      <section className="glass-card mb-4 flex items-center gap-4 p-5" data-testid="account-card">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-tesla/15 text-lg font-semibold text-tesla">
          {user?.username?.[0]?.toUpperCase() ?? '?'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
            <UserRound className="h-4 w-4 text-slate-500" />
            {user?.username ?? '--'}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">单用户模式 · JWT Cookie 认证</div>
        </div>
      </section>

      {/* 分组1：数据源与连接健康（P6 §6.3） */}
      <section className="glass-card mb-4 p-5" data-testid="settings-datasource">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <Database className="h-4 w-4 text-tesla" /> 数据源与连接健康
          </h2>
          <button
            className="flex items-center gap-1 text-xs text-slate-400 transition hover:text-tesla"
            onClick={() => refetchSys()}
            data-testid="resync-meta"
          >
            <RefreshCw className="h-3.5 w-3.5" /> 立即重新同步
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-white/[0.04] px-3.5 py-3">
            <div className="text-[11px] text-slate-500">PostgreSQL 连接</div>
            <div className={`mt-1 text-sm ${sys?.teslamate.dbOk ? 'text-emerald-400' : 'text-amber-400'}`}>
              {sys?.teslamate.dbOk ? '正常' : '断开'}
              {sys?.teslamate.latencyMs != null && <span className="num ml-2 text-xs text-slate-500">{sys.teslamate.latencyMs}ms</span>}
            </div>
          </div>
          <div className="rounded-xl bg-white/[0.04] px-3.5 py-3">
            <div className="text-[11px] text-slate-500">累计行程</div>
            <div className="num mt-1 text-sm text-slate-200">{sys?.teslamate.driveCount ?? '--'} 次</div>
          </div>
        </div>
        {sys?.teslamate.readonlyVerified === true && (
          <div
            className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] px-3.5 py-2.5 text-xs text-emerald-400"
            data-testid="readonly-badge"
          >
            <ShieldCheck className="h-4 w-4" />
            只读模式运行中（写入已强阻断）
          </div>
        )}
        {sys?.teslamate.readonlyVerified === false && (
          <div className="mt-3 rounded-xl border border-red-400/30 bg-red-400/[0.08] px-3.5 py-2.5 text-xs text-red-400" data-testid="readonly-warning">
            ⚠ 只读校验失败：当前账号疑似具备写权限，请检查数据库账号配置
          </div>
        )}
      </section>

      {/* 分组2：账本与单价规则 */}
      <section className="glass-card mb-4 p-5" data-testid="settings-ledger">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-200">
          <Calculator className="h-4 w-4 text-tesla" /> 账本与单价规则
        </h2>

        {/* 货币 + 单位 */}
        <div className="mb-5 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">货币单位</label>
            <div className="flex gap-1.5">
              {CURRENCIES.map((c) => (
                <button
                  key={c.symbol}
                  onClick={() => setCurrency(c.symbol)}
                  className={`flex-1 rounded-lg border px-2 py-2 text-xs transition ${
                    currency === c.symbol ? 'border-tesla/50 bg-tesla/12 font-medium text-tesla' : 'border-white/[0.08] text-slate-400 hover:bg-white/[0.04]'
                  }`}
                  data-testid={`currency-${c.code}`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">距离单位</label>
            <div className="flex gap-1.5">
              {(['km', 'mi'] as const).map((u) => (
                <button
                  key={u}
                  onClick={() => setDistanceUnit(u)}
                  className={`flex-1 rounded-lg border px-2 py-2 text-xs transition ${
                    distanceUnit === u ? 'border-tesla/50 bg-tesla/12 font-medium text-tesla' : 'border-white/[0.08] text-slate-400 hover:bg-white/[0.04]'
                  }`}
                  data-testid={`unit-${u}`}
                >
                  {u === 'km' ? '公里 km' : '英里 mi'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 油车基准（AC-7.4） */}
        <div className="mb-5">
          <label className="mb-1.5 block text-xs font-medium text-slate-400">油车对比基准</label>
          <div className="flex max-w-md items-center gap-3">
            <div className="relative flex-1">
              <input
                type="number" step="0.1" min="1" max="30" inputMode="decimal"
                className="input-dark num pr-20"
                value={liter}
                onChange={(e) => setLiter(e.target.value)}
                aria-label="百公里油耗（升）"
                data-testid="fuel-liter"
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-500">L/100km</span>
            </div>
            <div className="relative flex-1">
              <input
                type="number" step="0.01" min="1" max="50" inputMode="decimal"
                className="input-dark num pr-14"
                value={fuelPrice}
                onChange={(e) => setFuelPrice(e.target.value)}
                aria-label="油价（每升）"
                data-testid="fuel-price"
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-500">{currency}/L</span>
            </div>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">
            折合约 {((Number(liter) || 0) / 100 * (Number(fuelPrice) || 0)).toFixed(3)} {currency}/km（报告与卡片注明此基准）
          </p>
        </div>

        <button
          className="btn-primary mb-6 max-w-md w-full"
          onClick={() => saveSettings.mutate()}
          disabled={saveSettings.isPending || !settings}
          data-testid="save-settings"
        >
          <Save className="h-4 w-4" />
          {saveSettings.isPending ? '保存中…' : '保存账本参数'}
        </button>

        {/* 围栏分时电价（TOU，AC-7.1③） */}
        <div className="border-t border-white/[0.06] pt-4" data-testid="settings-tou">
          <h3 className="mb-1 text-xs font-medium text-slate-300">围栏分时电价（谷/峰两档）</h3>
          <p className="mb-3 text-[11px] text-slate-500">选择充电地点配置分时计价：谷段时段（如 23:00-07:00）与两档价格，按充电起止跨时段比例计价</p>
          <div className="flex max-w-md gap-2">
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
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Toggle checked={touMode} onChange={setTouMode} label="分时" />
              </div>
            )}
          </div>
          {touGeofence != null && touMode && (
            <div className="mt-3 grid max-w-md gap-3 rounded-xl bg-white/[0.03] p-4 sm:grid-cols-2" data-testid="tou-form">
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
                className="btn-primary col-span-full mt-1"
                onClick={() => touGeofence != null && saveTou.mutate(touGeofence)}
                disabled={saveTou.isPending}
                data-testid="tou-save"
              >
                保存分时电价
              </button>
            </div>
          )}
        </div>

        {/* 重算历史账本（AC-7.3） */}
        <div className="mt-6 border-t border-white/[0.06] pt-4" data-testid="settings-recalc">
          <h3 className="mb-1 text-xs font-medium text-slate-300">重算历史账本</h3>
          <p className="mb-3 text-[11px] text-slate-500">按当前电价规则与补录费用全量重算（不影响已推送小结快照）</p>
          <button
            className="btn-ghost max-w-md w-full"
            onClick={() => startRecalc.mutate()}
            disabled={startRecalc.isPending || recalcJob != null}
            data-testid="recalc-button"
          >
            <Calculator className="h-4 w-4" />
            {recalcJob ? `重算中 ${recalcProgress}%` : '重算历史账本'}
          </button>
          {recalcJob != null && (
            <div className="mt-2 h-1.5 max-w-md overflow-hidden rounded-full bg-white/[0.06]" data-testid="recalc-progress">
              <div className="h-full rounded-full bg-tesla transition-all" style={{ width: `${recalcProgress}%` }} />
            </div>
          )}
        </div>
      </section>

      {/* 分组3：推送矩阵（5 事件 × 3 渠道） */}
      <section className="glass-card mb-4 p-5" data-testid="settings-push-matrix">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
          <SettingsIcon className="h-4 w-4 text-tesla" /> 推送矩阵
        </h2>
        <p className="mb-4 text-[11px] text-slate-500">5 类事件 × 3 渠道独立开关（渠道密钥在「推送」页配置）</p>
        {matrix ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-left text-[11px] text-slate-500">
                  <th className="py-2 pr-3 font-medium">事件</th>
                  {CHANNELS.map((ch) => (
                    <th key={ch.id} className="py-2 px-3 text-center font-medium">{ch.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {EVENTS.map((ev) => (
                  <tr key={ev.id}>
                    <td className="py-2.5 pr-3 text-slate-200">{ev.label}</td>
                    {CHANNELS.map((ch) => (
                      <td key={ch.id} className="py-2.5 px-3 text-center">
                        <Toggle
                          checked={Boolean(matrix[ev.id]?.[ch.id])}
                          onChange={() => toggleMatrix(ev.id, ch.id)}
                          label={`${ev.label} ${ch.label}`}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="space-y-2 py-2">
            {Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton h-8" />)}
          </div>
        )}
      </section>

      {/* 修改密码 */}
      <section className="glass-card mb-4 p-5" data-testid="change-password-card">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-200">
          <KeyRound className="h-4 w-4 text-tesla" />
          修改密码
        </h2>
        <form onSubmit={onSubmitPassword} className="max-w-sm space-y-3.5" noValidate>
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

      <button
        className="btn-ghost w-full max-w-sm !border-tesla/25 text-tesla-soft hover:!bg-tesla/10"
        onClick={async () => {
          await logout()
          navigate('/login', { replace: true })
        }}
        data-testid="settings-logout"
      >
        <LogOut className="h-4 w-4" />
        退出登录
      </button>
    </div>
  )
}
