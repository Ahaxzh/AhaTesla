import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { BatteryRing } from '@/components/BatteryRing'
import { I18nProvider } from '@/i18n'

function Boom(): never {
  throw new Error('null.toFixed exploded')
}

describe('ErrorBoundary（单页崩溃不白屏）', () => {
  it('渲染异常时显示兜底卡与重试按钮，而非整树崩塌', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <I18nProvider>
        <ErrorBoundary resetKey="/charging">
          <Boom />
        </ErrorBoundary>
      </I18nProvider>,
    )
    expect(screen.getByTestId('page-error')).toBeTruthy()
    expect(screen.getByText('重试')).toBeTruthy()
    expect(screen.getByText(/null\.toFixed exploded/)).toBeTruthy()
    spy.mockRestore()
  })

  it('正常子树原样渲染', () => {
    render(
      <ErrorBoundary resetKey="/">
        <div data-testid="fine">ok</div>
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('fine')).toBeTruthy()
  })
})

describe('BatteryRing 空值（车辆睡眠/数据缺失）', () => {
  it('percent 为 null 显示 -- 与中性灰环，不再伪装红色 0%', () => {
    const { container } = render(<BatteryRing percent={null} />)
    expect(screen.getByTestId('battery-ring').textContent).toContain('--')
    const circles = container.querySelectorAll('circle')
    // 第二个 circle 是进度环：中性灰（非红色 #E82127）
    expect(circles[1].getAttribute('stroke')).not.toBe('#E82127')
  })

  it('正常电量仍按档位着色并显示数值', () => {
    render(<BatteryRing percent={80} />)
    expect(screen.getByTestId('battery-ring').textContent).toContain('80')
  })
})
