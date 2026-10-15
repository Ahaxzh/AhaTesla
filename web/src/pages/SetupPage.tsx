import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, CircleDashed, ExternalLink, Lock, ShieldCheck, XCircle } from 'lucide-react'
import { api } from '@/api/client'
import { useAuth } from '@/contexts/AuthContext'
import { LogoMark } from '@/components/Logo'
import type { CarDiscoveryResult, DiscoveredCar, SetupCheckStep, SetupState } from '@/types'

/**
 * P1 初始化向导（PRD §6.3）：
 * Step1 创建管理员 → Step2 数据源接入（双模分支 + 四级校验 + 车辆发现/多车选择器）
 * → Step3 账本初始化（可跳过）→ Step4 通知渠道（可跳过）→ 进入仪表盘。
 * 每一步皆可跳过；完成后 /setup 路由锁定（后端 403）。
 */

const CHECK_LABELS: Record<string, string> = {
  reachability: '网络可达',
  auth: '数据库认证',
  readonly: '只读安全校验',
  cars: '车辆数据检索',
}

const POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS = 60_000

type Mode = 'connect' | 'fullstack'

export default function SetupPage() {
  const navigate = useNavigate()
  const { refresh } = useAuth()
  const [step, setStep] = useState(1)
  const [setupState, setSetupState] = useState<SetupState | null>(null)

  const statusQuery = useQuery({
    queryKey: ['setup-status'],
    queryFn: api.setupStatus,
    staleTime: 0,
  })

  useEffect(() => {
    if (statusQuery.data) setSetupState(statusQuery.data.state)
  }, [statusQuery.data])

  // 已初始化（管理员已建）→ /setup 锁定（AC-1.4），跳回登录/首页
  if (setupState && setupState !== 'uninitialized' && step === 1) {
    return <Navigate to="/login" replace />
  }

  const goto = (next: number) => setStep(Math.min(4, Math.max(1, next)))

  return (
    <div className="flex min-h-dvh flex-col items-center bg-base-950 px-4 py-10">
      <div className="mb-6 flex flex-col items-center gap-2">
        <LogoMark size={44} />
        <div className="text-xl font-semibold tracking-tight text-white">
          Aha<span className="text-tesla">Tesla</span> 初始化向导
        </div>
      </div>

      <SetupProgress current={step} />

      <div className="mt-6 w-full max-w-md" data-testid={`setup-step-${step}`}>
        {step === 1 && <Step1Admin onDone={() => { void refresh(); goto(2) }} />}
        {step === 2 && <Step2Datasource onDone={() => goto(3)} />}
        {step === 3 && <Step3Ledger onDone={() => goto(4)} onSkip={() => goto(4)} />}
        {step === 4 && (
          <Step4Notify
            https={statusQuery.data?.https ?? false}
            onDone={() => navigate('/', { replace: true })}
            onSkip={() => navigate('/', { replace: true })}
          />
        )}
      </div>
    </div>
  )
}

