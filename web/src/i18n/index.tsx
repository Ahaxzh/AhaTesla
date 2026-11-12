import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { EN } from './en'
import { setUiLang } from '@/utils/format'

export type Lang = 'zh' | 'en'

const STORAGE_KEY = 'ahatesla_lang'

/** 初始语言:localStorage 记忆,默认 zh(storage 不可用时静默回退) */
function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'zh' || saved === 'en') return saved
  } catch {
    /* 隐私模式等 storage 异常,仅内存生效 */
  }
  return 'zh'
}

interface I18nState {
  lang: Lang
  setLang: (l: Lang) => void
  /** t(key, zhDefault):zh 直接返回中文默认文案;en 查词典命中返回英文,未命中回退中文(未翻译调用点零风险) */
  t: (key: string, zhDefault: string) => string
}

const I18nContext = createContext<I18nState | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang)

  // 无障碍:<html lang> 跟随界面语言;非组件层(format.ts 时长/相对时间、client.ts 错误文案)同步注入
  useEffect(() => {
    document.documentElement.lang = lang
    setUiLang(lang)
  }, [lang])

  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try {
      localStorage.setItem(STORAGE_KEY, l)
    } catch {
      /* storage 不可用则仅本次会话生效 */
    }
  }, [])

  const t = useCallback(
    (key: string, zhDefault: string) => (lang === 'en' ? EN[key] ?? zhDefault : zhDefault),
    [lang],
  )

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nState {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n 必须在 I18nProvider 内使用')
  return ctx
}
