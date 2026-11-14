import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChargingHabitsCard } from '@/components/ChargingHabitsCard'
import { I18nProvider } from '@/i18n'
import { CarProvider } from '@/contexts/CarContext'
import type { ReactElement } from 'react'
import { server } from '../../tests/msw'

/** 组件依赖 useI18n + useCar + react-query，包三层 Provider（默认 zh） */
function renderCard(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <CarProvider>
        <I18nProvider>{ui}</I18nProvider>
      </CarProvider>
    </QueryClientProvider>,
  )
}

const habits = {
  days: 180,
  sessions: 24,
  sufficient: true,
  avgStartSoc: 32,
  avgEndSoc: 81,
  endAbove90Pct: 13,
  startBelow15Pct: 4,
  startHist: [0, 3, 6, 8, 4, 2, 1, 0, 0, 0],
  endHist: [0, 0, 0, 1, 2, 4, 6, 7, 3, 1],
}

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('ChargingHabitsCard（v2.5 充电习惯画像）', () => {
  it('渲染四指标 + 起止 SoC 双直方图 + 样本数', async () => {
    server.use(http.get('/api/charging/habits', () => HttpResponse.json(habits)))
    renderCard(<ChargingHabitsCard />)
    const card = await screen.findByTestId('habits-card')
    expect(card).toHaveTextContent('充电习惯')
    expect(card).toHaveTextContent('平均起充')
    expect(card).toHaveTextContent('32%')
    expect(card).toHaveTextContent('81%')
    expect(card).toHaveTextContent('13%')
    expect(card).toHaveTextContent('4%')
    expect(card).toHaveTextContent('近180天 · 24次')
    const hist = within(card).getByTestId('habits-histogram')
    expect(hist).toHaveTextContent('起充 SoC')
    expect(hist).toHaveTextContent('收枪 SoC')
  })

  it('样本不足（sufficient=false）→ 整卡隐藏不占版面', async () => {
    server.use(http.get('/api/charging/habits', () => HttpResponse.json({ ...habits, sessions: 3, sufficient: false })))
    const { container } = renderCard(<ChargingHabitsCard />)
    // 等一拍让查询落地后再断言不存在
    await new Promise((r) => setTimeout(r, 50))
    expect(container.querySelector('[data-testid="habits-card"]')).not.toBeInTheDocument()
  })
})
