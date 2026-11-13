import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation } from 'react-router-dom'
import {
  Activity,
  ChevronDown,
  BellRing,
  Calculator,
  Car,
  KeyRound,
  Palette,
  Settings as SettingsIcon,
  Sparkles,
  Tag,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useCar } from '@/contexts/CarContext'
import { useTheme, type ThemeSetting } from '@/contexts/ThemeContext'
import { useI18n, type Lang } from '@/i18n'
import { api } from '@/api/client'
import { useToast } from '@/components/Toast'
import { PageHeader } from '@/components/PageHeader'
import { Toggle } from '@/components/Toggle'
import { PricingSection } from '@/components/settings/PricingSection'
import { SystemSection } from '@/components/settings/SystemSection'
import type { PushEventId, PushChannelId } from '@/types'

const CURRENCIES = [
  { symbol: '¥', code: 'CNY', label: '¥ 人民币' },
  { symbol: '$', code: 'USD', label: '$ 美元' },
  { symbol: '€', code: 'EUR', label: '€ 欧元' },
  { symbol: '£', code: 'GBP', label: '£ 英镑' },
]

const EVENTS: { id: PushEventId; labelKey: string; label: string; descKey: string; desc: string }[] = [
  { id: 'tripEnd', labelKey: 'settings.ev.tripEnd', label: '行程结束小结', descKey: 'settings.ev.tripEnd.desc', desc: '每次行程结束推送费用与路线概要' },
  { id: 'chargingStart', labelKey: 'settings.ev.chargingStart', label: '充电开始提醒', descKey: 'settings.ev.chargingStart.desc', desc: '插入充电枪开始充电时' },
  { id: 'chargingDone', labelKey: 'settings.ev.chargingDone', label: '充电完成账单', descKey: 'settings.ev.chargingDone.desc', desc: '充电结束推送电量与费用' },
  { id: 'outage', labelKey: 'settings.ev.outage', label: '数据断联告警', descKey: 'settings.ev.outage.desc', desc: '告警 · TeslaMate 断联≥10 分钟/恢复,不受静音时段影响' },
  { id: 'chargeInterrupt', labelKey: 'settings.ev.chargeInterrupt', label: '充电提前中止', descKey: 'settings.ev.chargeInterrupt.desc', desc: '告警 · 充电未到 80% 即停止时提醒检查枪桩' },
  { id: 'tirePressure', labelKey: 'settings.ev.tirePressure', label: '胎压过低', descKey: 'settings.ev.tirePressure.desc', desc: '告警 · 四轮最低低于 2.6 bar 时提醒(24h 一次)' },
  { id: 'daily', labelKey: 'settings.ev.daily', label: '每日早报', descKey: 'settings.ev.daily.desc', desc: '每天 08:00 汇总昨日用车与充电' },
  { id: 'weekly', labelKey: 'settings.ev.weekly', label: '每周周报', descKey: 'settings.ev.weekly.desc', desc: '每周一 08:00 汇总上周' },
  { id: 'monthly', labelKey: 'settings.ev.monthly', label: '每月月报', descKey: 'settings.ev.monthly.desc', desc: '每月 1 日 08:00 汇总上月' },
]
const CHANNELS: { id: PushChannelId; labelKey: string; label: string }[] = [
  { id: 'webpush', labelKey: 'settings.ch.webpush', label: 'Web Push' },
  { id: 'telegram', labelKey: 'settings.ch.telegram', label: 'Telegram' },
  { id: 'feishu', labelKey: 'settings.ch.feishu', label: '飞书' },
  { id: 'wecom', labelKey: 'settings.ch.wecom', label: '企业微信' },
  { id: 'ntfy', labelKey: 'settings.ch.ntfy', label: 'ntfy' },
  { id: 'bark', labelKey: 'settings.ch.bark', label: 'Bark' },
]

const THEME_OPTIONS: { id: ThemeSetting; key: string; zh: string }[] = [
  { id: 'system', key: 'settings.theme.system', zh: '跟随系统' },
  { id: 'light', key: 'settings.theme.light', zh: '浅色' },
  { id: 'dark', key: 'settings.theme.dark', zh: '深色' },
]
const LANG_OPTIONS: { id: Lang; key: string; zh: string }[] = [
  { id: 'zh', key: 'settings.lang.zh', zh: '中文' },
  { id: 'en', key: 'settings.lang.en', zh: 'English' },
]

