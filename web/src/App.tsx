import { lazy, Suspense, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from './layouts/AppLayout'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ErrorBoundary } from './components/ErrorBoundary'

// 路由级代码分割：每页独立 chunk,首屏只拉当前页(leaflet 等重组件只随用到的页面加载)。
// chunk 加载失败(如 PWA SW 缓存了旧 index.html 引用已过期 hash)由各路由的
// ErrorBoundary 兜底显示可重试错误,不会白屏整个应用。
const LoginPage = lazy(() => import('./pages/LoginPage'))
const SetupPage = lazy(() => import('./pages/SetupPage'))
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const TripsPage = lazy(() => import('./pages/TripsPage'))
const TripDetailPage = lazy(() => import('./pages/TripDetailPage'))
const ChargingPage = lazy(() => import('./pages/ChargingPage'))
const PushPage = lazy(() => import('./pages/PushPage'))
const ReportsPage = lazy(() => import('./pages/ReportsPage'))
const ReportDetailPage = lazy(() => import('./pages/ReportDetailPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))

/** 页面 chunk 加载中的占位(与未登录 splash 同款骨架) */
function PageFallback() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center" data-testid="page-fallback">
      <div className="skeleton h-8 w-8 rounded-full" />
    </div>
  )
}

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
      <Suspense fallback={<PageFallback />}>
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
      </Suspense>
    </AuthProvider>
  )
}
