import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen, waitFor } from '@testing-library/react'
import TripsPage from '@/pages/TripsPage'
import { renderWithProviders } from './test-utils'
import { server } from './msw'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('TripsPage', () => {
  it('渲染行程列表（第一页 20 条）', async () => {
    renderWithProviders(<TripsPage />)
    const items = await screen.findAllByTestId('trip-item')
    expect(items).toHaveLength(20)
    expect(items[0]).toHaveTextContent('起点1')
    expect(screen.getByText('共 45 条记录')).toBeInTheDocument()
  })

  it('分页：点击下一页加载第二页', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TripsPage />)
    await screen.findAllByTestId('trip-item')
    await user.click(screen.getByRole('button', { name: '下一页' }))
    const items = await waitFor(async () => {
      const els = screen.getAllByTestId('trip-item')
      expect(els[0]).toHaveTextContent('起点21')
      return els
    })
    expect(items).toHaveLength(20)
  })

  it('日期筛选触发重新请求并重置页码', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TripsPage />)
    await screen.findAllByTestId('trip-item')
    // 翻到第 2 页
    await user.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(screen.getAllByTestId('trip-item')[0]).toHaveTextContent('起点21'))
    // 设置开始日期 → 重置回第 1 页
    await user.type(screen.getByLabelText('开始日期'), '2026-10-01')
    await waitFor(() => expect(screen.getAllByTestId('trip-item')[0]).toHaveTextContent('起点1'))
    // 清除筛选按钮出现
    expect(screen.getByTestId('filter-clear')).toBeInTheDocument()
    await user.click(screen.getByTestId('filter-clear'))
    expect(screen.queryByTestId('filter-clear')).not.toBeInTheDocument()
  })
})
