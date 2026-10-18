import { useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { Eye, EyeOff } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { LogoMark } from '@/components/Logo'
import { useI18n } from '@/i18n'

export default function LoginPage() {
  const { user, initialized, login } = useAuth()
  const { t } = useI18n()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (initialized && user) return <Navigate to="/" replace />
  if (!initialized) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-base-950">
        <div className="skeleton h-40 w-72 rounded-2xl" data-testid="login-probe-skeleton" />
      </div>
    )
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (!username.trim()) {
      setError(t('login.err.username', '请输入用户名'))
      return
    }
    if (!password) {
      setError(t('login.err.password', '请输入密码'))
      return
    }
    setSubmitting(true)
    try {
      await login(username.trim(), password)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.err.failed', '登录失败，请重试'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-base-950 px-4">
      {/* 背景氛围光 */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-tesla/10 blur-[100px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 right-0 h-80 w-80 rounded-full bg-sky-500/[0.06] blur-[100px]"
      />

      <div className="fade-up w-full max-w-sm" data-testid="login-card">
        <div className="mb-7 flex flex-col items-center gap-3">
          <LogoMark size={64} />
          <div className="text-2xl font-semibold tracking-tight text-white">
            Aha<span className="text-tesla">Tesla</span>
          </div>
          <p className="text-xs text-slate-400">{t('login.tagline', '行车数据 · 电费账本 · 智能推送')}</p>
        </div>

        <form onSubmit={onSubmit} className="glass-card space-y-4 p-6" noValidate>
          <div>
            <label htmlFor="login-username" className="mb-1.5 block text-xs font-medium text-slate-400">
              {t('login.username', '用户名')}
            </label>
            <input
              id="login-username"
              className="input-dark"
              type="text"
              autoComplete="username"
              placeholder={t('login.username', '用户名')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="login-password" className="mb-1.5 block text-xs font-medium text-slate-400">
              {t('login.password', '密码')}
            </label>
            <div className="relative">
              <input
                id="login-password"
                className="input-dark pr-11"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder={t('login.password', '密码')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                aria-label={showPassword ? t('login.hidePwd', '隐藏密码') : t('login.showPwd', '显示密码')}
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-slate-500 transition hover:text-slate-300"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {error && (
            <div role="alert" data-testid="login-error" className="rounded-lg border border-tesla/30 bg-tesla/10 px-3 py-2 text-xs text-tesla-soft">
              {error}
            </div>
          )}

          <button type="submit" className="btn-primary w-full" disabled={submitting} data-testid="login-submit">
            {submitting ? t('login.submitting', '登录中…') : t('login.submit', '登 录')}
          </button>
        </form>

        <p className="mt-5 text-center text-[11px] text-slate-500">{t('login.footer', 'AhaTesla · TeslaMate 数据面板')}</p>
      </div>
    </div>
  )
}
