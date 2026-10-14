import { useState } from 'react'
import type { FormEvent } from 'react'
import { KeyRound, LogOut, Settings as SettingsIcon, UserRound } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { useToast } from '@/components/Toast'
import { useNavigate } from 'react-router-dom'

export default function SettingsPage() {
  const { user, logout } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (!oldPassword || !newPassword) {
      setError('请填写完整')
      return
    }
    if (newPassword.length < 6) {
      setError('新密码至少 6 位')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致')
      return
    }
    setSubmitting(true)
    try {
      await api.changePassword(oldPassword, newPassword)
      toast('密码已修改', 'success')
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
    <div>
      <PageHeader icon={SettingsIcon} title="设置" />

      {/* 账户信息 */}
      <section className="glass-card mb-4 flex items-center gap-4 p-5" data-testid="account-card">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-tesla/15 text-lg font-semibold text-tesla">
          {user?.username?.[0]?.toUpperCase() ?? '?'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
            <UserRound className="h-4 w-4 text-slate-500" />
            {user?.username ?? '--'}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">单用户模式 · JWT Cookie 认证</div>
        </div>
      </section>

      {/* 修改密码 */}
      <section className="glass-card mb-4 p-5" data-testid="change-password-card">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-200">
          <KeyRound className="h-4 w-4 text-tesla" />
          修改密码
        </h2>
        <form onSubmit={onSubmit} className="max-w-sm space-y-3.5" noValidate>
          <div>
            <label htmlFor="old-password" className="mb-1.5 block text-xs font-medium text-slate-400">
              当前密码
            </label>
            <input
              id="old-password"
              type="password"
              className="input-dark"
              autoComplete="current-password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="new-password" className="mb-1.5 block text-xs font-medium text-slate-400">
              新密码
            </label>
            <input
              id="new-password"
              type="password"
              className="input-dark"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="confirm-password" className="mb-1.5 block text-xs font-medium text-slate-400">
              确认新密码
            </label>
            <input
              id="confirm-password"
              type="password"
              className="input-dark"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          {error && (
            <div role="alert" data-testid="password-error" className="rounded-lg border border-tesla/30 bg-tesla/10 px-3 py-2 text-xs text-tesla-soft">
              {error}
            </div>
          )}
          <button type="submit" className="btn-primary w-full" disabled={submitting} data-testid="password-submit">
            {submitting ? '提交中…' : '修改密码'}
          </button>
        </form>
      </section>

      <button
        className="btn-ghost w-full max-w-sm !border-tesla/25 text-tesla-soft hover:!bg-tesla/10"
        onClick={async () => {
          await logout()
          navigate('/login', { replace: true })
        }}
        data-testid="settings-logout"
      >
        <LogOut className="h-4 w-4" />
        退出登录
      </button>
    </div>
  )
}
