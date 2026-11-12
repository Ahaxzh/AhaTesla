import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { ToastProvider } from './components/Toast'
import { ThemeProvider } from './contexts/ThemeContext'
import { CarProvider } from './contexts/CarContext'
import { I18nProvider } from './i18n'
import './index.css'

// iOS 双指缩放拦截：主屏独立模式（standalone）下 Safari 不理会 viewport 的
// user-scalable=no，gesturestart/gesturechange 必须显式 preventDefault 才真正禁掉
if (typeof document !== 'undefined') {
  const stopGesture = (e: Event) => e.preventDefault()
  document.addEventListener('gesturestart', stopGesture, { passive: false })
  document.addEventListener('gesturechange', stopGesture, { passive: false })
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <CarProvider>
        <ThemeProvider>
          <I18nProvider>
            <ToastProvider>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </ToastProvider>
          </I18nProvider>
        </ThemeProvider>
      </CarProvider>
    </QueryClientProvider>
  </StrictMode>,
)