/** 折叠分区卡（v0.3）：头部 = 图标 + 标题 + 右侧摘要 + chevron，点击展开身体。
 *  锚点直达（nav 点击 / #hash）由外层 effect 自动展开目标分区。 */
function CollapseCard({ id, icon: Icon, title, summary, open, onToggle, testid, children }: {
  id: string
  icon: typeof Palette
  title: string
  summary?: string
  open: boolean
  onToggle: () => void
  testid?: string
  children: React.ReactNode
}) {
  return (
    <section id={`settings-${id}`} className="glass-card-flat scroll-mt-6" data-testid={testid ?? `settings-${id}`} data-open={open}>
      <button
        type="button"
        className="flex w-full items-center gap-2.5 p-4 text-left transition hover:bg-white/[0.03]"
        onClick={onToggle}
        aria-expanded={open}
        data-testid={`settings-${id}-header`}
      >
        <Icon className="h-4 w-4 shrink-0 text-tesla" />
        <span className="shrink-0 text-[13px] font-medium tracking-wide text-slate-200">{title}</span>
        {summary && <span className="ml-1 min-w-0 flex-1 truncate text-right text-[11px] text-slate-500">{summary}</span>}
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="border-t border-white/[0.06] px-5 pb-5 pt-4">{children}</div>}
    </section>
  )
}

