import type { ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from './layouts/AppLayout'
import { AuthProvider, useAuth } from './contexts/AuthContext'
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

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route element={<AppLayout />}>
          <Route path="/" element={<Protected><DashboardPage /></Protected>} />
          <Route path="/trips" element={<Protected><TripsPage /></Protected>} />
          <Route path="/trips/:id" element={<Protected><TripDetailPage /></Protected>} />
          <Route path="/charging" element={<Protected><ChargingPage /></Protected>} />
          <Route path="/push" element={<Protected><PushPage /></Protected>} />
          <Route path="/reports" element={<Protected><ReportsPage /></Protected>} />
          <Route path="/reports/:id" element={<Protected><ReportDetailPage /></Protected>} />
          <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
          {/* v2.4 电价/系统并入设置页分区，旧地址重定向 */}
          <Route path="/pricing" element={<Navigate to="/settings#settings-pricing" replace />} />
          <Route path="/system" element={<Navigate to="/settings#settings-system" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  )
}
