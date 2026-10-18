import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

/** 主题偏好：跟随系统 / 浅色 / 深色（localStorage 持久化，客户端偏好不进后端） */
export type ThemeSetting = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'ahatesla_theme'

interface ThemeState {
  /** 用户偏好（含 system） */
  theme: ThemeSetting
  /** 实际生效值（system 已解析） */
  resolved: 'light' | 'dark'
  setTheme: (t: ThemeSetting) => void
}

const ThemeContext = createContext<ThemeState | null>(null)

function readStored(): ThemeSetting {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'system' || v === 'light' || v === 'dark') return v
  } catch {
    // localStorage 不可用（隐私模式等）时静默回退默认值
  }
  return 'system'
}

/** 系统深色偏好；matchMedia 不可用（jsdom/极老浏览器）时默认深色（项目本体是暗色设计） */
function systemPrefersDark(): boolean {
  if (typeof matchMedia === 'undefined') return true
  return matchMedia('(prefers-color-scheme: dark)').matches
}

function applyTheme(resolved: 'light' | 'dark') {
  document.documentElement.dataset.theme = resolved
  // colorScheme 让原生控件（滚动条/输入框/表单）跟随配色
  document.documentElement.style.colorScheme = resolved
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeSetting>(readStored)
  const [systemDark, setSystemDark] = useState(systemPrefersDark)

  const resolved: 'light' | 'dark' = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  // useLayoutEffect 在首帧绘制前写入，避免暗色用户闪一下浅色（或反之）
  useLayoutEffect(() => {
    applyTheme(resolved)
  }, [resolved])

  // system 模式下跟随系统实时切换
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    setSystemDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const setTheme = useCallback((t: ThemeSetting) => {
    setThemeState(t)
    try {
      localStorage.setItem(STORAGE_KEY, t)
    } catch {
      // 存不进去时仅本会话生效
    }
  }, [])

  const value = useMemo(
    () => ({ theme, resolved, setTheme }),
    [theme, resolved, setTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return ctx
}
