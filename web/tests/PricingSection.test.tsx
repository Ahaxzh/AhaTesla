import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { PricingSection } from '@/components/settings/PricingSection'
import { renderWithProviders } from './test-utils'
import { server } from './msw'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/** 等待定价数据加载完成、输入框填充完毕可编辑 */
async function findRateInput(): Promise<HTMLInputElement> {
  const input = await screen.findByLabelText('默认电价（元每千瓦时）')
  await waitFor(() => expect(input).not.toBeDisabled())
  await waitFor(() => expect(input).toHaveValue(0.52))
  return input as HTMLInputElement
}

/** 等待地点表渲染完成（骨架期容器已在、行未出，需等首行开关出现） */
async function findLocationTable() {
  const table = await screen.findByTestId('location-table')
  await screen.findByTestId('tou-toggle-1')
  return table
}

describe('PricingSection', () => {
  it('渲染默认价、地点电价表与来源标注', async () => {
    renderWithProviders(<PricingSection />)
    await findRateInput()
    const table = await findLocationTable()
    expect(table).toHaveTextContent('家庭充电桩')
    expect(table).toHaveTextContent('超充 上海站')
    expect(table).toHaveTextContent('teslamate geofences')
  })

  it('编辑默认价并保存成功', async () => {
    const user = userEvent.setup()
    const bodies: number[] = []
    server.use(
      http.put('/api/pricing/default', async ({ request }) => {
        const body = (await request.json()) as { rate: number }
        bodies.push(body.rate)
        return HttpResponse.json({ ok: true })
      }),
    )
    renderWithProviders(<PricingSection />)
    const input = await findRateInput()
    await user.clear(input)
    await user.type(input, '0.61')
    await waitFor(() => expect(screen.getByTestId('save-rate')).toBeEnabled())
    await user.click(screen.getByTestId('save-rate'))
    await waitFor(() => expect(bodies).toEqual([0.61]))
    expect(await screen.findByText('默认电价已保存')).toBeInTheDocument()
  })

  it('非法输入（负数/为空）不发起保存请求', async () => {
    const user = userEvent.setup()
    const save = vi.fn()
    server.use(http.put('/api/pricing/default', () => { save(); return HttpResponse.json({ ok: true }) }))
    renderWithProviders(<PricingSection />)
    const input = await findRateInput()
    await user.clear(input)
    await waitFor(() => expect(screen.getByTestId('save-rate')).toBeEnabled())
    await user.click(screen.getByTestId('save-rate'))
    expect(await screen.findByText(/有效电价/)).toBeInTheDocument()
    await user.type(input, '-1')
    await user.click(screen.getByTestId('save-rate'))
    expect(save).not.toHaveBeenCalled()
    expect(await screen.findAllByText(/有效电价/)).not.toHaveLength(0)
  })

  it('TOU 行显示谷/峰摘要，固定行显示固定；展开回填表单值', async () => {
    renderWithProviders(<PricingSection />)
    const table = await findLocationTable()
    // 家庭充电桩（tou）：谷/峰摘要；超充（fixed）：固定
    expect(table).toHaveTextContent('谷')
    expect(table).toHaveTextContent('峰')
    expect(table).toHaveTextContent('固定')
    // 展开 loc 1，回填 mock 中的 tou 值
    await userEvent.click(screen.getByTestId('tou-toggle-1'))
    expect(screen.getByTestId('tou-form')).toBeInTheDocument()
    expect((screen.getByTestId('tou-off-start') as HTMLInputElement).value).toBe('23:00')
    expect((screen.getByTestId('tou-off-end') as HTMLInputElement).value).toBe('07:00')
    expect((screen.getByTestId('tou-off-rate') as HTMLInputElement).value).toBe('0.3')
    expect((screen.getByTestId('tou-peak-rate') as HTMLInputElement).value).toBe('1')
  })

  it('编辑谷段价保存分时电价，PUT 收到 priceMode=tou 与所填值', async () => {
    const user = userEvent.setup()
    const bodies: object[] = []
    server.use(
      http.put('/api/pricing/locations/:id', async ({ request }) => {
        bodies.push((await request.json()) as object)
        return HttpResponse.json({ ok: true })
      }),
    )
    renderWithProviders(<PricingSection />)
    await findLocationTable()
    await user.click(screen.getByTestId('tou-toggle-1'))
    const offRate = screen.getByTestId('tou-off-rate')
    await user.clear(offRate)
    await user.type(offRate, '0.35')
    await user.click(screen.getByTestId('tou-save'))
    await waitFor(() =>
      expect(bodies).toEqual([
        {
          priceMode: 'tou',
          tou: { offPeakStart: '23:00', offPeakEnd: '07:00', offPeakRate: 0.35, peakRate: 1 },
        },
      ]),
    )
    expect(await screen.findByText('分时电价已保存')).toBeInTheDocument()
    // 保存成功后表单收起
    await waitFor(() => expect(screen.queryByTestId('tou-form')).not.toBeInTheDocument())
  })

  it('切到固定计价保存，PUT 收到 priceMode=fixed', async () => {
    const user = userEvent.setup()
    const bodies: object[] = []
    server.use(
      http.put('/api/pricing/locations/:id', async ({ request }) => {
        bodies.push((await request.json()) as object)
        return HttpResponse.json({ ok: true })
      }),
    )
    renderWithProviders(<PricingSection />)
    await findLocationTable()
    await user.click(screen.getByTestId('tou-toggle-1'))
    await user.click(screen.getByTestId('tou-mode-fixed'))
    // 固定模式不渲染时间/单价字段
    expect(screen.queryByTestId('tou-off-rate')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('tou-save'))
    await waitFor(() => expect(bodies).toEqual([{ priceMode: 'fixed' }]))
    expect(await screen.findByText('已改为固定计价')).toBeInTheDocument()
  })

  it('再点同一行开关收起表单', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PricingSection />)
    await findLocationTable()
    await user.click(screen.getByTestId('tou-toggle-1'))
    expect(screen.getByTestId('tou-form')).toBeInTheDocument()
    await user.click(screen.getByTestId('tou-toggle-1'))
    expect(screen.queryByTestId('tou-form')).not.toBeInTheDocument()
  })
})
