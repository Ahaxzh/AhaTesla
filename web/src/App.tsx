import type { ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from './layouts/AppLayout'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import LoginPage from './pages/LoginPage'
import SetupPage from './pages/SetupPage'
import DashboardPage from './pages/DashboardPage'
import TripsPage from './pages/TripsPage'
import TripDetailPage from './pages/TripDetailPage'
import ChargingPage from './pages/ChargingPage'
import PushPage from './pages/PushPage'
import ReportsPage from './pages/ReportsPage'
import ReportDetailPage from './pages/ReportDetailPage'
import SettingsPage from './pages/SettingsPage'

function Protected({ children }: { children: ReactNode }) {
  const { user, initialized } = useAuth()
  // 探测未完成时不渲染应用壳（避免未登录首屏闪出侧栏/TabBar 再跳登录）
  if (!initialized) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center" data-testid="auth-splash">
        <div className="skeleton h-8 w-8 rounded-full" />
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

/** §6.2 路由树：/login 已登录 → 重定向 / */
function LoginRoute() {
  const { user, initialized } = useAuth()
  if (initialized && user) return <Navigate to="/" replace />
  return <LoginPage />
}

/** 路由级错误边界包装：单页渲染异常只熄灭该页（导航壳仍在），可重试 */
function Page({ path, children }: { path: string; children: ReactNode }) {
  return <ErrorBoundary resetKey={path}>{children}</ErrorBoundary>
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Page path="/login"><LoginRoute /></Page>} />
        <Route path="/setup" element={<Page path="/setup"><SetupPage /></Page>} />
        <Route element={<AppLayout />}>
          <Route path="/" element={<Page path="/"><Protected><DashboardPage /></Protected></Page>} />
          <Route path="/trips" element={<Page path="/trips"><Protected><TripsPage /></Protected></Page>} />
          <Route path="/trips/:id" element={<Page path="/trips/:id"><Protected><TripDetailPage /></Protected></Page>} />
          <Route path="/charging" element={<Page path="/charging"><Protected><ChargingPage /></Protected></Page>} />
          <Route path="/push" element={<Page path="/push"><Protected><PushPage /></Protected></Page>} />
          <Route path="/reports" element={<Page path="/reports"><Protected><ReportsPage /></Protected></Page>} />
          <Route path="/reports/:id" element={<Page path="/reports/:id"><Protected><ReportDetailPage /></Protected></Page>} />
          <Route path="/settings" element={<Page path="/settings"><Protected><SettingsPage /></Protected></Page>} />
          {/* v2.4 电价/系统并入设置页分区，旧地址重定向 */}
          <Route path="/pricing" element={<Navigate to="/settings#settings-pricing" replace />} />
          <Route path="/system" element={<Navigate to="/settings#settings-system" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  )
}
