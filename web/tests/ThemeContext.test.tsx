import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext'

/** 可控的 matchMedia 桩：fire() 模拟系统配色切换事件 */
function mockMatchMedia(matches: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>()
  const mq = {
    matches,
    addEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => listeners.delete(cb),
  }
  vi.stubGlobal('matchMedia', () => mq)
  return {
    fire(next: boolean) {
      mq.matches = next
      listeners.forEach((cb) => cb({ matches: next }))
    },
  }
}

/** 消费者探针：暴露 theme/resolved 与三个切换按钮 */
function Probe() {
  const { theme, resolved, setTheme } = useTheme()
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolved}</span>
      <button onClick={() => setTheme('light')}>to-light</button>
      <button onClick={() => setTheme('dark')}>to-dark</button>
      <button onClick={() => setTheme('system')}>to-system</button>
    </div>
  )
}

function setup(matches = false) {
  const mm = mockMatchMedia(matches)
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  )
  return mm
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  delete document.documentElement.dataset.theme
  document.documentElement.style.colorScheme = ''
})

describe('ThemeContext', () => {
  it('默认 system：跟随系统浅色时 resolved=light 并写入 dataset', () => {
    setup(false)
    expect(screen.getByTestId('theme')).toHaveTextContent('system')
    expect(screen.getByTestId('resolved')).toHaveTextContent('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('system 且系统为深色时 resolved=dark', () => {
    setup(true)
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('setTheme("light") 生效并持久化到 localStorage', () => {
    setup(true) // 系统深色，显式选浅色应覆盖系统
    fireEvent.click(screen.getByText('to-light'))
    expect(screen.getByTestId('resolved')).toHaveTextContent('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('ahatesla_theme')).toBe('light')
  })

  it('system 模式下系统配色变化实时切换', () => {
    const mm = setup(false)
    expect(screen.getByTestId('resolved')).toHaveTextContent('light')
    act(() => mm.fire(true))
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    act(() => mm.fire(false))
    expect(screen.getByTestId('resolved')).toHaveTextContent('light')
  })

  it('显式 dark 不受系统切换影响', () => {
    const mm = setup(false)
    fireEvent.click(screen.getByText('to-dark'))
    mm.fire(false) // 系统仍浅色，显式选择优先
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark')
  })

  it('localStorage 存在合法值时初始化为该偏好', () => {
    localStorage.setItem('ahatesla_theme', 'dark')
    setup(false) // 系统浅色
    expect(screen.getByTestId('theme')).toHaveTextContent('dark')
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark')
  })

  it('localStorage 非法值回退 system', () => {
    localStorage.setItem('ahatesla_theme', 'pink')
    setup(false)
    expect(screen.getByTestId('theme')).toHaveTextContent('system')
  })

  it('matchMedia 不可用时默认深色且不崩溃', () => {
    vi.stubGlobal('matchMedia', undefined)
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('theme')).toHaveTextContent('system')
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