function SetupProgress({ current }: { current: number }) {
  const labels = ['管理员', '数据源', '账本', '通知']
  return (
    <ol className="flex items-center gap-2" data-testid="setup-progress">
      {labels.map((label, i) => {
        const n = i + 1
        const active = n === current
        const done = n < current
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                done ? 'bg-emerald-500/20 text-emerald-400' : active ? 'bg-tesla/20 text-tesla' : 'bg-slate-800 text-slate-500'
              }`}
              aria-current={active ? 'step' : undefined}
            >
              {n}
            </span>
            <span className={`text-xs ${active ? 'text-white' : 'text-slate-500'}`}>{label}</span>
            {n < 4 && <span className="mx-1 h-px w-6 bg-slate-800" />}
          </li>
        )
      })}
    </ol>
  )
}

// ---- Step 1 创建管理员（首位注册即管理员，AC-1.4/3.1）----

function Step1Admin({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (username.trim().length < 3) return setError('用户名至少 3 个字符')
    if (password.length < 8) return setError('密码至少 8 位')
    if (password !== confirm) return setError('两次输入的密码不一致')
    setSubmitting(true)
    try {
      await api.setupRegisterAdmin(username.trim(), password)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="glass-card space-y-4 p-6" data-testid="setup-admin-form" noValidate>
      <div>
        <h2 className="text-lg font-semibold text-white">创建管理员账号</h2>
        <p className="mt-1 text-xs text-slate-500">首位注册的用户自动成为管理员，注册完成后此入口自动关闭。</p>
      </div>
      <div>
        <label htmlFor="setup-username" className="mb-1.5 block text-xs font-medium text-slate-400">用户名</label>
        <input
          id="setup-username"
          className="input-dark"
          type="text"
          autoComplete="username"
          placeholder="请输入用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="setup-password" className="mb-1.5 block text-xs font-medium text-slate-400">密码（≥8 位）</label>
        <input
          id="setup-password"
          className="input-dark"
          type="password"
          autoComplete="new-password"
          placeholder="至少 8 位"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="setup-confirm" className="mb-1.5 block text-xs font-medium text-slate-400">确认密码</label>
        <input
          id="setup-confirm"
          className="input-dark"
          type="password"
          autoComplete="new-password"
          placeholder="再次输入密码"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      {error && (
        <p className="text-sm text-red-400" data-testid="setup-admin-error" role="alert">{error}</p>
      )}
      <button
        type="submit"
        className="btn-primary w-full"
        disabled={submitting}
        data-testid="setup-admin-submit"
      >
        {submitting ? '创建中…' : '创建管理员并继续'}
      </button>
    </form>
  )
}

// ---- Step 2 数据源接入（双模分支 + 四级校验 + 车辆发现）----

function Step2Datasource({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<Mode>('connect')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('5432')
  const [database, setDatabase] = useState('teslamate')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [steps, setSteps] = useState<SetupCheckStep[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [verified, setVerified] = useState(false)
  const [error, setError] = useState('')

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [discovery, setDiscovery] = useState<CarDiscoveryResult | null>(null)
  const [selectedCarId, setSelectedCarId] = useState<number | null>(null)
  const discoveryTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const canSubmit = mode === 'fullstack' || (host.trim() && user.trim() && password)

  // 车辆发现轮询（AC-2.3/4.3：60s 内发现；2s 间隔）
  const startDiscovery = useCallback(() => {
    if (discoveryTimer.current) return
    const startedAt = Date.now()
    discoveryTimer.current = setInterval(async () => {
      try {
        const result = await api.setupCarDiscovery()
        if (result.found) {
          setDiscovery(result)
          setSelectedCarId(result.suggestedCarId ?? result.car?.id ?? null)
          if (discoveryTimer.current) clearInterval(discoveryTimer.current)
          discoveryTimer.current = null
        } else if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          if (discoveryTimer.current) clearInterval(discoveryTimer.current)
          discoveryTimer.current = null
        }
      } catch {
        /* 继续轮询直至超时 */
      }
    }, POLL_INTERVAL_MS)
  }, [])

  useEffect(() => () => {
    if (discoveryTimer.current) clearInterval(discoveryTimer.current)
  }, [])

  const onTest = async () => {
    setError('')
    setChecking(true)
    setVerified(false)
    setSteps(null)
    try {
      const result = await api.setupTestConnection({
        host: host.trim(),
        port: Number(port) || 5432,
        database: database.trim() || 'teslamate',
        user: user.trim(),
        password,
      })
      setSteps(result.steps)
      if (result.ok && result.cars.length > 0) {
        setVerified(true)
      } else if (result.ok) {
        // 校验通过但 cars 空 → 属可保存状态（车辆稍后发现）
        setVerified(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接测试失败')
    } finally {
      setChecking(false)
    }
  }

  const onSave = async () => {
    setSaving(true)
    setError('')
    try {
      await api.setupSaveDatasource(
        mode === 'connect'
          ? { mode, host: host.trim(), port: Number(port) || 5432, database: database.trim() || 'teslamate', user: user.trim(), password }
          : { mode },
      )
      if (mode === 'fullstack') startDiscovery()
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const onSelectCar = async (carId: number) => {
    setSelectedCarId(carId)
    try {
      await api.setupSelectCar(carId)
    } catch {
      /* 选择失败不阻塞向导，可稍后在设置中重绑 */
    }
  }

  const multiCar = (discovery?.cars.length ?? 0) > 1
  const readyToNext = mode === 'fullstack' ? saved && discovery?.found : verified && saved

  return (
    <div className="glass-card space-y-5 p-6" data-testid="setup-datasource">
      <div>
        <h2 className="text-lg font-semibold text-white">接入数据源</h2>
        <p className="mt-1 text-xs text-slate-500">已有 TeslaMate？填数据库直连。新用户？用全栈部署。</p>
      </div>

      <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="接入模式">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'connect'}
          className={`rounded-xl border px-3 py-2.5 text-sm ${mode === 'connect' ? 'border-tesla bg-tesla/10 text-white' : 'border-slate-800 text-slate-400'}`}
          onClick={() => setMode('connect')}
          data-testid="setup-mode-connect"
        >
          A · 我已有 TeslaMate
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'fullstack'}
          className={`rounded-xl border px-3 py-2.5 text-sm ${mode === 'fullstack' ? 'border-tesla bg-tesla/10 text-white' : 'border-slate-800 text-slate-400'}`}
          onClick={() => setMode('fullstack')}
          data-testid="setup-mode-fullstack"
        >
          B · 新用户全栈部署
        </button>
      </div>

      {mode === 'connect' ? (
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_88px] gap-3">
            <Field id="setup-host" label="PostgreSQL Host" value={host} onChange={setHost} placeholder="127.0.0.1" />
            <Field id="setup-port" label="端口" value={port} onChange={setPort} placeholder="5432" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field id="setup-db" label="库名" value={database} onChange={setDatabase} placeholder="teslamate" />
            <Field id="setup-user" label="用户名（只读账号）" value={user} onChange={setUser} placeholder="ahatesla_ro" />
          </div>
          <Field id="setup-pwd" label="密码" type="password" value={password} onChange={setPassword} placeholder="只读账号密码" />

          <button
            type="button"
            className="btn-primary w-full"
            disabled={!canSubmit || checking}
            onClick={onTest}
            data-testid="setup-test-connection"
          >
            {checking ? '测试中…' : '测试并验证'}
          </button>

          {steps && (
            <ul className="space-y-1.5" data-testid="setup-check-steps">
              {steps.map((s) => (
                <li key={s.name} className="flex items-start gap-2 text-sm" data-testid={`setup-check-${s.name}`} data-ok={s.ok}>
                  {s.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                  )}
                  <span>
                    <span className="text-slate-200">{CHECK_LABELS[s.name] ?? s.name}</span>
                    {s.detail && <span className="block text-xs text-slate-500">{s.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {verified && (
            <p className="flex items-center gap-1.5 text-sm text-emerald-400" data-testid="setup-verified">
              <ShieldCheck className="h-4 w-4" /> 校验通过，可保存接入
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3" data-testid="setup-fullstack-panel">
          <p className="text-sm text-slate-300">检测到同栈部署模式：</p>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-400">
            <li>点击下方链接在新窗口打开 TeslaMate，完成 Tesla 账号授权（授权仅发生在 TeslaMate，AhaTesla 不接触 Tesla 密码）。</li>
            <li>回到本页，向导会自动轮询发现你的车辆（最长 60 秒）。</li>
          </ol>
          <a
            href="http://127.0.0.1:4000/sessions/new"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-tesla hover:underline"
            data-testid="setup-teslamate-link"
          >
            打开 TeslaMate 授权页 <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-300">
            <Lock className="mr-1 inline h-3.5 w-3.5" />
            安全提示：TeslaMate Web 默认无密码，请勿将 4000 端口映射公网；建议仅内网访问并由 AhaTesla 反代保护（AC-4.1）。
          </p>
          {saved && !discovery?.found && (
            <p className="flex items-center gap-2 text-sm text-slate-400" data-testid="setup-discovery-polling">
              <CircleDashed className="h-4 w-4 animate-spin text-tesla" />
              正在等待车辆出现（TeslaMate 完成授权后自动发现）…
            </p>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-400" role="alert">{error}</p>}

      {discovery?.found && (
        <div className="space-y-2" data-testid="setup-car-found">
          {multiCar ? (
            <>
              <p className="text-sm text-slate-300">发现 {discovery.cars.length} 辆车，请选择主绑定车辆：</p>
              <div className="space-y-2" role="radiogroup" aria-label="车辆选择器" data-testid="setup-car-selector">
                {discovery.cars.map((car) => (
                  <CarOption
                    key={car.id}
                    car={car}
                    selected={selectedCarId === car.id}
                    onSelect={() => onSelectCar(car.id)}
                  />
                ))}
              </div>
            </>
          ) : (
            <p className="flex items-center gap-1.5 text-sm text-emerald-400" data-testid="setup-single-car">
              <CheckCircle2 className="h-4 w-4" /> 已发现你的 {discovery.car?.model || discovery.car?.name || 'Tesla'}
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          className="btn-primary flex-1"
          disabled={!canSubmit || saving || saved || (mode === 'connect' && !verified)}
          onClick={onSave}
          data-testid="setup-save-datasource"
        >
          {saved ? '已保存' : '保存数据源'}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={!readyToNext}
          onClick={onDone}
          data-testid="setup-next"
        >
          下一步
        </button>
      </div>
    </div>
  )
}

function CarOption({ car, selected, onSelect }: { car: DiscoveredCar; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-left text-sm ${
        selected ? 'border-tesla bg-tesla/10 text-white' : 'border-slate-800 text-slate-300'
      }`}
      data-testid={`setup-car-option-${car.id}`}
    >
      <span>
        {car.name || `Car #${car.id}`}
        <span className="ml-2 text-xs text-slate-500">{car.model}</span>
      </span>
      {selected && <CheckCircle2 className="h-4 w-4 text-tesla" />}
    </button>
  )
}

function Field({
  id, label, value, onChange, type = 'text', placeholder,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-slate-400">{label}</label>
      <input
        id={id}
        className="input-dark"
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

// ---- Step 3 账本初始化（可跳过；电价/油车基准属既有设置页能力，此处只做预填提示）----

function Step3Ledger({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  return (
    <div className="glass-card space-y-4 p-6" data-testid="setup-ledger">
      <div>
        <h2 className="text-lg font-semibold text-white">账本初始化</h2>
        <p className="mt-1 text-xs text-slate-500">可跳过——稍后在「电价」与「系统设置」中随时补配。</p>
      </div>
      <ul className="space-y-2 text-sm text-slate-300">
        <li>· 默认电价：0.60 元/kWh（可在电价页修改）</li>
        <li>· 油车对比基准：8.0 L/100km @ 8.20 元/L</li>
      </ul>
      <div className="flex gap-2">
        <button type="button" className="btn-ghost flex-1" onClick={onSkip} data-testid="setup-skip-ledger">
          跳过
        </button>
        <button type="button" className="btn-primary flex-1" onClick={onDone} data-testid="setup-ledger-next">
          好，继续
        </button>
      </div>
    </div>
  )
}

// ---- Step 4 通知渠道（可跳过；HTTPS 检测 AC-11.0）----

function Step4Notify({ https, onDone, onSkip }: { https: boolean; onDone: () => void; onSkip: () => void }) {
  return (
    <div className="glass-card space-y-4 p-6" data-testid="setup-notify">
      <div>
        <h2 className="text-lg font-semibold text-white">通知渠道</h2>
        <p className="mt-1 text-xs text-slate-500">可跳过——稍后在「推送」页配置 Web Push / Telegram / 飞书。</p>
      </div>
      {https ? (
        <button type="button" className="btn-primary w-full" onClick={onDone} data-testid="setup-enable-webpush">
          一键开启 Web Push
        </button>
      ) : (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300" data-testid="setup-http-warning">
          当前为非 HTTPS 环境，Web Push 不可用。建议配置反向代理启用 HTTPS，或优先绑定 Telegram / 飞书（AC-11.0）。
        </p>
      )}
      <div className="flex gap-2">
        <button type="button" className="btn-ghost flex-1" onClick={onSkip} data-testid="setup-skip-notify">
          跳过
        </button>
        <button type="button" className="btn-primary flex-1" onClick={onDone} data-testid="setup-finish">
          完成向导
        </button>
      </div>
    </div>
  )
}
