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
import PricingPage from './pages/PricingPage'
import PushPage from './pages/PushPage'
import ReportsPage from './pages/ReportsPage'
import ReportDetailPage from './pages/ReportDetailPage'
import SettingsPage from './pages/SettingsPage'
import SystemPage from './pages/SystemPage'

function Protected({ children }: { children: ReactNode }) {
  const { user, initialized } = useAuth()
  if (initialized && !user) return <Navigate to="/login" replace />
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
          <Route path="/pricing" element={<Protected><PricingPage /></Protected>} />
          <Route path="/push" element={<Protected><PushPage /></Protected>} />
          <Route path="/reports" element={<Protected><ReportsPage /></Protected>} />
          <Route path="/reports/:id" element={<Protected><ReportDetailPage /></Protected>} />
          <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
          <Route path="/system" element={<Protected><SystemPage /></Protected>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  )
}
