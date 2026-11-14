import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EfficiencyCard } from '@/components/EfficiencyCard'
import { I18nProvider } from '@/i18n'
import { CarProvider } from '@/contexts/CarContext'
import type { ReactElement } from 'react'
import { server } from '../../tests/msw'

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

const profile = {
  days: 365,
  samples: 93,
  best: { whPerKm: 121, distanceKm: 86.2, tempC: 18, avgSpeedKmh: 62, at: '2026-10-12T01:30:00Z' },
  tempBins: [
    { label: '<0°C', whPerKm: 182, count: 8 },
    { label: '0~10°C', whPerKm: 158, count: 20 },
    { label: '10~20°C', whPerKm: 141, count: 35 },
    { label: '20~30°C', whPerKm: 134, count: 26 },
  ],
  speedBins: [
    { label: '0~40 km/h', whPerKm: 168, count: 24 },
    { label: '40~60 km/h', whPerKm: 139, count: 33 },
    { label: '60~80 km/h', whPerKm: 129, count: 27 },
  ],
}

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('EfficiencyCard（v2.6 能效画像）', () => {
  it('最佳战绩 + 表显达成率 + 温度/速度分箱', async () => {
    renderCard(<EfficiencyCard />)
    const card = await screen.findByTestId('trip-efficiency-card')
    expect(card).toHaveTextContent('能效画像')
    const best = screen.getByTestId('eff-best')
    expect(best).toHaveTextContent('121 Wh/km')
    expect(best).toHaveTextContent('18°C')
    expect(best).toHaveTextContent('62 km/h')
    expect(screen.getByTestId('eff-accuracy')).toHaveTextContent('98%')
    expect(screen.getByTestId('eff-monthly')).toBeInTheDocument()
    expect(card).toHaveTextContent('按气温')
    expect(card).toHaveTextContent('按均速')
    expect(card).toHaveTextContent('60~80 km/h')
  })

  it('样本不足 → 整卡隐藏', async () => {
    server.use(
      http.get('/api/trips/efficiency-profile', () => HttpResponse.json({ ...profile, samples: 3 })),
    )
    const { container } = renderCard(<EfficiencyCard />)
    await new Promise((r) => setTimeout(r, 50))
    expect(container.querySelector('[data-testid="trip-efficiency-card"]')).not.toBeInTheDocument()
  })
})
