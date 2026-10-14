import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import PricingPage from '@/pages/PricingPage'
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

describe('PricingPage', () => {
  it('渲染默认价、地点单价表与来源标注', async () => {
    renderWithProviders(<PricingPage />)
    await findRateInput()
    const table = screen.getByTestId('location-table')
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
    renderWithProviders(<PricingPage />)
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
    renderWithProviders(<PricingPage />)
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
})
