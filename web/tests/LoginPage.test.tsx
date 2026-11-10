import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from './msw'
import LoginPage from '@/pages/LoginPage'
import { LoginRoute } from '@/App'
import { Routes, Route } from 'react-router-dom'
import { renderWithProviders } from './test-utils'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/** 癝待 auth 鎺㈡祴锛?api/auth/me 杩斿洖 401锛夊畬鎴愩€佺櫥褰曡〃鍗曞嚭鐜� */
async function renderLoginReady() {
  server.use(
    http.get('/api/auth/me', () =>
      HttpResponse.json({ error: { code: 'UNAUTHORIZED', message: '未登录' } }, { status: 401 }),
    ),
  )
  renderWithProviders(<LoginPage />)
  return screen.findByTestId('login-card')
}

describe('LoginPage', () => {
  it('渲染居中登录卡片与表单', async () => {
    const card = await renderLoginReady()
    expect(card).toBeInTheDocument()
    expect(screen.getByLabelText('用户名')).toBeInTheDocument()
    expect(screen.getByLabelText('密码')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /登\s*录/ })).toBeEnabled()
  })

  it('空表单提交显示校验错误，不发送请求', async () => {
    const user = userEvent.setup()
    await renderLoginReady()
    await user.click(screen.getByTestId('login-submit'))
    expect(await screen.findByTestId('login-error')).toHaveTextContent('请输入用户名')
  })

  it('只填用户名时提示输入密码', async () => {
    const user = userEvent.setup()
    await renderLoginReady()
    await user.type(screen.getByLabelText('用户名'), 'aha')
    await user.click(screen.getByTestId('login-submit'))
    expect(await screen.findByTestId('login-error')).toHaveTextContent('请输入密码')
  })

  it('错误凭据显示服务端错误信息', async () => {
    const user = userEvent.setup()
    await renderLoginReady()
    await user.type(screen.getByLabelText('用户名'), 'aha')
    await user.type(screen.getByLabelText('密码'), 'wrongpass')
    await user.click(screen.getByTestId('login-submit'))
    expect(await screen.findByTestId('login-error')).toHaveTextContent('用户名或密码错误')
  })

  it('正确凭据登录成功并触发回调跳转', async () => {
    const user = userEvent.setup()
    await renderLoginReady()
    await user.type(screen.getByLabelText('用户名'), 'aha')
    await user.type(screen.getByLabelText('密码'), 'pass1234')
    await user.click(screen.getByTestId('login-submit'))
    // 登录成功后重定向（Authorized guard 移除表单）
    await waitFor(() => {
      expect(screen.queryByTestId('login-card')).not.toBeInTheDocument()
    })
  })

  it('密码可见性切换', async () => {
    const user = userEvent.setup()
    await renderLoginReady()
    const pwd = screen.getByLabelText('密码') as HTMLInputElement
    await user.type(pwd, 'secret')
    expect(pwd.type).toBe('password')
    await user.click(screen.getByRole('button', { name: '显示密码' }))
    expect(pwd.type).toBe('text')
    await user.click(screen.getByRole('button', { name: '隐藏密码' }))
    expect(pwd.type).toBe('password')
  })
})

describe('LoginRoute 路由分流', () => {
  it('实例未初始化 → /login 重定向 /setup 向导（新用户不再看到死登录框）', async () => {
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json({ error: { code: 'UNAUTHORIZED', message: '未登录' } }, { status: 401 }),
      ),
      http.get('/api/setup/status', () =>
        HttpResponse.json({ state: 'uninitialized', https: false, carFound: false }),
      ),
    )
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
        <Route path="/setup" element={<div data-testid="setup-admin-form">wizard</div>} />
      </Routes>,
      { route: '/login' },
    )
    await waitFor(() => expect(screen.getByTestId('setup-admin-form')).toBeInTheDocument())
    expect(screen.queryByTestId('login-card')).not.toBeInTheDocument()
  })

  it('实例已就绪（setup-locked/ready）→ 停留登录页', async () => {
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json({ error: { code: 'UNAUTHORIZED', message: '未登录' } }, { status: 401 }),
      ),
      http.get('/api/setup/status', () =>
        HttpResponse.json({ state: 'ready', https: true, carFound: true }),
      ),
    )
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
        <Route path="/setup" element={<div data-testid="setup-admin-form">wizard</div>} />
      </Routes>,
      { route: '/login' },
    )
    expect(await screen.findByTestId('login-card')).toBeInTheDocument()
    expect(screen.queryByTestId('setup-admin-form')).not.toBeInTheDocument()
  })
})
