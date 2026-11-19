import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { User } from '@/types'

interface AuthState {
  user: User | null
  /** 初始化探测是否完成（避免闪烁跳转登录页） */
  initialized: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
  /** 本地会话作废（401 且 refresh 失败时）：只清态不发请求。
   *  若不清，LoginRoute 看到 stale user 会弹回 "/"，与 401 处理器形成来回跳。 */
  expire: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [initialized, setInitialized] = useState(false)
  const queryClient = useQueryClient()

  const refresh = useCallback(async () => {
    try {
      const me = await api.me()
      setUser(me)
    } catch {
      setUser(null)
    } finally {
      setInitialized(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const login = useCallback(async (username: string, password: string) => {
    const { user: u } = await api.login(username, password)
    setUser(u)
    // 登录前 /api/cars 401 过的错误态不会自愈 —— 失效重拉，
    // 否则多车用户登录后要 F5 才能看到车切换器（M3 修复）
    void queryClient.invalidateQueries({ queryKey: ['cars'] })
    void queryClient.invalidateQueries({ queryKey: ['settings'] })
  }, [queryClient])

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } finally {
      setUser(null)
      queryClient.clear()
    }
  }, [queryClient])

  const expire = useCallback(() => {
    setUser(null)
    queryClient.clear()
  }, [queryClient])

  const value = useMemo(
    () => ({ user, initialized, login, logout, refresh, expire }),
    [user, initialized, login, logout, refresh, expire],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}
