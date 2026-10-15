import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import SettingsPage from '@/pages/SettingsPage'
import { renderWithProviders } from './test-utils'
import { server } from './msw'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('SettingsPage', () => {
  it('渲染账户卡片与修改密码表单', async () => {
    renderWithProviders(<SettingsPage />)
    // v2.2：账户信息合并进页头（无独立 account-card）
    expect(await screen.findByText(/aha.*单用户模式/s)).toBeInTheDocument()
    expect(screen.getByTestId('change-password-card')).toBeInTheDocument()
  })

  it('密码不一致与过短密码被前端拦截', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)
    await screen.findByTestId('change-password-card')
    await user.type(screen.getByLabelText('当前密码'), 'old')
    await user.type(screen.getByLabelText('新密码'), '123')
    await user.type(screen.getByLabelText('确认新密码'), '123')
    await user.click(screen.getByTestId('password-submit'))
    expect(await screen.findByTestId('password-error')).toHaveTextContent('至少 8 位')

    await user.clear(screen.getByLabelText('新密码'))
    await user.clear(screen.getByLabelText('确认新密码'))
    await user.type(screen.getByLabelText('新密码'), 'newpass99')
    await user.type(screen.getByLabelText('确认新密码'), 'different')
    await user.click(screen.getByTestId('password-submit'))
    expect(await screen.findByTestId('password-error')).toHaveTextContent('不一致')
  })

  it('修改密码成功提示', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/auth/change-password', () => HttpResponse.json({ ok: true })),
    )
    renderWithProviders(<SettingsPage />)
    await screen.findByTestId('change-password-card')
    await user.type(screen.getByLabelText('当前密码'), 'old')
    await user.type(screen.getByLabelText('新密码'), 'newpass99')
    await user.type(screen.getByLabelText('确认新密码'), 'newpass99')
    await user.click(screen.getByTestId('password-submit'))
    expect(await screen.findByText('密码已修改')).toBeInTheDocument()
    await waitFor(() => expect((screen.getByLabelText('新密码') as HTMLInputElement).value).toBe(''))
  })
})