/** 设置页分区导航（桌面侧栏锚点 / 移动横向滚动）— v2.4 与卡片一一对应 */
function SettingsNav({ active }: { active: string }) {
  const { t } = useI18n()
  // v0.3 顺序：日常会动的（电价/账本/推送）提前，一次性的（AI/车辆）靠后
  const items = [
    { id: 'appearance', label: t('settings.nav.appearance', '外观'), icon: Palette },
    { id: 'pricing', label: t('settings.nav.pricing', '电价'), icon: Tag },
    { id: 'ledger', label: t('settings.nav.ledger', '账本参数'), icon: Calculator },
    { id: 'push', label: t('settings.nav.push', '推送'), icon: BellRing },
    { id: 'ai', label: t('settings.nav.ai', 'AI 助手'), icon: Sparkles },
    { id: 'cars', label: t('settings.nav.cars', '车辆'), icon: Car },
    { id: 'system', label: t('settings.nav.system', '系统'), icon: Activity },
    { id: 'security', label: t('settings.nav.security', '账户安全'), icon: KeyRound },
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
  const { user } = useAuth()
  const { toast } = useToast()
  const { theme, setTheme } = useTheme()
  const { lang, setLang, t } = useI18n()
  const queryClient = useQueryClient()
  const location = useLocation()
  const [activeSection, setActiveSection] = useState('appearance')
  // 折叠分区（v0.3）：默认全收起；展开态记忆到本设备
  const [openSections, setOpenSections] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('ahatesla_settings_open')
      return new Set(saved ? (JSON.parse(saved) as string[]) : [])
    } catch {
      return new Set()
    }
  })
  const toggleSection = (id: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try { localStorage.setItem('ahatesla_settings_open', JSON.stringify([...next])) } catch { /* 仅本会话生效 */ }
      return next
    })
  }
  const themeLabel = () =>
    theme === 'dark' ? t('settings.theme.dark', '深色') : theme === 'light' ? t('settings.theme.light', '浅色') : t('settings.theme.system', '跟随系统')
  const langLabel = () => (lang === 'zh' ? '中文' : 'English')

  // 锚点直达：/settings#settings-xxx（头像菜单「账户安全」等入口）。
  // react-router 不会自动滚 hash；路由切换有渲染时差，rAF 重试若干帧（分区骨架同步渲染，通常 1~2 帧内命中）。
  // 注意用瞬时滚动（非 smooth）：分区数据（电价表/事件日志）异步到达会推高布局，
  // smooth 的目标像素在起滚瞬间已定，会落在半路；瞬时 + 400/900ms 两次补滚校正。
  useEffect(() => {
    const hash = location.hash
    if (!hash.startsWith('#settings-')) return
    const id = hash.slice(1).replace('settings-', '')
    setActiveSection(id)
    // 锚点直达 = 先展开目标分区（收起态内容未渲染，滚了也看不见）
    setOpenSections((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
    let tries = 0
    let raf = 0
    const timers: number[] = []
    const scrollTo = () => {
      const el = document.getElementById(`settings-${id}`)
      if (el) el.scrollIntoView({ block: 'start' })
      return el != null
    }
    const tick = () => {
      if (scrollTo()) return
      if (++tries < 90) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    timers.push(window.setTimeout(scrollTo, 400), window.setTimeout(scrollTo, 900))
    return () => {
      cancelAnimationFrame(raf)
      timers.forEach((h) => window.clearTimeout(h))
    }
  }, [location.hash])

  // 滚动监听高亮当前分区（IntersectionObserver 不可用时静默降级）
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const ids = ['appearance', 'pricing', 'ledger', 'push', 'ai', 'cars', 'system', 'security']
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

  // ---- m4e 车辆管理(主车/别名;车清单来自 useCar) ----
  const { cars } = useCar()
  const [carPrimaryId, setCarPrimaryId] = useState<number | null>(null)
  const [carAliases, setCarAliases] = useState<Record<string, string>>({})
  useEffect(() => {
    if (cars.length && carPrimaryId == null) {
      setCarPrimaryId(cars.find((c) => c.isPrimary)?.id ?? cars[0]?.id ?? null)
      setCarAliases(Object.fromEntries(cars.map((c) => [String(c.id), c.alias ?? ''])))
    }
  }, [cars, carPrimaryId])

  const saveCars = useMutation({
    mutationFn: () =>
      api.saveSettings({
        primaryCarId: carPrimaryId ?? undefined,
        carAliases,
      }),
    onSuccess: () => {
      toast(t('settings.cars.saved', '车辆设置已保存'), 'success')
      void queryClient.invalidateQueries({ queryKey: ['cars'] })
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  // ---- 账本参数 ----
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings })

  const [currency, setCurrency] = useState('¥')
  const [distanceUnit, setDistanceUnit] = useState<'km' | 'mi'>('km')
  const [liter, setLiter] = useState('8.0')
  const [fuelPrice, setFuelPrice] = useState('8.20')

  useEffect(() => {
    if (settings) {
      setCurrency(settings.currency.symbol)
      setDistanceUnit(settings.distanceUnit)
      setLiter(String(settings.fuelBaseline.literPer100km))
      setFuelPrice(String(settings.fuelBaseline.fuelPriceCnyPerL))
    }
  }, [settings])

  const saveSettings = useMutation({
    mutationFn: () =>
      api.saveSettings({
        currency: { symbol: currency, code: CURRENCIES.find((c) => c.symbol === currency)?.code ?? 'CNY' },
        distanceUnit,
        fuelBaseline: { literPer100km: Number(liter), fuelPriceCnyPerL: Number(fuelPrice) },
      }),
    onSuccess: () => {
      toast(t('settings.saved', '设置已保存'), 'success')
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
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
      toast(t('settings.recalc.started', '重算已启动'), 'success')
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        try {
          const job = await api.recalculateStatus(jobId)
          setRecalcProgress(Math.round(job.progress * 100))
          if (job.status !== 'running') {
            if (pollRef.current) clearInterval(pollRef.current)
            toast(job.status === 'done' ? t('settings.recalc.done', '历史账本重算完成') : t('settings.recalc.failed', '重算失败'), job.status === 'done' ? 'success' : 'error')
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
  // v0.3 推送分区简化：事件级总开关只作用于「已配置渠道」（渠道增删在推送页）
  const { data: channelStatus } = useQuery({ queryKey: ['channel-status-lite'], queryFn: api.channelStatus, retry: false, staleTime: 60_000 })
  const configuredChannels: PushChannelId[] = useMemo(() => {
    const cs = channelStatus
    const out: PushChannelId[] = []
    if (!cs) return ['webpush'] // 状态未到时按默认渠道兜底
    if (cs.webpush?.configured) out.push('webpush')
    if (cs.telegram?.connected) out.push('telegram')
    if (cs.feishu?.connected) out.push('feishu')
    if (cs.wecom?.configured) out.push('wecom')
    if (cs.ntfy?.configured) out.push('ntfy')
    if (cs.bark?.configured) out.push('bark')
    return out.length ? out : ['webpush']
  }, [channelStatus])
  const [matrix, setMatrix] = useState<Record<string, Record<string, boolean>> | null>(null)
  useEffect(() => {
    if (pushRules?.matrix) setMatrix(pushRules.matrix)
  }, [pushRules])

  const saveMatrix = useMutation({
    mutationFn: (m: Record<string, Record<string, boolean>>) =>
      api.setPushRulesV2({ matrix: m as never, weeklyReportDay: pushRules?.weeklyReportDay ?? 1 }),
    onSuccess: () => toast(t('settings.push.matrixSaved', '推送矩阵已保存'), 'success'),
    onError: (err) => toast(err.message, 'error'),
  })

  /** 事件级总开关（v0.3）：on = 该事件在所有已配置渠道上启用（未配置渠道置 false）；
   *  off = 该事件全渠道静音。渠道粒度配置移至推送页。 */
  const toggleEvent = (event: PushEventId, on: boolean) => {
    if (!matrix) return
    const row: Record<string, boolean> = {}
    for (const ch of CHANNELS) row[ch.id] = on && configuredChannels.includes(ch.id)
    const next = { ...matrix, [event]: row }
    setMatrix(next)
    saveMatrix.mutate(next)
  }

  // ---- AI 助手（BYO 模型，密钥只存服务端加密，回显只给别名） ----
  const { data: aiCfg } = useQuery({ queryKey: ['ai-config'], queryFn: api.aiConfig })
  const [aiEnabled, setAiEnabled] = useState(false)
  const [aiBaseUrl, setAiBaseUrl] = useState('')
  const [aiModel, setAiModel] = useState('')
  const [aiApiKey, setAiApiKey] = useState('')

  useEffect(() => {
    if (aiCfg) {
      setAiEnabled(aiCfg.enabled)
      setAiBaseUrl(aiCfg.baseUrl)
      setAiModel(aiCfg.model)
    }
  }, [aiCfg])

  const saveAi = useMutation({
    mutationFn: () =>
      api.saveAiConfig({
        enabled: aiEnabled,
        baseUrl: aiBaseUrl.trim(),
        model: aiModel.trim(),
        // 留空=不修改已有密钥；显式输入才随保存提交
        ...(aiApiKey.trim() ? { apiKey: aiApiKey.trim() } : {}),
      }),
    onSuccess: () => {
      toast(t('settings.ai.savedToast', 'AI 配置已保存'), 'success')
      setAiApiKey('')
      void queryClient.invalidateQueries({ queryKey: ['ai-config'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  const testAi = useMutation({
    mutationFn: api.aiTest,
    onSuccess: (r) => {
      if (r.ok && r.preview) toast(`${t('settings.ai.ok', '连通正常')}：${r.preview.slice(0, 50)}`, 'success')
      else if (r.ok) toast(t('settings.ai.ok', '连通正常'), 'success')
      else toast(r.error ?? t('settings.ai.testFailed', '测试失败'), 'error')
    },
    onError: (err) => toast(err.message, 'error'),
  })

  // ---- 账户（用户名 + 密码） ----
  const [username, setUsername] = useState('')
  const [usernameTouched, setUsernameTouched] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 仅在用户未编辑过时同步外部用户名（me 晚到不打断输入）
  useEffect(() => {
    if (!usernameTouched && user?.username) setUsername(user.username)
  }, [user?.username, usernameTouched])

  const onSubmitPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    const name = username.trim()
    const nameChanged = name !== (user?.username ?? '')
    if (nameChanged && name.length < 3) {
      setError(t('settings.pw.err.nameShort', '用户名至少 3 个字符'))
      return
    }
    if (newPassword && newPassword.length < 8) {
      setError(t('settings.pw.err.pwShort', '新密码至少 8 位'))
      return
    }
    if (newPassword !== confirmPassword) {
      setError(t('settings.pw.err.mismatch', '两次输入的新密码不一致'))
      return
    }
    if (!nameChanged && !newPassword) {
      setError(t('settings.pw.err.noChange', '没有需要保存的修改'))
      return
    }
    setSubmitting(true)
    try {
      await api.changeAccount({
        oldPassword,
        newPassword: newPassword || undefined,
        newUsername: nameChanged ? name : undefined,
      })
      toast(t('settings.pw.saved', '账户已更新'), 'success')
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.pw.err.failed', '修改失败'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fade-up">
      <PageHeader
        icon={SettingsIcon}
        title={t('settings.title', '设置')}
        subtitle={`${user?.username ?? ''} · ${t('settings.subtitle', '单用户模式')}`}
      />

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

          {/* ===== 分区1：外观（主题 + 语言，设备本地偏好） ===== */}
          <CollapseCard id="appearance" icon={Palette} title={t('settings.nav.appearance', '外观')} summary={`${themeLabel()} · ${langLabel()}`} open={openSections.has('appearance')} onToggle={() => toggleSection('appearance')} testid="settings-appearance">
            <p className="section-desc mt-1">{t('settings.appearance.desc', '主题与语言（保存在本设备）')}</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <div className="mb-2 text-xs font-medium text-slate-400">{t('settings.theme', '主题')}</div>
                <div className="seg w-full" role="radiogroup" aria-label={t('settings.theme', '主题')}>
                  {THEME_OPTIONS.map((o) => (
                    <button
                      key={o.id}
                      onClick={() => setTheme(o.id)}
                      className={`seg-item ${theme === o.id ? 'seg-item-active' : ''}`}
                      role="radio"
                      aria-checked={theme === o.id}
                      data-testid={`theme-${o.id}`}
                    >
                      {t(o.key, o.zh)}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-2 text-xs font-medium text-slate-400">{t('settings.lang', '语言')}</div>
                <div className="seg w-full" role="radiogroup" aria-label={t('settings.lang', '语言')}>
                  {LANG_OPTIONS.map((o) => (
                    <button
                      key={o.id}
                      onClick={() => setLang(o.id)}
                      className={`seg-item ${lang === o.id ? 'seg-item-active' : ''}`}
                      role="radio"
                      aria-checked={lang === o.id}
                      data-testid={`lang-${o.id}`}
                    >
                      {t(o.key, o.zh)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </CollapseCard>

          {/* ===== 分区3：电价（默认价 + 地点电价含分时 + 历史） ===== */}
          <CollapseCard id="pricing" icon={Tag} title={t('settings.nav.pricing', '电价')} summary={t('settings.sum.pricing', '默认价 · 地点 · 历史')} open={openSections.has('pricing')} onToggle={() => toggleSection('pricing')} testid="settings-pricing">
            <p className="section-desc mt-1">{t('settings.pricing.desc', '默认电价 · 地点电价（含分时）· 费率变更历史')}</p>
            <div className="mt-4">
              <PricingSection />
            </div>
          </CollapseCard>

          {/* ===== 分区2：账本参数（货币/单位/油车基准 + 重算） ===== */}
          <CollapseCard id="ledger" icon={Calculator} title={t('settings.nav.ledger', '账本参数')} summary={settings ? `${currency}${' · '}${distanceUnit}${' · '}${liter}L@${fuelPrice}` : undefined} open={openSections.has('ledger')} onToggle={() => toggleSection('ledger')} testid="settings-ledger">
            <p className="section-desc mt-1">{t('settings.ledger.desc', '货币单位 · 油车对比基准 · 历史重算')}</p>

            {/* 货币 + 单位：分段控件 */}
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <div className="mb-2 text-xs font-medium text-slate-400">{t('settings.currency', '货币单位')}</div>
                <div className="seg w-full" role="radiogroup" aria-label={t('settings.currency', '货币单位')}>
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
                <div className="mb-2 text-xs font-medium text-slate-400">{t('settings.distance', '距离单位')}</div>
                <div className="seg w-full" role="radiogroup" aria-label={t('settings.distance', '距离单位')}>
                  {(['km', 'mi'] as const).map((u) => (
                    <button
                      key={u}
                      onClick={() => setDistanceUnit(u)}
                      className={`seg-item ${distanceUnit === u ? 'seg-item-active' : ''}`}
                      role="radio"
                      aria-checked={distanceUnit === u}
                      data-testid={`unit-${u}`}
                    >
                      {u === 'km' ? t('settings.unit.km', '公里') : t('settings.unit.mi', '英里')}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 油车基准 */}
            <div className="mt-5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium text-slate-300">{t('settings.fuel', '油车对比基准')}</div>
                <div className="num text-[11px] text-slate-500">
                  ≈ {((Number(liter) || 0) / 100 * (Number(fuelPrice) || 0)).toFixed(3)} {currency}/km
                </div>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">{t('settings.fuel.consumption', '百公里油耗')}</label>
                  <div className="relative">
                    <input type="number" step="0.1" min="1" max="30" inputMode="decimal" className="input-dark num pr-16" value={liter} onChange={(e) => setLiter(e.target.value)} aria-label={`${t('settings.fuel.consumption', '百公里油耗')}（L）`} data-testid="fuel-liter" />
                    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-500">L/100km</span>
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">{t('settings.fuel.price', '油价')}</label>
                  <div className="relative">
                    <input type="number" step="0.01" min="1" max="50" inputMode="decimal" className="input-dark num pr-10" value={fuelPrice} onChange={(e) => setFuelPrice(e.target.value)} aria-label={`${t('settings.fuel.price', '油价')}（${currency}/L）`} data-testid="fuel-price" />
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
              {saveSettings.isPending ? t('settings.saving', '保存中…') : t('settings.save', '保存参数')}
            </button>

            {/* 重算历史账本 */}
            <div className="mt-6 border-t border-white/[0.06] pt-5" data-testid="settings-recalc">
              <h3 className="text-xs font-medium text-slate-300">{t('settings.recalc', '重算历史账本')}</h3>
              <p className="section-desc mt-1">{t('settings.recalc.desc', '按当前电价规则与补录费用全量重算（不影响已推送小结快照）')}</p>
              <div className="mt-3 flex max-w-md items-center gap-4">
                <button
                  className="btn-ghost flex-1"
                  onClick={() => startRecalc.mutate()}
                  disabled={startRecalc.isPending || recalcJob != null}
                  data-testid="recalc-button"
                >
                  {recalcJob ? t('settings.recalc.running', '重算中 {p}%').replace('{p}', String(recalcProgress)) : t('settings.recalc.start', '开始重算')}
                </button>
              </div>
              {recalcJob != null && (
                <div className="mt-3 h-1.5 max-w-md overflow-hidden rounded-full bg-white/[0.06]" data-testid="recalc-progress">
                  <div className="h-full rounded-full bg-tesla transition-all duration-500" style={{ width: `${recalcProgress}%` }} />
                </div>
              )}
            </div>
          </CollapseCard>

          {/* ===== 分区5：推送矩阵 ===== */}
          <CollapseCard id="push" icon={BellRing} title={t('settings.nav.push', '推送')} summary={matrix ? `${EVENTS.filter((ev) => CHANNELS.some((ch) => matrix[ev.id]?.[ch.id])).length}/${EVENTS.length} ${t('settings.sum.eventsOn', '事件启用')}` : undefined} open={openSections.has('push')} onToggle={() => toggleSection('push')} testid="settings-push-matrix">
            <p className="section-desc mt-1">
              {t('settings.push.descV2', '每个事件一个总开关（作用于所有已配置渠道）；渠道密钥与细粒度配置在「推送」页')}
              {/* 修复：/push 页此前从任何导航都到不了（矩阵文案提到却无入口） */}
              {' '}
              <Link to="/push" className="text-tesla hover:underline" data-testid="settings-push-page-link">
                {t('settings.push.openChannelPage', '前往渠道配置 →')}
              </Link>
            </p>
            {matrix ? (
              <div className="mt-4 divide-y divide-white/[0.05]" data-testid="push-matrix-list">
                {EVENTS.map((ev) => {
                  const enabled = CHANNELS.filter((ch) => matrix[ev.id]?.[ch.id])
                  const on = enabled.length > 0
                  return (
                    <div key={ev.id} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <div className="text-[13px] text-slate-200">{t(ev.labelKey, ev.label)}</div>
                        <div className="mt-0.5 text-[11px] text-slate-500">{t(ev.descKey, ev.desc)}</div>
                        <div className="mt-0.5 truncate text-[11px]">
                          {on ? (
                            <span className="text-emerald-400/90">
                              {t('settings.push.viaChannels', '经')} {enabled.map((ch) => t(ch.labelKey, ch.label)).join(' · ')}
                            </span>
                          ) : (
                            <span className="text-slate-500">{t('settings.push.muted', '已静音')}</span>
                          )}
                        </div>
                      </div>
                      <Toggle
                        checked={on}
                        onChange={(v) => toggleEvent(ev.id, v)}
                        aria-label={`${t(ev.labelKey, ev.label)} ${t('settings.push.masterToggle', '推送总开关')}`}
                        data-testid={`push-event-toggle-${ev.id}`}
                      />
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="mt-4 space-y-2">
                {Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton h-10" />)}
              </div>
            )}
          </CollapseCard>

          {/* ===== 分区4：AI 助手（BYO 模型，可选） ===== */}
          <CollapseCard id="ai" icon={Sparkles} title={t('settings.nav.ai', 'AI 助手')} summary={aiCfg ? (aiCfg.enabled ? t('settings.ai.polishOn', 'AI 润色已开启') : t('settings.ai.builtinTemplate', '使用内置模板')) : undefined} open={openSections.has('ai')} onToggle={() => toggleSection('ai')} testid="settings-ai">
            <p className="section-desc mt-1">
              {t('settings.ai.desc', '接入 OpenAI 兼容模型润色推送文案；不接入也有完整模板，默认关闭')}
            </p>

            <div className="mt-4 flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
              <Toggle checked={aiEnabled} onChange={setAiEnabled} label={t('settings.ai.enabled', '启用')} />
              <span className={`text-[11px] ${aiEnabled ? 'text-emerald-400' : 'text-slate-500'}`}>
                {aiEnabled ? t('settings.ai.polishOn', 'AI 润色已开启') : t('settings.ai.builtinTemplate', '使用内置模板')}
              </span>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="mb-1.5 block text-xs font-medium text-slate-400">{t('settings.ai.baseUrl', '接口地址')}</label>
                <input
                  type="url"
                  className="input-dark"
                  placeholder="https://api.openai.com/v1"
                  value={aiBaseUrl}
                  onChange={(e) => setAiBaseUrl(e.target.value)}
                  aria-label={t('settings.ai.baseUrl', '接口地址')}
                  data-testid="ai-base-url"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-400">{t('settings.ai.model', '模型名')}</label>
                <input
                  type="text"
                  className="input-dark"
                  placeholder="gpt-4o-mini"
                  value={aiModel}
                  onChange={(e) => setAiModel(e.target.value)}
                  aria-label={t('settings.ai.model', '模型名')}
                  data-testid="ai-model"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-400">{t('settings.ai.apiKey', 'API Key')}</label>
                <input
                  type="password"
                  className="input-dark"
                  autoComplete="off"
                  placeholder={
                    aiCfg?.hasKey
                      ? t('settings.ai.apiKeySet', '已配置（{alias}）— 留空不修改').replace('{alias}', aiCfg.keyAlias ?? 'sk-…')
                      : 'sk-…'
                  }
                  value={aiApiKey}
                  onChange={(e) => setAiApiKey(e.target.value)}
                  aria-label={t('settings.ai.apiKey', 'API Key')}
                  data-testid="ai-api-key"
                />
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-3">
              <button
                className="btn-primary"
                onClick={() => saveAi.mutate()}
                disabled={saveAi.isPending}
                data-testid="ai-save"
              >
                {saveAi.isPending ? t('settings.saving', '保存中…') : t('settings.ai.save', '保存')}
              </button>
              <button
                className="btn-ghost"
                onClick={() => testAi.mutate()}
                disabled={testAi.isPending}
                data-testid="ai-test"
              >
                {testAi.isPending ? t('settings.ai.testing', '测试中…') : t('settings.ai.test', '测试连通')}
              </button>
            </div>
          </CollapseCard>

          {/* ===== m4e 分区：车辆（主车/别名管理） ===== */}
          <CollapseCard id="cars" icon={Car} title={t('settings.nav.cars', '车辆')} summary={cars.length ? `${cars.length} ${t('settings.sum.carsUnit', '辆')} · ${cars.find((c) => c.isPrimary)?.name ?? cars[0]?.name ?? ''}` : undefined} open={openSections.has('cars')} onToggle={() => toggleSection('cars')} testid="settings-cars">
            <p className="section-desc mt-1">{t('settings.cars.desc', '多车实例管理主车与显示别名（清单来自 TeslaMate）')}</p>
            <div className="mt-4 max-w-xl space-y-2.5">
              {cars.length === 0 ? (
                <div className="rounded-xl border border-dashed border-white/[0.08] px-4 py-5 text-center text-xs text-slate-500">
                  {t('settings.cars.empty', '未发现车辆（完成向导或等待 TeslaMate 同步）')}
                </div>
              ) : (
                cars.map((c) => (
                  <div key={c.id} className="flex flex-col gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 sm:flex-row sm:items-center">
                    <label className="flex min-w-0 flex-1 items-center gap-2.5">
                      <input
                        type="radio"
                        name="car-primary"
                        checked={carPrimaryId === c.id}
                        onChange={() => setCarPrimaryId(c.id)}
                        aria-label={`${c.name} ${t('settings.cars.setPrimary', '设为主车')}`}
                        data-testid={`car-primary-${c.id}`}
                        className="h-4 w-4 accent-[#E82127]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-slate-200">{c.name}</span>
                        <span className="block text-[11px] text-slate-500">
                          {carPrimaryId === c.id ? t('settings.cars.isPrimary', '主车 · 缺省展示') : `${t('settings.cars.carId', '车辆')} #${c.id}`}
                        </span>
                      </span>
                    </label>
                    <input
                      type="text"
                      className="input-dark sm:max-w-52"
                      placeholder={t('settings.cars.aliasPh', '别名（显示用，可空）')}
                      value={carAliases[String(c.id)] ?? ''}
                      onChange={(e) => setCarAliases((prev) => ({ ...prev, [String(c.id)]: e.target.value }))}
                      aria-label={`${t('settings.cars.alias', '别名')} ${c.name}`}
                      data-testid={`car-alias-${c.id}`}
                    />
                  </div>
                ))
              )}
            </div>
            {cars.length > 0 && (
              <button
                className="btn-primary mt-4"
                onClick={() => saveCars.mutate()}
                disabled={saveCars.isPending}
                data-testid="cars-save"
              >
                {saveCars.isPending ? t('settings.saving', '保存中…') : t('settings.cars.save', '保存车辆设置')}
              </button>
            )}
          </CollapseCard>

          {/* ===== 分区6：系统（服务状态/只读盾/事件日志 唯一入口） ===== */}
          <CollapseCard id="system" icon={Activity} title={t('settings.nav.system', '系统')} summary={t('settings.system.desc', '服务状态 · 只读安全盾 · 事件日志')} open={openSections.has('system')} onToggle={() => toggleSection('system')} testid="settings-system">
            <p className="section-desc mt-1">{t('settings.system.desc', '服务状态 · 只读安全盾 · 事件日志')}</p>
            <div className="mt-4">
              <SystemSection />
            </div>
          </CollapseCard>

          {/* ===== 分区7：账户安全 ===== */}
          <CollapseCard id="security" icon={KeyRound} title={t('settings.nav.security', '账户安全')} summary={t('settings.sum.security', '用户名 · 密码')} open={openSections.has('security')} onToggle={() => toggleSection('security')} testid="change-password-card">
            <p className="section-desc mt-1">{t('settings.security.desc', '修改用户名或密码；修改密码后其他已登录会话将被吊销')}</p>
            <form onSubmit={onSubmitPassword} className="mt-4 max-w-sm space-y-3.5" noValidate>
              <div>
                <label htmlFor="account-username" className="mb-1.5 block text-xs font-medium text-slate-400">{t('settings.pw.username', '用户名')}</label>
                <input id="account-username" className="input-dark" autoComplete="username" value={username} onChange={(e) => { setUsernameTouched(true); setUsername(e.target.value) }} data-testid="account-username" />
              </div>
              <div>
                <label htmlFor="old-password" className="mb-1.5 block text-xs font-medium text-slate-400">{t('settings.pw.old', '当前密码')}</label>
                <input id="old-password" type="password" className="input-dark" autoComplete="current-password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
              </div>
              <div>
                <label htmlFor="new-password" className="mb-1.5 block text-xs font-medium text-slate-400">{t('settings.pw.new', '新密码')}</label>
                <input id="new-password" type="password" className="input-dark" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              </div>
              <div>
                <label htmlFor="confirm-password" className="mb-1.5 block text-xs font-medium text-slate-400">{t('settings.pw.confirm', '确认新密码')}</label>
                <input id="confirm-password" type="password" className="input-dark" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
              </div>
              {error && (
                <div role="alert" data-testid="password-error" className="rounded-lg border border-tesla/30 bg-tesla/10 px-3 py-2 text-xs text-tesla-soft">
                  {error}
                </div>
              )}
              <button type="submit" className="btn-primary w-full" disabled={submitting} data-testid="password-submit">
                {submitting ? t('common.working', '提交中…') : t('settings.pw.submit', '修改密码')}
              </button>
            </form>
          </CollapseCard>
        </div>
      </div>
    </div>
  )
}
