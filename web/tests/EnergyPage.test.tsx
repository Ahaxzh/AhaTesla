import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import EnergyPage from '@/pages/EnergyPage'
import { renderWithProviders } from './test-utils'
import { server } from './msw'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/**
 * 能耗页 v2.8：车机能量 App 四窗同构。
 * 四卡（最近行程/自上次充电/近30天/近两年）+ 点卡展开详情（车机式头条：比额定 ±X km）。
 */
describe('能耗页：四卡同屏', () => {
  it('四卡渲染：平均 Wh/km 大数 + 迷你趋势 + km/kWh/时长小字，trip 卡默认激活', async () => {
    renderWithProviders(<EnergyPage />)
    expect(await screen.findByTestId('energy-cards')).toBeInTheDocument()
    // trip 卡（mock 最新一趟 17.9 kWh/100km → 179 Wh/km；卡面与 KPI 各一处）
    const tripCard = screen.getByTestId('energy-card-trip')
    await screen.findAllByText('179 Wh/km')
    expect(tripCard).toHaveAttribute('aria-pressed', 'true')
    expect(tripCard).toHaveTextContent('32 km')
    expect(tripCard.textContent).toContain('179 Wh/km')
    // 其余三卡（mock overview: 223.1kWh/1240.5km → 180 Wh/km）
    const m30Card = screen.getByTestId('energy-card-m30')
    expect(m30Card).toHaveTextContent('180 Wh/km')
    expect(m30Card).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('energy-card-y2')).toBeInTheDocument()
    // since 卡：mock 有充电记录 → 有数字
    expect(screen.getByTestId('energy-card-since')).toBeInTheDocument()
    // 详情区默认展开 trip 窗：头条 + KPI
    expect(screen.getByTestId('energy-headline')).toHaveTextContent(/km/)
  })

  it('车机式头条：overview.ratedUsedKm 与里程差 → 比额定少跑（橙）', async () => {
    renderWithProviders(<EnergyPage />)
    await screen.findByTestId('energy-cards')
    await userEvent.click(screen.getByTestId('energy-card-m30'))
    const headline = await screen.findByTestId('energy-headline')
    // mock: 1240.5 actual − 1265.3 rated = −24.8
    expect(headline).toHaveTextContent(/少跑/)
    expect(screen.getByTestId('energy-headline-delta')).toHaveTextContent('24.8')
  })

  it('切近两年窗：详情含月度图 + 能效画像 + 满电预估', async () => {
    renderWithProviders(<EnergyPage />)
    await screen.findByTestId('energy-cards')
    await userEvent.click(screen.getByTestId('energy-card-y2'))
    expect(await screen.findByTestId('energy-monthly-card')).toBeInTheDocument()
    expect(await screen.findByTestId('trip-efficiency-card')).toBeInTheDocument()
    expect(screen.getByTestId('energy-projected')).toBeInTheDocument()
  })

  it('无充电记录：since 卡禁用并显示「尚无充电记录」，点开为空态', async () => {
    server.use(http.get('/api/charging', () => HttpResponse.json({ total: 0, items: [] })))
    renderWithProviders(<EnergyPage />)
    await screen.findByTestId('energy-cards')
    const card = screen.getByTestId('energy-card-since')
    expect(card).toBeDisabled()
    expect(card).toHaveTextContent('尚无充电记录')
    await userEvent.click(screen.getByTestId('energy-card-y2'))
    await screen.findByTestId('energy-monthly-card')
    // 再点 since 卡（disabled 不触发，详情仍是 y2）
    await userEvent.click(card)
    expect(screen.getByTestId('energy-monthly-card')).toBeInTheDocument()
  })

  it('无行程数据：trip 卡为 --，空窗不崩', async () => {
    server.use(http.get('/api/trips', () => HttpResponse.json({ total: 0, items: [] })))
    renderWithProviders(<EnergyPage />)
    await screen.findByTestId('energy-cards')
    expect(screen.getByTestId('energy-card-trip')).toHaveTextContent('--')
  })
})
