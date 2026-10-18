import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, ChevronDown, CircleDashed, Copy, ExternalLink, Lock, ShieldCheck, XCircle } from 'lucide-react'
import { api } from '@/api/client'
import { useAuth } from '@/contexts/AuthContext'
import { useToast } from '@/components/Toast'
import { LogoMark } from '@/components/Logo'
import { useI18n } from '@/i18n'
import type { CarDiscoveryResult, DiscoveredCar, SetupCheckStep, SetupState } from '@/types'

/**
 * P1 初始化向导（PRD §6.3）：
 * Step1 创建管理员 → Step2 数据源接入（双模分支 + 四级校验 + 车辆发现/多车选择器）
 * → Step3 账本初始化（可跳过）→ Step4 通知渠道（可跳过）→ 进入仪表盘。
 * 每一步皆可跳过；完成后 /setup 路由锁定（后端 403）。
 */

/** 四级校验标签 — key 交给调用点 t() 双语 */
const CHECK_LABELS: Record<string, { key: string; zh: string }> = {
  reachability: { key: 'setup.check.reachability', zh: '网络可达' },
  auth: { key: 'setup.check.auth', zh: '数据库认证' },
  readonly: { key: 'setup.check.readonly', zh: '只读安全校验' },
  cars: { key: 'setup.check.cars', zh: '车辆数据检索' },
}

const POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS = 60_000

type Mode = 'connect' | 'fullstack'

