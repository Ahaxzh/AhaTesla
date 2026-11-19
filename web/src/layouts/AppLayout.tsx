import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import {
  BatteryCharging,
  Gauge,
  Languages,
  LogOut,
  Monitor,
  Moon,
  Route,
  Settings,
  Sun,
  UserCog,
  FileBarChart,
  Zap,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { setCurrencySymbol } from '@/utils/format'
import { LogoFull, LogoMark } from '@/components/Logo'
import { useAuth } from '@/contexts/AuthContext'
import { useCar } from '@/contexts/CarContext'
import { setApiHandlers, api } from '@/api/client'
import { useToast } from '@/components/Toast'
import { useTheme, type ThemeSetting } from '@/contexts/ThemeContext'
import { HealthBanner } from '@/components/HealthBanner'
import { useI18n } from '@/i18n'

/** 导航项定义（v2.7 起移动 TabBar 与桌面侧栏分列） */
const NAV_DEFS = {
  dashboard: { to: '/', label: '概览', labelKey: 'nav.dashboard', icon: Gauge, testid: 'nav-dashboard' },
  trips: { to: '/trips', label: '行程', labelKey: 'nav.trips', icon: Route, testid: 'nav-trips' },
  charging: { to: '/charging', label: '充电', labelKey: 'nav.charging', icon: BatteryCharging, testid: 'nav-charging' },
  energy: { to: '/energy', label: '能耗', labelKey: 'nav.energy', icon: Zap, testid: 'nav-energy' },
  reports: { to: '/reports', label: '报告', labelKey: 'nav.reports', icon: FileBarChart, testid: 'nav-reports' },
  settings: { to: '/settings', label: '设置', labelKey: 'nav.settings', icon: Settings, testid: 'nav-settings' },
} as const

/** 桌面侧栏主导航：设置保留在侧栏（桌面有空间，直达比藏进菜单好） */
export const NAV_ITEMS = [
  NAV_DEFS.dashboard, NAV_DEFS.trips, NAV_DEFS.charging, NAV_DEFS.energy, NAV_DEFS.reports, NAV_DEFS.settings,
]

/** 桌面侧栏主导航（电价/推送/系统已并入设置页分区） */
export const SIDEBAR_ITEMS = NAV_ITEMS

/** 移动端底部 TabBar（v2.7 重排）：设置移入顶栏头像菜单；
 *  概览居中，左侧 行程/充电（记录类），右侧 能耗/报告（分析类）——拇指最顺手的中间位给最高频的概览 */
export const TABBAR_ITEMS = [
  NAV_DEFS.trips, NAV_DEFS.charging, NAV_DEFS.dashboard, NAV_DEFS.energy, NAV_DEFS.reports,
]

function NavItem({ to, label, labelKey, icon: Icon, testid, pending, onFeedback, onClick }: {
  to: string
  label: string
  labelKey?: string
  icon: typeof Gauge
  testid: string
  /** 该项是挂起中的导航目标(chunk 加载中):立即给视觉反馈,避免"点了没反应" */
  pending?: boolean
  onFeedback?: (to: string) => void
  onClick?: () => void
}) {
  const { t } = useI18n()
  const text = labelKey ? t(labelKey, label) : label
  return (
    <NavLink
      to={to}
      end={to === '/'}
      data-testid={testid}
      onClick={() => {
        onFeedback?.(to)
        onClick?.()
      }}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
          isActive
            ? 'bg-tesla/[0.12] font-medium text-tesla'
            : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
        } ${pending ? 'animate-pulse text-tesla-soft' : ''}`
      }
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {text}
    </NavLink>
  )
}

/** 侧栏车辆缩略状态卡（§6.1 桌面端：车辆缩略状态 + 系统健康指示灯）。
    m4e:数据按当前车拉取;多车时卡片下方渲染切换 chips(单击切车,全局数据随之刷新)。 */
function SidebarCarCard() {
  const { cars, currentCarId, setCurrentCarId, isMultiCar, displayName } = useCar()
  const { t } = useI18n()
  const { data: dashboard } = useQuery({
    queryKey: ['dashboard', currentCarId],
    queryFn: () => api.dashboard(currentCarId),
    staleTime: 60_000,
    retry: false,
  })
  const { data: health } = useQuery({
    queryKey: ['health-lite'],
    queryFn: api.healthLite,
    refetchInterval: 60_000,
    retry: false,
  })
  const car = dashboard?.car
  const battery = car?.currentBattery
  const stateLabel =
    car?.state === 'charging' ? t('car.state.charging', '充电中')
    : car?.state === 'driving' ? t('car.state.driving', '行驶中')
    : car?.state === 'asleep' ? t('car.state.asleep', '睡眠中')
    : car?.state === 'online' ? t('car.state.online', '哨兵/在线')
    : car?.state === 'offline' ? t('car.state.offline', '离线')
    : t('car.state.pending', '待数据')

  return (
    <div className="mx-3 mb-3" data-testid="sidebar-car-wrap">
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3" data-testid="sidebar-car">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-medium text-slate-200">
            {displayName(currentCarId) || car?.name || 'Tesla'}
          </span>
          {/* 系统健康指示灯 */}
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${health?.dbOk === false ? 'bg-amber-400' : 'bg-emerald-400'}`}
            title={health?.dbOk === false ? t('car.health.bad', '数据源异常') : t('car.health.ok', '数据源正常')}
            role="img"
            aria-label={health?.dbOk === false ? t('car.health.bad', '数据源异常') : t('car.health.ok', '数据源正常')}
            data-testid="sidebar-health-dot"
          />
        </div>
        <div className="mt-1.5 flex items-baseline gap-1.5">
          <span
            className={`num text-lg font-semibold ${
              battery == null ? 'text-slate-500' : battery <= 10 ? 'text-red-400' : battery <= 20 ? 'text-amber-400' : 'text-emerald-400'
            }`}
          >
            {battery != null ? `${battery}%` : '--'}
          </span>
          <span className="text-[11px] text-slate-400">{stateLabel}</span>
        </div>
      </div>
      {/* 多车切换 chips:单击换车;单车实例不渲染(零变化) */}
      {isMultiCar && (
        <div className="mt-1.5 flex flex-wrap gap-1" data-testid="car-switcher" role="radiogroup" aria-label={t('car.switch', '切换车辆')}>
          {cars.map((c) => (
            <button
              key={c.id}
              role="radio"
              aria-checked={c.id === currentCarId}
              onClick={() => setCurrentCarId(c.id)}
              data-testid={`car-option-${c.id}`}
              className={`truncate rounded-lg border px-2 py-1 text-[11px] transition ${
                c.id === currentCarId
                  ? 'border-tesla/50 bg-tesla/15 text-tesla-soft'
                  : 'border-white/[0.08] text-slate-400 hover:border-white/20 hover:text-slate-200'
              }`}
            >
              {displayName(c.id) || c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 头像菜单（Discord 式，v2.7 起双形态共用）：
 *  sidebar = 桌面左下宽按钮，面板向上弹；
 *  header  = 移动顶栏右上圆形头像，面板向下弹，且含「设置」入口
 *  （v2.7 移动底栏去掉设置后，设置/账户安全/主题/语言/登出的统一入口）。
 *  面板内容：用户信息 / 主题·语言快捷开关 / 账户安全（跳设置页锚点，滚动由 hash effect 承接）/ 版本 / 退出 */
function UserMenu({ layout }: { layout: 'sidebar' | 'header' }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { t } = useI18n()
  const { lang, setLang } = useI18n()
  const { theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // 版本标识（"我到底在跑哪版"）：与 SystemSection 共用 queryKey，共享缓存零额外请求
  const { data: sys } = useQuery({ queryKey: ['system-status-full'], queryFn: api.systemStatus, staleTime: Infinity, retry: false })

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const handleLogout = async () => {
    setOpen(false)
    await logout()
    navigate('/login', { replace: true })
  }

  const themeCycle: Record<ThemeSetting, { next: ThemeSetting; icon: typeof Sun; label: string }> = {
    dark: { next: 'light', icon: Moon, label: t('menu.theme.dark', '深色') },
    light: { next: 'system', icon: Sun, label: t('menu.theme.light', '浅色') },
    system: { next: 'dark', icon: Monitor, label: t('menu.theme.system', '跟随系统') },
  }
  const tc = themeCycle[theme] ?? themeCycle.system
  const base = layout === 'sidebar' ? 'user-menu' : 'mobile-user-menu'

  const panel = open && (
    <div
      role="menu"
      data-testid={base}
      className={`absolute z-40 w-72 overflow-hidden rounded-xl border border-white/[0.08] bg-base-800/95 shadow-[0_8px_24px_rgba(0,0,0,0.5)] ${
        layout === 'sidebar' ? 'bottom-full left-0 mb-2' : 'right-0 top-full mt-2'
      }`}
    >
      <div className="border-b border-white/[0.06] px-3.5 py-2.5">
        <div className="truncate text-sm font-medium text-slate-200">{user?.username}</div>
        <div className="mt-0.5 text-[11px] text-slate-400">{t('menu.role', '管理员 · 单用户模式')}</div>
      </div>

      {/* 快捷开关：主题（三态循环）+ 语言 */}
      <div className="flex items-center gap-2 px-3.5 py-2.5" data-testid={`${base}-quick`}>
        <button
          type="button"
          onClick={() => setTheme(tc.next)}
          title={t('menu.theme.title', '切换明暗主题')}
          aria-label={t('menu.theme.title', '切换明暗主题')}
          data-testid={`${base}-theme`}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.04] px-2 py-1.5 text-[11px] text-slate-300 transition hover:bg-white/[0.09]"
        >
          <tc.icon className="h-3.5 w-3.5" />
          {tc.label}
        </button>
        <button
          type="button"
          onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
          title={t('menu.lang.title', '切换语言')}
          aria-label={t('menu.lang.title', '切换语言')}
          data-testid={`${base}-lang`}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.04] px-2 py-1.5 text-[11px] text-slate-300 transition hover:bg-white/[0.09]"
        >
          <Languages className="h-3.5 w-3.5" />
          {lang === 'zh' ? 'English' : '中文'}
        </button>
      </div>

      {/* 设置（仅顶栏形态：底栏已无设置，此为移动端唯一入口） */}
      {layout === 'header' && (
        <button
          role="menuitem"
          onClick={() => {
            setOpen(false)
            navigate('/settings')
          }}
          data-testid={`${base}-settings-link`}
          className="flex w-full items-center gap-2.5 border-t border-white/[0.06] px-3.5 py-2.5 text-[13px] text-slate-300 transition hover:bg-white/[0.05] hover:text-white"
        >
          <Settings className="h-4 w-4 text-slate-500" />
          {t('menu.settings', '设置')}
        </button>
      )}

      {/* 账户安全：跳设置页锚点（完整编辑唯一入口在设置→账户安全） */}
      <button
        role="menuitem"
        onClick={() => {
          setOpen(false)
          navigate('/settings#settings-security')
        }}
        data-testid={`${base}-account-link`}
        className="flex w-full items-center gap-2.5 border-t border-white/[0.06] px-3.5 py-2.5 text-[13px] text-slate-300 transition hover:bg-white/[0.05] hover:text-white"
      >
        <UserCog className="h-4 w-4 text-slate-500" />
        {t('menu.account', '账户安全')}
        {layout === 'sidebar' && <span className="ml-auto text-[10px] text-slate-500">{t('menu.account.hint', '设置页打开')}</span>}
      </button>

      <button
        role="menuitem"
        onClick={handleLogout}
        data-testid={`${base}-logout`}
        className="flex w-full items-center gap-2.5 border-t border-white/[0.06] px-3.5 py-2.5 text-[13px] text-slate-300 transition hover:bg-white/[0.05] hover:text-white"
      >
        <LogOut className="h-4 w-4 text-slate-500" />
        {t('menu.logout', '退出登录')}
      </button>

      {sys?.version && (
        <div className="border-t border-white/[0.06] px-3.5 py-2 text-center text-[10px] text-slate-600" data-testid={`${base}-version`}>
          AhaTesla v{sys.version}
        </div>
      )}
    </div>
  )

  if (layout === 'header') {
    return (
      <div className="relative" ref={ref}>
        <button
          onClick={() => setOpen((v) => !v)}
          data-testid="mobile-user-menu-button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('menu.title', '账户菜单')}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-tesla/15 text-sm font-semibold text-tesla ring-1 ring-white/[0.08] transition active:scale-95"
        >
          {user?.username?.[0]?.toUpperCase() ?? '?'}
        </button>
        {panel}
      </div>
    )
  }

  return (
    <div className="relative" ref={ref}>
      {/* 头像按钮 */}
      <button
        onClick={() => setOpen((v) => !v)}
        data-testid="user-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 transition hover:bg-white/[0.05]"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-tesla/15 text-sm font-semibold text-tesla">
          {user?.username?.[0]?.toUpperCase() ?? '?'}
        </div>
        <div className="min-w-0 flex-1 truncate text-left text-sm text-slate-300">{user?.username ?? t('menu.notLoggedIn', '未登录')}</div>
        <svg
          viewBox="0 0 24 24"
          className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {panel}
    </div>
  )
}

export function AppLayout() {
  const { expire } = useAuth()
  const navigate = useNavigate()
  const { toast } = useToast()
  const { t } = useI18n()
  // 挂起中的导航目标:页面 chunk 加载期间高亮所点导航项(路由级分割下首访需拉 chunk,
  // 导航挂起时界面无反馈,弱网下像"点了没反应")。用本地状态而非 useNavigation ——
  // 后者要求 data router,本项目是声明式 <BrowserRouter>。
  // 清除时机:路由实际变化(切换完成)或 8s 超时(chunk 加载失败被 ErrorBoundary 兜底时)。
  const location = useLocation()
  const [pendingPath, setPendingPath] = useState<string | undefined>()
  useEffect(() => {
    setPendingPath(undefined)
  }, [location.pathname])
  const navFeedback = (to: string) => {
    if (to === location.pathname) return
    setPendingPath(to)
    window.setTimeout(() => setPendingPath((cur) => (cur === to ? undefined : cur)), 8000)
  }

  // 实例货币符号注入格式化层（修复：货币设置保存后从未被消费，全站硬编码 ¥）
  const { data: instanceSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings,
    staleTime: 5 * 60_000,
    retry: false,
  })
  useEffect(() => {
    setCurrencySymbol(instanceSettings?.currency?.symbol)
  }, [instanceSettings?.currency?.symbol])

  useEffect(() => {
    setApiHandlers({
      unauthorized: () => {
        // v2.7：本地会话一并作废——否则 LoginRoute 看到 stale user 会弹回 "/"，来回跳
        expire()
        if (window.location.pathname !== '/login') navigate('/login', { replace: true })
      },
      error: (err) => toast(err.message, 'error'),
    })
  }, [navigate, toast, expire])

  return (
    <div className="min-h-dvh bg-base-950">
      {/* 桌面侧边栏（§6.1：车辆缩略状态 + 导航 + 登出） */}
      <aside
        data-testid="desktop-sidebar"
        className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-white/[0.06] bg-base-900/80 backdrop-blur-xl lg:flex"
      >
        <div className="px-5 py-5">
          <LogoFull />
        </div>
        <SidebarCarCard />
        <nav className="flex-1 space-y-1 overflow-y-auto px-3" aria-label={t('nav.primary', '主导航')}>
          {SIDEBAR_ITEMS.map((item) => (
            <NavItem key={item.to} {...item} pending={pendingPath === item.to} onFeedback={navFeedback} />
          ))}
        </nav>
        <div className="border-t border-white/[0.06] p-3">
          <UserMenu layout="sidebar" />
        </div>
      </aside>

      {/* 主内容（含 GA-32 失联横幅：置于内容列内，避免叠印侧栏） */}
      <div className="lg:pl-60">
        {/* 移动端顶栏（v2.7）：左 Logo 右头像。随页滚动（不 sticky）——刻意避开
            sticky/fixed+半透明这套 iOS 合成层雷区（底栏消失问题的同类根源）；
            safe-area 顶部留白在此承担，main 不再重复垫 */}
        <header
          data-testid="mobile-topbar"
          className="flex items-center justify-between gap-3 px-4 pb-1 pt-[max(0.625rem,env(safe-area-inset-top))] lg:hidden"
        >
          <div className="flex items-center gap-2">
            <LogoMark size={22} />
            <span className="text-[15px] font-semibold tracking-tight text-white">
              Aha<span className="text-tesla">Tesla</span>
            </span>
          </div>
          <UserMenu layout="header" />
        </header>
        <HealthBanner />
        <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-4 sm:px-6 lg:pb-10 lg:pt-[max(2rem,env(safe-area-inset-top))]">
          <Outlet />
        </main>
      </div>

      {/* 移动端底部 TabBar（v2.7 重排：行程|充电|概览|能耗|报告，设置移入顶栏头像菜单）。
          安全区 padding 必须在带背景的内层：iOS 主屏独立模式下 env(safe-area-inset-bottom)≈34px，
          若垫在外层透明容器上，背景只铺到导航内容底部，栏会悬浮在透明缝上（内容穿缝而过）。
          transform-gpu：强制独立合成层，修 iOS 主屏模式动量滚动时 fixed 底栏的亚像素漂移。
          v2.7 实底化（bg-base-900 去 backdrop-blur）：iOS Safari/主屏模式下 fixed 元素带
          backdrop-filter 的子层在动量滚动时偶发不重绘 → 整条栏"消失"，重开才恢复（用户实测） */}
      <div className="fixed inset-x-0 bottom-0 z-30 transform-gpu lg:hidden">
        <div className="border-t border-white/[0.06] bg-base-900 pb-[env(safe-area-inset-bottom)]">
          <nav
            data-testid="mobile-tabbar"
            className="mx-auto grid max-w-md grid-cols-5 px-2 pt-1"
            aria-label={t('nav.bottom', '底部导航')}
          >
            {TABBAR_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                data-testid={`${item.testid}-mobile`}
                onClick={() => navFeedback(item.to)}
                className={({ isActive }) =>
                  `flex flex-col items-center gap-1 rounded-lg py-2 text-[11px] transition ${
                    isActive ? 'text-tesla' : 'text-slate-400'
                  } ${pendingPath === item.to ? 'animate-pulse text-tesla-soft' : ''}`
                }
              >
                <item.icon className="h-5 w-5" />
                {t(item.labelKey ?? '', item.label)}
              </NavLink>
            ))}
          </nav>
        </div>
      </div>
    </div>
  )
}
