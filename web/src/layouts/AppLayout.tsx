import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import {
  BatteryCharging,
  Gauge,
  KeyRound,
  LogOut,
  Route,
  Settings,
  FileBarChart,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { LogoFull } from '@/components/Logo'
import { useAuth } from '@/contexts/AuthContext'
import { setApiHandlers, api } from '@/api/client'
import { useToast } from '@/components/Toast'
import { HealthBanner } from '@/components/HealthBanner'
import { useI18n } from '@/i18n'

/** 导航项（移动端 TabBar 与桌面侧栏共用）：概览/行程/充电/报告/设置 */
export const NAV_ITEMS = [
  { to: '/', label: '概览', labelKey: 'nav.dashboard', icon: Gauge, testid: 'nav-dashboard' },
  { to: '/trips', label: '行程', labelKey: 'nav.trips', icon: Route, testid: 'nav-trips' },
  { to: '/charging', label: '充电', labelKey: 'nav.charging', icon: BatteryCharging, testid: 'nav-charging' },
  { to: '/reports', label: '报告', labelKey: 'nav.reports', icon: FileBarChart, testid: 'nav-reports' },
  { to: '/settings', label: '设置', labelKey: 'nav.settings', icon: Settings, testid: 'nav-settings' },
]

/** 桌面侧栏主导航（电价/推送/系统已并入设置页分区） */
export const SIDEBAR_ITEMS = NAV_ITEMS

function NavItem({ to, label, labelKey, icon: Icon, testid, onClick }: {
  to: string
  label: string
  labelKey?: string
  icon: typeof Gauge
  testid: string
  onClick?: () => void
}) {
  const { t } = useI18n()
  const text = labelKey ? t(labelKey, label) : label
  return (
    <NavLink
      to={to}
      end={to === '/'}
      data-testid={testid}
      onClick={onClick}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
          isActive
            ? 'bg-tesla/[0.12] font-medium text-tesla'
            : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
        }`
      }
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {text}
    </NavLink>
  )
}

/** 侧栏车辆缩略状态卡（§6.1 桌面端：车辆缩略状态 + 系统健康指示灯） */
function SidebarCarCard() {
  const { data: dashboard } = useQuery({
    queryKey: ['dashboard'],
    queryFn: api.dashboard,
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
    car?.state === 'charging' ? '充电中'
    : car?.state === 'driving' ? '行驶中'
    : car?.state === 'asleep' ? '睡眠中'
    : car?.state === 'online' ? '哨兵/在线'
    : car?.state === 'offline' ? '离线'
    : '待数据'

  return (
    <div className="mx-3 mb-3 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3" data-testid="sidebar-car">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-slate-200">{car?.name ?? 'Tesla'}</span>
        {/* 系统健康指示灯 */}
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${health?.dbOk === false ? 'bg-amber-400' : 'bg-emerald-400'}`}
          title={health?.dbOk === false ? '数据源异常' : '数据源正常'}
          role="img"
          aria-label={health?.dbOk === false ? '数据源异常' : '数据源正常'}
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
  )
}

/** 跳转设置页锚点并滚动到位：react-router 不会自动滚 hash，需手动找元素；
    路由切换有渲染时差，rAF 重试若干帧（分区骨架同步渲染，通常 1~2 帧内命中） */
function goToSettingsAnchor(navigate: (to: string) => void, section: string) {
  navigate(`/settings#settings-${section}`)
  let tries = 0
  const scroll = () => {
    const el = document.getElementById(`settings-${section}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    else if (++tries < 30) requestAnimationFrame(scroll)
  }
  requestAnimationFrame(scroll)
}

/** 左下角头像菜单：用户信息 / 修改密码（跳设置） / 退出登录 */
function UserMenu() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
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
        <div className="min-w-0 flex-1 truncate text-left text-sm text-slate-300">{user?.username ?? '未登录'}</div>
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

      {/* 下拉菜单 */}
      {open && (
        <div
          role="menu"
          data-testid="user-menu"
          className="absolute bottom-full left-0 right-0 z-40 mb-2 overflow-hidden rounded-xl border border-white/[0.08] bg-base-800/95 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-xl"
        >
          <div className="border-b border-white/[0.06] px-3.5 py-2.5">
            <div className="truncate text-sm font-medium text-slate-200">{user?.username}</div>
            <div className="mt-0.5 text-[11px] text-slate-400">{t('menu.role', '管理员 · 单用户模式')}</div>
          </div>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false)
              goToSettingsAnchor(navigate, 'security')
            }}
            data-testid="user-menu-password"
            className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-slate-300 transition hover:bg-white/[0.05] hover:text-white"
          >
            <KeyRound className="h-4 w-4 text-slate-500" />
            {t('menu.password', '修改密码')}
          </button>
          <button
            role="menuitem"
            onClick={handleLogout}
            data-testid="user-menu-logout"
            className="flex w-full items-center gap-2.5 border-t border-white/[0.06] px-3.5 py-2.5 text-[13px] text-slate-300 transition hover:bg-white/[0.05] hover:text-white"
          >
            <LogOut className="h-4 w-4 text-slate-500" />
            {t('menu.logout', '退出登录')}
          </button>
        </div>
      )}
    </div>
  )
}

export function AppLayout() {
  useAuth()
  const navigate = useNavigate()
  const { toast } = useToast()
  const { t } = useI18n()

  useEffect(() => {
    setApiHandlers({
      unauthorized: () => {
        if (window.location.pathname !== '/login') navigate('/login', { replace: true })
      },
      error: (err) => toast(err.message, 'error'),
    })
  }, [navigate, toast])

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
        <nav className="flex-1 space-y-1 overflow-y-auto px-3" aria-label="主导航">
          {SIDEBAR_ITEMS.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
        </nav>
        <div className="border-t border-white/[0.06] p-3">
          <UserMenu />
        </div>
      </aside>

      {/* 主内容（含 GA-32 失联横幅：置于内容列内，避免叠印侧栏） */}
      <div className="lg:pl-60">
        <HealthBanner />
        <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-6 lg:pb-10 lg:pt-[max(2rem,env(safe-area-inset-top))]">
          <Outlet />
        </main>
      </div>

      {/* 移动端底部 TabBar（§6.1：4 项 概览/行程/充电/设置） */}
      <div className="fixed inset-x-0 bottom-0 z-30 lg:hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="border-t border-white/[0.06] bg-base-900/90 backdrop-blur-xl">
          <nav
            data-testid="mobile-tabbar"
            className="mx-auto grid max-w-md grid-cols-5 px-2 pt-1"
            aria-label="底部导航"
          >
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                data-testid={`${item.testid}-mobile`}
                className={({ isActive }) =>
                  `flex flex-col items-center gap-1 rounded-lg py-2 text-[11px] transition ${
                    isActive ? 'text-tesla' : 'text-slate-400'
                  }`
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
