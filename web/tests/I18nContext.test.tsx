import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider, useI18n } from '@/i18n'

/** 探针组件:暴露 t() 结果与 setLang 按钮 */
function Probe() {
  const { lang, setLang, t } = useI18n()
  return (
    <div>
      <span data-testid="lang">{lang}</span>
      <span data-testid="hit">{t('settings.title', '设置')}</span>
      <span data-testid="miss">{t('some.unknown.key', '未知文案')}</span>
      <button onClick={() => setLang('en')}>to-en</button>
      <button onClick={() => setLang('zh')}>to-zh</button>
    </div>
  )
}

function renderProbe() {
  return render(
    <I18nProvider>
      <Probe />
    </I18nProvider>,
  )
}

afterEach(() => {
  localStorage.clear()
  document.documentElement.lang = ''
})

describe('I18nContext', () => {
  it('默认 zh:t 直接返回中文默认文案(不查词典)', () => {
    renderProbe()
    expect(screen.getByTestId('lang')).toHaveTextContent('zh')
    expect(screen.getByTestId('hit')).toHaveTextContent('设置')
    expect(screen.getByTestId('miss')).toHaveTextContent('未知文案')
  })

  it('setLang(en) 后命中词典返回英文,未命中回退中文', () => {
    renderProbe()
    fireEvent.click(screen.getByText('to-en'))
    expect(screen.getByTestId('lang')).toHaveTextContent('en')
    expect(screen.getByTestId('hit')).toHaveTextContent('Settings')
    expect(screen.getByTestId('miss')).toHaveTextContent('未知文案')
  })

  it('切换回 zh 后恢复中文', () => {
    renderProbe()
    fireEvent.click(screen.getByText('to-en'))
    fireEvent.click(screen.getByText('to-zh'))
    expect(screen.getByTestId('hit')).toHaveTextContent('设置')
  })

  it('语言持久化 localStorage,重新挂载读取记忆值', () => {
    const { unmount } = renderProbe()
    fireEvent.click(screen.getByText('to-en'))
    expect(localStorage.getItem('ahatesla_lang')).toBe('en')
    unmount()

    renderProbe()
    expect(screen.getByTestId('lang')).toHaveTextContent('en')
    expect(screen.getByTestId('hit')).toHaveTextContent('Settings')
  })

  it('<html lang> 跟随界面语言(无障碍)', () => {
    renderProbe()
    expect(document.documentElement.lang).toBe('zh')
    fireEvent.click(screen.getByText('to-en'))
    expect(document.documentElement.lang).toBe('en')
  })
})