export default function SetupPage() {
  const navigate = useNavigate()
  const { t } = useI18n()
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
    <div className="flex min-h-dvh flex-col items-center bg-base-950 px-4 pb-10 pt-[max(2.5rem,env(safe-area-inset-top))]">
      <div className="mb-6 flex flex-col items-center gap-2">
        <LogoMark size={44} />
        <div className="text-xl font-semibold tracking-tight text-white">
          Aha<span className="text-tesla">Tesla</span> {t('setup.wizard', '初始化向导')}
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
  const { t } = useI18n()
  const labels = [t('setup.step.admin', '管理员'), t('setup.step.datasource', '数据源'), t('setup.step.ledger', '账本'), t('setup.step.notify', '通知')]
  return (
    <ol className="flex w-full max-w-md items-center gap-2 px-1" data-testid="setup-progress">
      {labels.map((label, i) => {
        const n = i + 1
        const active = n === current
        const done = n < current
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                done ? 'bg-emerald-500/20 text-emerald-400' : active ? 'bg-tesla/20 text-tesla' : 'bg-slate-800 text-slate-500'
              }`}
              aria-current={active ? 'step' : undefined}
            >
              {n}
            </span>
            <span className={`whitespace-nowrap text-xs ${active ? 'text-white' : 'text-slate-400'}`}>{label}</span>
            {n < 4 && <span className="mx-1 h-px min-w-2 flex-1 bg-slate-800" />}
          </li>
        )
      })}
    </ol>
  )
}

// ---- Step 1 创建管理员（首位注册即管理员，AC-1.4/3.1）----

function Step1Admin({ onDone }: { onDone: () => void }) {
  const { t } = useI18n()
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
        <h2 className="text-lg font-semibold text-white">{t('setup.s1.title', '创建管理员账号')}</h2>
        <p className="mt-1 text-xs text-slate-500">{t('setup.s1.desc', '首位注册的用户自动成为管理员，注册完成后此入口自动关闭。')}</p>
      </div>
      <div>
        <label htmlFor="setup-username" className="mb-1.5 block text-xs font-medium text-slate-400">{t('setup.s1.username', '用户名')}</label>
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
        <label htmlFor="setup-password" className="mb-1.5 block text-xs font-medium text-slate-400">{t('setup.s1.password', '密码（≥8 位）')}</label>
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
        <label htmlFor="setup-confirm" className="mb-1.5 block text-xs font-medium text-slate-400">{t('setup.s1.confirm', '确认密码')}</label>
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
        <div role="alert" data-testid="setup-admin-error" className="rounded-lg border border-tesla/30 bg-tesla/10 px-3 py-2 text-xs text-tesla-soft">
          {error}
        </div>
      )}
      <button
        type="submit"
        className="btn-primary w-full"
        disabled={submitting}
        data-testid="setup-admin-submit"
      >
        {submitting ? t('setup.s1.creating', '创建中…') : t('setup.s1.submit', '创建管理员并继续')}
      </button>
    </form>
  )
}

// ---- Step 2 数据源接入（双模分支 + 四级校验 + 车辆发现）----

function Step2Datasource({ onDone }: { onDone: () => void }) {
  const { t } = useI18n()
  const { toast } = useToast()
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

  // ---- m4a 轨道B 三层接入：自动发现 / 一键建号 / 手动 DSN ----
  const [candidates, setCandidates] = useState<{ host: string; port: number; source: string }[] | null>(null)
  const [probing, setProbing] = useState(false)
  const [adminUser, setAdminUser] = useState('')
  const [adminPwd, setAdminPwd] = useState('')
  const [roBusy, setRoBusy] = useState(false)
  const [roDone, setRoDone] = useState(false)
  const [roFail, setRoFail] = useState<{ stage: string; error: string; fallbackSql: string } | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [dsn, setDsn] = useState('')
  const [dsnError, setDsnError] = useState('')

  // 进入 connect 模式即探测局域网内可达的 TeslaMate 库（失败/为空 → 静默收起）
  useEffect(() => {
    if (mode !== 'connect') return
    let alive = true
    setProbing(true)
    api
      .setupProbeDiscovery()
      .then((r) => { if (alive) setCandidates(r.candidates ?? []) })
      .catch(() => { if (alive) setCandidates([]) })
      .finally(() => { if (alive) setProbing(false) })
    return () => { alive = false }
  }, [mode])

  /** 解析 postgres:// DSN 并预填连接表单（一键建号成功回填与高级手填共用） */
  const applyDsn = (raw: string): boolean => {
    try {
      const u = new URL(raw.trim())
      setHost(u.hostname || '127.0.0.1')
      setPort(u.port || '5432')
      setDatabase(decodeURIComponent(u.pathname.replace(/^\//, '')) || 'teslamate')
      if (u.username) setUser(decodeURIComponent(u.username))
      if (u.password) setPassword(decodeURIComponent(u.password))
      setDsnError('')
      return true
    } catch {
      setDsnError('DSN 格式无法解析，示例：postgres://user:pass@host:5432/teslamate')
      return false
    }
  }

  const onAutoRo = async () => {
    setRoBusy(true)
    setRoFail(null)
    try {
      const r = await api.setupAutoRo({
        host: host.trim() || '127.0.0.1',
        port: Number(port) || 5432,
        database: database.trim() || 'teslamate',
        user: adminUser.trim(),
        password: adminPwd,
      })
      if (r.ok) {
        applyDsn(r.dsn)
        setRoDone(true)
        toast('只读账号已创建，连接信息已填入下方表单', 'success')
      } else {
        setRoFail({ stage: r.stage, error: r.error, fallbackSql: r.fallbackSql })
      }
    } catch (err) {
      setRoFail({ stage: 'network', error: err instanceof Error ? err.message : '请求失败', fallbackSql: '' })
    } finally {
      setRoBusy(false)
    }
  }

  const copySql = async () => {
    if (!roFail?.fallbackSql) return
    try {
      await navigator.clipboard.writeText(roFail.fallbackSql)
      toast('SQL 已复制', 'success')
    } catch {
      /* 剪贴板不可用（如非安全上下文）→ 用户可手动选择文本复制 */
    }
  }

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

  // m4a 轨道A：捆绑 TeslaMate 的地址按当前访问主机推导（容器网络内同宿主可达）
  const teslamateUrl = `http://${typeof window !== 'undefined' && window.location.hostname ? window.location.hostname : '127.0.0.1'}:4000/sessions/new`

  return (
    <div className="glass-card space-y-5 p-6" data-testid="setup-datasource">
      <div>
        <h2 className="text-lg font-semibold text-white">{t('setup.s2.title', '接入数据源')}</h2>
        <p className="mt-1 text-xs text-slate-500">{t('setup.s2.desc', '已有 TeslaMate？填数据库直连。新用户？用全栈部署。')}</p>
      </div>

      <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="接入模式">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'connect'}
          className={`rounded-xl border px-3 py-2.5 text-sm transition ${mode === 'connect' ? 'border-tesla bg-tesla/10 text-white' : 'border-slate-800 text-slate-400 hover:border-white/20 hover:text-slate-200'}`}
          onClick={() => setMode('connect')}
          data-testid="setup-mode-connect"
        >
          {t('setup.mode.a', 'A · 我已有 TeslaMate')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'fullstack'}
          className={`rounded-xl border px-3 py-2.5 text-sm transition ${mode === 'fullstack' ? 'border-tesla bg-tesla/10 text-white' : 'border-slate-800 text-slate-400 hover:border-white/20 hover:text-slate-200'}`}
          onClick={() => setMode('fullstack')}
          data-testid="setup-mode-fullstack"
        >
          {t('setup.mode.b', 'B · 新用户全栈部署')}
        </button>
      </div>

      {mode === 'connect' ? (
        <div className="space-y-3">
          {/* a. 自动发现：探测可达库，点选预填（无结果静默收起） */}
          {probing && <div className="skeleton h-14" data-testid="probe-skeleton" />}
          {!probing && candidates && candidates.length > 0 && (
            <div className="space-y-1.5" data-testid="probe-candidates">
              <p className="text-xs font-medium text-slate-400">{t('setup.discover.title', '发现可达的 TeslaMate 数据库')}</p>
              {candidates.map((c) => (
                <button
                  key={`${c.host}:${c.port}`}
                  type="button"
                  data-testid={`probe-candidate-${c.host}`}
                  onClick={() => { setHost(c.host); setPort(String(c.port)) }}
                  className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm transition ${
                    host === c.host ? 'border-tesla bg-tesla/10 text-white' : 'border-slate-800 text-slate-300 hover:border-white/20 hover:text-white'
                  }`}
                >
                  <span className="num">{c.host}:{c.port}</span>
                  <span className="text-[11px] text-slate-500">{c.source}</span>
                </button>
              ))}
            </div>
          )}

          {/* b. 一键建只读账号：管理凭据仅本次使用，不落盘 */}
          <div className="space-y-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5" data-testid="auto-ro-panel">
            <div className="text-xs font-medium text-slate-300">{t('setup.autoRo.title', '一键创建只读账号（推荐）')}</div>
            <p className="text-[11px] leading-relaxed text-slate-500">
              {t('setup.autoRo.desc', '用 TeslaMate 管理员凭据自动创建只读账号并填入下方表单；凭据仅本次使用，不落盘。')}
            </p>
            <details className="text-[11px] text-slate-500">
              <summary className="cursor-pointer select-none">密码在哪找？</summary>
              <p className="mt-1 pl-3">在 TeslaMate 部署目录的 docker-compose.yml（DATABASE_PASS 环境变量）或 .env 文件中。</p>
            </details>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="auto-ro-user" className="mb-1.5 block text-xs font-medium text-slate-400">{t('setup.autoRo.user', 'TeslaMate 管理用户名')}</label>
                <input id="auto-ro-user" data-testid="auto-ro-user" className="input-dark" value={adminUser} onChange={(e) => setAdminUser(e.target.value)} placeholder="teslamate" autoComplete="off" />
              </div>
              <div>
                <label htmlFor="auto-ro-pwd" className="mb-1.5 block text-xs font-medium text-slate-400">{t('setup.autoRo.pwd', '管理密码')}</label>
                <input id="auto-ro-pwd" data-testid="auto-ro-pwd" className="input-dark" type="password" value={adminPwd} onChange={(e) => setAdminPwd(e.target.value)} placeholder="••••••" autoComplete="off" />
              </div>
            </div>
            <button
              type="button"
              data-testid="auto-ro-button"
              className="btn-primary w-full"
              disabled={roBusy || !adminUser.trim() || !adminPwd || !host.trim()}
              onClick={onAutoRo}
            >
              {roBusy ? t('setup.autoRo.creating', '创建中…') : roDone ? t('setup.autoRo.done', '已创建 ✓') : t('setup.autoRo.button', '自动创建只读账号')}
            </button>
            {roFail && (
              <div className="space-y-2" data-testid="auto-ro-fail">
                <p role="alert" className="text-xs text-tesla-soft">
                  自动创建失败（{roFail.stage}）：{roFail.error}{roFail.fallbackSql ? '。请手工执行以下 SQL 后点「我已手工执行」：' : ''}
                </p>
                {roFail.fallbackSql && (
                  <pre data-testid="auto-ro-sql" className="num max-h-40 overflow-auto rounded-lg border border-white/[0.08] bg-base-950/60 p-2.5 text-[11px] leading-relaxed text-slate-300">{roFail.fallbackSql}</pre>
                )}
                <div className="flex gap-2">
                  {roFail.fallbackSql && (
                    <button type="button" data-testid="auto-ro-copy" className="btn-mini" onClick={copySql}>
                      <Copy className="h-3.5 w-3.5" /> {t('setup.autoRo.copySql', '复制 SQL')}
                    </button>
                  )}
                  <button type="button" data-testid="auto-ro-done" className="btn-mini" onClick={() => { setRoFail(null); setRoDone(true) }}>
                    {t('setup.autoRo.doneBtn', '我已手工执行')}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* c. 连接表单（最终确认层，四级校验入口） */}
          <div className="grid grid-cols-[1fr_88px] gap-3">
            <Field id="setup-host" label="PostgreSQL Host" value={host} onChange={setHost} placeholder="127.0.0.1" />
            <Field id="setup-port" label={t('setup.field.port', '端口')} value={port} onChange={setPort} placeholder="5432" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field id="setup-db" label={t('setup.field.db', '库名')} value={database} onChange={setDatabase} placeholder="teslamate" />
            <Field id="setup-user" label={t('setup.field.user', '用户名（只读账号）')} value={user} onChange={setUser} placeholder="ahatesla_ro" />
          </div>
          <Field id="setup-pwd" label={t('setup.field.pwd', '密码')} type="password" value={password} onChange={setPassword} placeholder="只读账号密码" />

          <button
            type="button"
            className="btn-primary w-full"
            disabled={!canSubmit || checking}
            onClick={onTest}
            data-testid="setup-test-connection"
          >
            {checking ? t('setup.checking', '测试中…') : t('setup.testConn', '测试并验证')}
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
                    <span className="text-slate-200">{(CHECK_LABELS[s.name] && t(CHECK_LABELS[s.name].key, CHECK_LABELS[s.name].zh)) ?? s.name}</span>
                    {s.detail && <span className="block text-xs text-slate-500">{s.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {verified && (
            <p className="flex items-center gap-1.5 text-sm text-emerald-400" data-testid="setup-verified">
              <ShieldCheck className="h-4 w-4" /> {t('setup.verified', '校验通过，可保存接入')}
            </p>
          )}

          {/* 高级：手动粘贴 DSN 兜底（TeslaMate 在其他机器/裸机场景） */}
          <div data-testid="setup-advanced">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
              className="flex w-full items-center justify-center gap-1 text-xs text-slate-500 transition hover:text-slate-300"
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
              高级 · 手动粘贴 DSN
            </button>
            {advancedOpen && (
              <div className="mt-2 space-y-2">
                <input
                  aria-label="postgres:// DSN"
                  data-testid="setup-dsn-input"
                  className="input-dark num"
                  value={dsn}
                  onChange={(e) => setDsn(e.target.value)}
                  placeholder="postgres://user:pass@host:5432/teslamate"
                />
                {dsnError && <p role="alert" className="text-[11px] text-tesla-soft">{dsnError}</p>}
                <button type="button" data-testid="setup-dsn-apply" className="btn-mini" disabled={!dsn.trim()} onClick={() => applyDsn(dsn)}>
                  解析并填入
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3" data-testid="setup-fullstack-panel">
          {/* m4a 轨道A：Tesla 登录引导（授权只在 TeslaMate，AhaTesla 不碰 Tesla 密码） */}
          <div className="space-y-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5" data-testid="tesla-login-guide">
            <div className="text-xs font-medium text-slate-300">{t('setup.tesla.title', '在 TeslaMate 中登录你的 Tesla 账号')}</div>
            <p className="text-[11px] leading-relaxed text-slate-500">
              {t('setup.tesla.desc', '登录后 TeslaMate 开始同步车辆数据，本页会自动检测到车辆并继续，无需其他操作。')}
            </p>
            <span data-testid="setup-teslamate-link">
              <a
                href={teslamateUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-tesla hover:underline"
                data-testid="tesla-login-link"
              >
                {t('setup.tesla.link', '打开 TeslaMate 登录页')} <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </span>
            <p className="num text-[11px] text-slate-500">{teslamateUrl}</p>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-400">
            <li>在上方卡片打开 TeslaMate，完成 Tesla 账号授权（授权仅发生在 TeslaMate，AhaTesla 不接触 Tesla 密码）。</li>
            <li>回到本页，向导会自动轮询发现你的车辆（最长 60 秒）。</li>
          </ol>
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-300">
            <Lock className="mr-1 inline h-3.5 w-3.5" />
            安全提示：TeslaMate Web 默认无密码，请勿将 4000 端口映射公网；建议仅内网访问并由 AhaTesla 反代保护（AC-4.1）。
          </p>
          {saved && !discovery?.found && (
            <p className="flex items-center gap-2 text-sm text-slate-400" data-testid="setup-discovery-polling">
              <CircleDashed className="h-4 w-4 animate-spin text-tesla" />
              {t('setup.tesla.waiting', '正在等待车辆出现（TeslaMate 完成授权后自动发现）…')}
            </p>
          )}
        </div>
      )}

      {error && <div role="alert" className="rounded-lg border border-tesla/30 bg-tesla/10 px-3 py-2 text-xs text-tesla-soft">{error}</div>}

      {discovery?.found && (
        <div className="space-y-2" data-testid="setup-car-found">
          {multiCar ? (
            <>
              <p className="text-sm text-slate-300">{t('setup.tesla.foundPrefix', '发现')} {discovery.cars.length} {t('setup.tesla.foundSuffix', '辆车，请选择主绑定车辆：')}</p>
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
          {saved ? t('setup.saved', '已保存') : t('setup.save', '保存数据源')}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={!readyToNext}
          onClick={onDone}
          data-testid="setup-next"
        >
          {t('setup.next', '下一步')}
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
      className={`flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-left text-sm transition ${
        selected ? 'border-tesla bg-tesla/10 text-white' : 'border-slate-800 text-slate-300 hover:border-white/20 hover:text-white'
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
  const { t } = useI18n()
  return (
    <div className="glass-card space-y-4 p-6" data-testid="setup-ledger">
      <div>
        <h2 className="text-lg font-semibold text-white">{t('setup.s3.title', '账本初始化')}</h2>
        <p className="mt-1 text-xs text-slate-500">{t('setup.s3.desc', '可跳过——稍后在「电价」与「系统设置」中随时补配。')}</p>
      </div>
      <ul className="space-y-2 text-sm text-slate-300">
        <li>· {t('setup.s3.defaultRate', '默认电价：0.60 元/kWh（可在电价页修改）')}</li>
        <li>· {t('setup.s3.fuelBaseline', '油车对比基准：8.0 L/100km @ 8.20 元/L')}</li>
      </ul>
      <div className="flex gap-2">
        <button type="button" className="btn-ghost flex-1" onClick={onSkip} data-testid="setup-skip-ledger">
          {t('setup.skip', '跳过')}
        </button>
        <button type="button" className="btn-primary flex-1" onClick={onDone} data-testid="setup-ledger-next">
          {t('setup.continue', '好，继续')}
        </button>
      </div>
    </div>
  )
}

// ---- Step 4 通知渠道（可跳过；HTTPS 检测 AC-11.0）----

function Step4Notify({ https, onDone, onSkip }: { https: boolean; onDone: () => void; onSkip: () => void }) {
  const { t } = useI18n()
  return (
    <div className="glass-card space-y-4 p-6" data-testid="setup-notify">
      <div>
        <h2 className="text-lg font-semibold text-white">{t('setup.s4.title', '通知渠道')}</h2>
        <p className="mt-1 text-xs text-slate-500">{t('setup.s4.desc', '可跳过——稍后在「推送」页配置 Web Push / Telegram / 飞书。')}</p>
      </div>
      {https ? (
        <button type="button" className="btn-primary w-full" onClick={onDone} data-testid="setup-enable-webpush">
          {t('setup.s4.webpush', '一键开启 Web Push')}
        </button>
      ) : (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300" data-testid="setup-http-warning">
          {t('push.webpush.https', '当前为非 HTTPS 环境，Web Push 不可用。建议配置反代启用 HTTPS，或优先绑定 Telegram / 飞书。')}
        </p>
      )}
      <div className="flex gap-2">
        <button type="button" className="btn-ghost flex-1" onClick={onSkip} data-testid="setup-skip-notify">
          {t('setup.skip', '跳过')}
        </button>
        <button type="button" className="btn-primary flex-1" onClick={onDone} data-testid="setup-finish">
          {t('setup.finish', '完成向导')}
        </button>
      </div>
    </div>
  )
}
