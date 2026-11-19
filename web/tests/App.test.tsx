import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import App from '@/App'
import { renderWithProviders } from './test-utils'
import { server } from './msw'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/**
 * v2.7 认证守卫提到应用壳外层（修复：未登录首次打开先闪主界面再跳登录）。
 * 回归红线：未登录时应用壳的任何部分（侧栏/底部栏/顶栏）都不得渲染。
 */
describe('认证守卫与首屏（v2.7）', () => {
  it('未登录打开 /：应用壳不渲染，探测完成后落在登录页', async () => {
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json({ error: { code: 'UNAUTHORIZED', message: '未登录' } }, { status: 401 }),
      ),
      http.get('/api/setup/status', () =>
        HttpResponse.json({ state: 'ready', https: true, carFound: true }),
      ),
    )
    renderWithProviders(<App />, { route: '/' })
    expect(await screen.findByTestId('login-card', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByTestId('mobile-tabbar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('desktop-sidebar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mobile-topbar')).not.toBeInTheDocument()
  })

  it('已登录打开 /：渲染应用壳（探测完成前 splash 不闪壳）', async () => {
    renderWithProviders(<App />, { route: '/' })
    expect(await screen.findByTestId('mobile-tabbar', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByTestId('desktop-sidebar')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-topbar')).toBeInTheDocument()
    expect(screen.queryByTestId('auth-splash')).not.toBeInTheDocument()
  })
})
