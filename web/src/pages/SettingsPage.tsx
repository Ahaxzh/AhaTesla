import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Activity,
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

const EVENTS: { id: PushEventId; label: string; desc: string }[] = [
  { id: 'tripEnd', label: '行程结束小结', desc: '每次行程结束推送费用与路线概要' },
  { id: 'chargingStart', label: '充电开始提醒', desc: '插入充电枪开始充电时' },
  { id: 'chargingDone', label: '充电完成账单', desc: '充电结束推送电量与费用' },
  { id: 'outage', label: '数据断联告警', desc: '告警 · TeslaMate 断联≥10 分钟/恢复,不受静音时段影响' },
  { id: 'chargeInterrupt', label: '充电提前中止', desc: '告警 · 充电未到 80% 即停止时提醒检查枪桩' },
  { id: 'tirePressure', label: '胎压过低', desc: '告警 · 四轮最低低于 2.6 bar 时提醒(24h 一次)' },
  { id: 'daily', label: '每日早报', desc: '每天 08:00 汇总昨日用车与充电' },
  { id: 'weekly', label: '每周周报', desc: '每周一 08:00 汇总上周' },
  { id: 'monthly', label: '每月月报', desc: '每月 1 日 08:00 汇总上月' },
]
const CHANNELS: { id: PushChannelId; label: string }[] = [
  { id: 'webpush', label: 'Web Push' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'feishu', label: '飞书' },
  { id: 'wecom', label: '企业微信' },
  { id: 'ntfy', label: 'ntfy' },
  { id: 'bark', label: 'Bark' },
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

/** 设置页分区导航（桌面侧栏锚点 / 移动横向滚动）— v2.4 与卡片一一对应 */
function SettingsNav({ active }: { active: string }) {
  const { t } = useI18n()
  const items = [
    { id: 'appearance', label: t('settings.nav.appearance', '外观'), icon: Palette },
    { id: 'cars', label: t('settings.nav.cars', '车辆'), icon: Car },
    { id: 'ledger', label: t('settings.nav.ledger', '账本参数'), icon: Calculator },
    { id: 'pricing', label: t('settings.nav.pricing', '电价'), icon: Tag },
    { id: 'ai', label: t('settings.nav.ai', 'AI 助手'), icon: Sparkles },
    { id: 'push', label: t('settings.nav.push', '推送'), icon: BellRing },
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
  const [activeSection, setActiveSection] = useState('appearance')

  // 滚动监听高亮当前分区（IntersectionObserver 不可用时静默降级）
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const ids = ['appearance', 'cars', 'ledger', 'pricing', 'ai', 'push', 'system', 'security']
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
      toast('重算已启动', 'success')
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        try {
          const job = await api.recalculateStatus(jobId)
          setRecalcProgress(Math.round(job.progress * 100))
          if (job.status !== 'running') {
            if (pollRef.current) clearInterval(pollRef.current)
            toast(job.status === 'done' ? t('settings.recalc.done', '历史账本重算完成') : '重算失败', job.status === 'done' ? 'success' : 'error')
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
      toast('AI 配置已保存', 'success')
      setAiApiKey('')
      void queryClient.invalidateQueries({ queryKey: ['ai-config'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  const testAi = useMutation({
    mutationFn: api.aiTest,
    onSuccess: (r) => {
      if (r.ok && r.preview) toast(`连通正常：${r.preview.slice(0, 50)}`, 'success')
      else if (r.ok) toast('连通正常', 'success')
      else toast(r.error ?? '测试失败', 'error')
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
      setError('用户名至少 3 个字符')
      return
    }
    if (newPassword && newPassword.length < 8) {
      setError('新密码至少 8 位')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致')
      return
    }
    if (!nameChanged && !newPassword) {
      setError('没有需要保存的修改')
      return
    }
    setSubmitting(true)
    try {
      await api.changeAccount({
        oldPassword,
        newPassword: newPassword || undefined,
        newUsername: nameChanged ? name : undefined,
      })
      toast('账户已更新', 'success')
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
          <section id="settings-appearance" className="glass-card-flat scroll-mt-6 p-5" data-testid="settings-appearance">
            <h2 className="section-title">
              <Palette className="h-4 w-4 text-tesla" /> {t('settings.nav.appearance', '外观')}
            </h2>
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
          </section>

          {/* ===== m4e 分区：车辆（主车/别名管理） ===== */}
          <section id="settings-cars" className="glass-card-flat scroll-mt-6 p-5" data-testid="settings-cars">
            <h2 className="section-title">
              <Car className="h-4 w-4 text-tesla" /> {t('settings.nav.cars', '车辆')}
            </h2>
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
                        aria-label={`${c.name} 设为主车`}
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
          </section>

          {/* ===== 分区2：账本参数（货币/单位/油车基准 + 重算） ===== */}
          <section id="settings-ledger" className="glass-card-flat scroll-mt-6 p-5" data-testid="settings-ledger">
            <h2 className="section-title">
              <Calculator className="h-4 w-4 text-tesla" /> {t('settings.nav.ledger', '账本参数')}
            </h2>
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
                    <input type="number" step="0.1" min="1" max="30" inputMode="decimal" className="input-dark num pr-16" value={liter} onChange={(e) => setLiter(e.target.value)} aria-label="百公里油耗（升）" data-testid="fuel-liter" />
                    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-500">L/100km</span>
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">{t('settings.fuel.price', '油价')}</label>
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
                  {recalcJob ? `重算中 ${recalcProgress}%` : t('settings.recalc.start', '开始重算')}
                </button>
              </div>
              {recalcJob != null && (
                <div className="mt-3 h-1.5 max-w-md overflow-hidden rounded-full bg-white/[0.06]" data-testid="recalc-progress">
                  <div className="h-full rounded-full bg-tesla transition-all duration-500" style={{ width: `${recalcProgress}%` }} />
                </div>
              )}
            </div>
          </section>

          {/* ===== 分区3：电价（默认价 + 地点电价含分时 + 历史） ===== */}
          <section id="settings-pricing" className="glass-card-flat scroll-mt-6 p-5" data-testid="settings-pricing">
            <h2 className="section-title">
              <Tag className="h-4 w-4 text-tesla" /> {t('settings.nav.pricing', '电价')}
            </h2>
            <p className="section-desc mt-1">{t('settings.pricing.desc', '默认电价 · 地点电价（含分时）· 费率变更历史')}</p>
            <div className="mt-4">
              <PricingSection />
            </div>
          </section>

          {/* ===== 分区4：AI 助手（BYO 模型，可选） ===== */}
          <section id="settings-ai" className="glass-card-flat scroll-mt-6 p-5" data-testid="settings-ai">
            <h2 className="section-title">
              <Sparkles className="h-4 w-4 text-tesla" /> {t('settings.nav.ai', 'AI 助手')}
            </h2>
            <p className="section-desc mt-1">
              {t('settings.ai.desc', '接入 OpenAI 兼容模型润色推送文案；不接入也有完整模板，默认关闭')}
            </p>

            <div className="mt-4 flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
              <Toggle checked={aiEnabled} onChange={setAiEnabled} label={t('settings.ai.enabled', '启用')} />
              <span className={`text-[11px] ${aiEnabled ? 'text-emerald-400' : 'text-slate-500'}`}>
                {aiEnabled ? 'AI 润色已开启' : '使用内置模板'}
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
          </section>

          {/* ===== 分区5：推送矩阵 ===== */}
          <section id="settings-push" className="glass-card-flat scroll-mt-6 p-5" data-testid="settings-push-matrix">
            <h2 className="section-title">
              <BellRing className="h-4 w-4 text-tesla" /> {t('settings.nav.push', '推送')}
            </h2>
            <p className="section-desc mt-1">
              {t('settings.push.desc', '6 类事件 × 6 渠道独立开关 · 渠道密钥在「推送」页配置')}
              {/* 修复：/push 页此前从任何导航都到不了（矩阵文案提到却无入口） */}
              {' '}
              <Link to="/push" className="text-tesla hover:underline" data-testid="settings-push-page-link">
                {t('settings.push.openChannelPage', '前往渠道配置 →')}
              </Link>
            </p>
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
                        <div className="mt-0.5 text-[11px] text-slate-500">{ev.desc}</div>
                      </div>
                      {/* 渠道 chips：点亮即启用，一行搞定 6 渠道 */}
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
                                  ? 'border-tesla/50 bg-tesla/15 text-tesla-soft shadow-[0_0_0_1px_rgba(232,33,39,0.15)] hover:bg-tesla/25'
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

          {/* ===== 分区6：系统（服务状态/只读盾/事件日志 唯一入口） ===== */}
          <section id="settings-system" className="glass-card-flat scroll-mt-6 p-5" data-testid="settings-system">
            <h2 className="section-title">
              <Activity className="h-4 w-4 text-tesla" /> {t('settings.nav.system', '系统')}
            </h2>
            <p className="section-desc mt-1">{t('settings.system.desc', '服务状态 · 只读安全盾 · 事件日志')}</p>
            <div className="mt-4">
              <SystemSection />
            </div>
          </section>

          {/* ===== 分区7：账户安全 ===== */}
          <section id="settings-security" className="glass-card-flat scroll-mt-6 p-5" data-testid="change-password-card">
            <h2 className="section-title">
              <KeyRound className="h-4 w-4 text-tesla" /> {t('settings.nav.security', '账户安全')}
            </h2>
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
                {submitting ? '提交中…' : t('settings.pw.submit', '修改密码')}
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  )
}
