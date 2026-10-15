import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import {
  Bell,
  BatteryCharging,
  Gauge,
  LogOut,
  Route,
  Settings,
  Tag,
  Activity,
  FileBarChart,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { LogoFull } from '@/components/Logo'
import { useAuth } from '@/contexts/AuthContext'
import { setApiHandlers, api } from '@/api/client'
import { useToast } from '@/components/Toast'
import { HealthBanner } from '@/components/HealthBanner'

/** 移动端 TabBar 4 项（PRD §6.1）：概览/行程/充电/设置 */
export const NAV_ITEMS = [
  { to: '/', label: '概览', icon: Gauge, testid: 'nav-dashboard' },
  { to: '/trips', label: '行程', icon: Route, testid: 'nav-trips' },
  { to: '/charging', label: '充电', icon: BatteryCharging, testid: 'nav-charging' },
  { to: '/settings', label: '设置', icon: Settings, testid: 'nav-settings' },
]

/** 桌面侧栏全部导航（含次级入口：报告/电价/推送/系统） */
export const SIDEBAR_ITEMS = [
  ...NAV_ITEMS,
  { to: '/reports', label: '报告', icon: FileBarChart, testid: 'nav-reports' },
  { to: '/pricing', label: '电价', icon: Tag, testid: 'nav-pricing' },
  { to: '/push', label: '推送', icon: Bell, testid: 'nav-push' },
  { to: '/system', label: '系统', icon: Activity, testid: 'nav-system' },
]

function NavItem({ to, label, icon: Icon, testid, onClick }: {
  to: string
  label: string
  icon: typeof Gauge
  testid: string
  onClick?: () => void
}) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      data-testid={testid}
      onClick={onClick}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
          isActive
            ? 'bg-tesla/12 font-medium text-tesla'
            : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
        }`
      }
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {label}
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
        <span className="text-[10px] text-slate-500">{stateLabel}</span>
      </div>
    </div>
  )
}

export function AppLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { toast } = useToast()

  useEffect(() => {
    setApiHandlers({
      unauthorized: () => {
        if (window.location.pathname !== '/login') navigate('/login', { replace: true })
      },
      error: (err) => toast(err.message, 'error'),
    })
  }, [navigate, toast])

  const handleLogout = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-dvh bg-base-950">
      {/* GA-32：全站数据源失联横幅 */}
      <HealthBanner />

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
          <div className="mb-2 flex items-center gap-2.5 px-3 py-1">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-tesla/15 text-sm font-semibold text-tesla">
              {user?.username?.[0]?.toUpperCase() ?? '?'}
            </div>
            <div className="min-w-0 flex-1 truncate text-sm text-slate-300">{user?.username ?? '未登录'}</div>
          </div>
          <button
            onClick={handleLogout}
            data-testid="logout-button"
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-slate-400 transition hover:bg-white/[0.05] hover:text-slate-200"
          >
            <LogOut className="h-[18px] w-[18px]" />
            退出登录
          </button>
        </div>
      </aside>

      {/* 主内容 */}
      <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-5 sm:px-6 lg:ml-60 lg:pb-10 lg:pt-8">
        <Outlet />
      </main>

      {/* 移动端底部 TabBar（§6.1：4 项 概览/行程/充电/设置） */}
      <div className="fixed inset-x-0 bottom-0 z-30 lg:hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mx-auto max-w-md border-t border-white/[0.06] bg-base-900/90 px-2 pt-1 backdrop-blur-xl">
          <nav
            data-testid="mobile-tabbar"
            className="grid grid-cols-4"
            aria-label="底部导航"
          >
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                data-testid={`${item.testid}-mobile`}
                className={({ isActive }) =>
                  `flex flex-col items-center gap-1 rounded-lg py-2 text-[10px] transition ${
                    isActive ? 'text-tesla' : 'text-slate-500'
                  }`
                }
              >
                <item.icon className="h-5 w-5" />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </div>
    </div>
  )
}
