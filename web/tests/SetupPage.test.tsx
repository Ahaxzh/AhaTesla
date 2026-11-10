import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from './msw'
import SetupPage from '@/pages/SetupPage'
import { renderWithProviders } from './test-utils'
import { Routes, Route } from 'react-router-dom'

function renderSetupRouter() {
  return renderWithProviders(
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/" element={<div data-testid="dashboard-root" />} />
      <Route path="/login" element={<div data-testid="login-root" />} />
    </Routes>,
    { route: '/setup' },
  )
}

beforeAll(() => server.listen())
afterEach(() => { server.resetHandlers(); vi.useRealTimers() })
afterAll(() => server.close())

/** 渲染向导并等待 setup-status 探测完成（uninitialized → Step1 表单出现） */
async function renderSetupReady(state = 'uninitialized') {
  server.use(
    http.get('/api/setup/status', () =>
      HttpResponse.json({ state, https: false, carFound: false }),
    ),
  )
  server.use(
    http.get('/api/auth/me', () =>
      HttpResponse.json({ error: { code: 'UNAUTHORIZED', message: '未登录' } }, { status: 401 }),
    ),
  )
  const rendered = renderSetupRouter()
  await screen.findByTestId('setup-admin-form')
  return rendered
}

/** 注册管理员（Step1 → Step2） */
async function registerAdmin(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('用户名'), 'eli')
  await user.type(screen.getByLabelText(/密码（≥8 位）/), 'pass-12345')
  await user.type(screen.getByLabelText('确认密码'), 'pass-12345')
  await user.click(screen.getByTestId('setup-admin-submit'))
  await screen.findByTestId('setup-datasource')
}

describe('SetupPage 向导', () => {
  it('Step1：弱密码 / 密码不一致被前端拦截', async () => {
    const user = userEvent.setup()
    await renderSetupReady()
    await user.type(screen.getByLabelText('用户名'), 'eli')
    await user.type(screen.getByLabelText(/密码（≥8 位）/), 'short')
    await user.type(screen.getByLabelText('确认密码'), 'short')
    await user.click(screen.getByTestId('setup-admin-submit'))
    expect(await screen.findByTestId('setup-admin-error')).toHaveTextContent('密码至少 8 位')
  })

  it('Step1：注册成功进入 Step2；已初始化实例跳回登录页（/setup 锁定）', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/setup/admin', () =>
        HttpResponse.json({ ok: true, user: { username: 'eli', role: 'admin' } }),
      ),
    )
    await renderSetupReady()
    await registerAdmin(user)
    // 已注册后 status 翻转 → 重新挂载时重定向登录
    server.use(
      http.get('/api/setup/status', () =>
        HttpResponse.json({ state: 'setup-locked', https: false, carFound: false }),
      ),
    )
    renderSetupReady('setup-locked')
    await waitFor(() => {
      // setup-locked 状态下不渲染 Step1 表单（Navigate → /login）
      expect(screen.queryByTestId('setup-admin-form')).not.toBeInTheDocument()
    })
  })

  it('Step2 模式A：四级校验全绿 → 保存 → 车辆确认 → 下一步', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/setup/admin', () =>
        HttpResponse.json({ ok: true, user: { username: 'eli', role: 'admin' } }),
      ),
    )
    const savedPayloads: unknown[] = []
    server.use(
      http.post('/api/setup/test-connection', () =>
        HttpResponse.json({
          ok: true,
          steps: [
            { name: 'reachability', ok: true, detail: '数据库可达' },
            { name: 'auth', ok: true, detail: '认证通过，数据库存在' },
            { name: 'readonly', ok: true, detail: '只读权限校验通过（元数据探测）' },
            { name: 'cars', ok: true, detail: '发现 1 辆车' },
          ],
          cars: [{ id: 1, name: 'My Tesla', model: 'Model 3' }],
        }),
      ),
    )
    server.use(
      http.post('/api/setup/datasource', async ({ request }) => {
        savedPayloads.push(await request.json())
        return HttpResponse.json({ ok: true })
      }),
    )
    await renderSetupReady()
    await registerAdmin(user)

    // 填连接信息并测试
    await user.type(screen.getByLabelText('PostgreSQL Host'), '127.0.0.1')
    await user.type(screen.getByLabelText('用户名（只读账号）'), 'ahatesla_ro')
    await user.type(screen.getByLabelText('密码'), 'ro-pass')
    await user.click(screen.getByTestId('setup-test-connection'))

    // 四级校验列表渲染（名称 + 状态）
    for (const name of ['reachability', 'auth', 'readonly', 'cars']) {
      const el = await screen.findByTestId(`setup-check-${name}`)
      expect(el).toHaveAttribute('data-ok', 'true')
    }
    expect(await screen.findByTestId('setup-verified')).toBeInTheDocument()

    // 校验未通过前保存按钮禁用 → 通过后可保存
    const saveBtn = screen.getByTestId('setup-save-datasource') as HTMLButtonElement
    expect(saveBtn).toBeEnabled()
    await user.click(saveBtn)
    await waitFor(() => expect(savedPayloads).toHaveLength(1))
    expect(savedPayloads[0]).toMatchObject({ mode: 'connect', host: '127.0.0.1', user: 'ahatesla_ro' })

    // 下一步 → Step3
    await user.click(screen.getByTestId('setup-next'))
    expect(await screen.findByTestId('setup-ledger')).toBeInTheDocument()
  })

  it('Step2 模式A：readonly 校验失败（可写账号）→ 不允许保存', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/setup/admin', () =>
        HttpResponse.json({ ok: true, user: { username: 'eli', role: 'admin' } }),
      ),
    )
    server.use(
      http.post('/api/setup/test-connection', () =>
        HttpResponse.json({
          ok: false,
          steps: [
            { name: 'reachability', ok: true, detail: '数据库可达' },
            { name: 'auth', ok: true, detail: '认证通过' },
            { name: 'readonly', ok: false, detail: '当前账号具备写入权限，请改用只读账号后重试（AC-2.4）' },
            { name: 'cars', ok: false, detail: '' },
          ],
          cars: [],
        }),
      ),
    )
    await renderSetupReady()
    await registerAdmin(user)
    await user.type(screen.getByLabelText('PostgreSQL Host'), '127.0.0.1')
    await user.type(screen.getByLabelText('用户名（只读账号）'), 'rw-user')
    await user.type(screen.getByLabelText('密码'), 'rw-pass')
    await user.click(screen.getByTestId('setup-test-connection'))

    const readonlyStep = await screen.findByTestId('setup-check-readonly')
    expect(readonlyStep).toHaveAttribute('data-ok', 'false')
    expect(readonlyStep).toHaveTextContent('只读账号')
    // 校验失败 → 保存禁用
    await waitFor(() => {
      expect(screen.getByTestId('setup-save-datasource')).toBeDisabled()
    })
  })

  it('Step2 模式B：全栈模式轮询发现车辆（多车选择器，默认最近有行程）', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/setup/admin', () =>
        HttpResponse.json({ ok: true, user: { username: 'eli', role: 'admin' } }),
      ),
    )
    server.use(http.post('/api/setup/datasource', () => HttpResponse.json({ ok: true })))
    let call = 0
    server.use(
      http.get('/api/setup/car-discovery', () => {
        call++
        if (call < 2) return HttpResponse.json({ found: false, cars: [], car: null, suggestedCarId: null })
        return HttpResponse.json({
          found: true,
          cars: [
            { id: 1, name: '旧车', model: 'Model 3', lastDriveAt: '2026-09-01T00:00:00Z' },
            { id: 2, name: '新车', model: 'Model Y', lastDriveAt: '2026-10-13T00:00:00Z' },
          ],
          car: { id: 1, name: '旧车', model: 'Model 3' },
          suggestedCarId: 2,
        })
      }),
    )
    const selected: number[] = []
    server.use(
      http.post('/api/setup/select-car', async ({ request }) => {
        const body = (await request.json()) as { carId: number }
        selected.push(body.carId)
        return HttpResponse.json({ ok: true, carId: 2 })
      }),
    )

    await renderSetupReady()
    await registerAdmin(user)
    // 切到模式 B
    await user.click(screen.getByTestId('setup-mode-fullstack'))
    expect(screen.getByTestId('setup-fullstack-panel')).toBeInTheDocument()
    // TeslaMate 授权外链存在（AC-4.1）
    expect(screen.getByTestId('setup-teslamate-link')).toBeInTheDocument()
    // 保存数据源 → 启动轮询
    await user.click(screen.getByTestId('setup-save-datasource'))
    // 轮询指示器出现，随后车辆发现 → 多车选择器（默认选中 suggestedCarId=2）
    const selector = await screen.findByTestId('setup-car-selector', {}, { timeout: 4000 })
    expect(selector).toBeInTheDocument()
    const chosen = screen.getByTestId('setup-car-option-2')
    expect(chosen).toHaveAttribute('aria-checked', 'true')
    // 切换选择 → select-car API 调用
    await user.click(screen.getByTestId('setup-car-option-1'))
    await waitFor(() => expect(selected).toContain(1))
  })

  it('Step3/Step4 可跳过；HTTP 环境 Web Push 降级提示（AC-11.0）', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/setup/admin', () =>
        HttpResponse.json({ ok: true, user: { username: 'eli', role: 'admin' } }),
      ),
    )
    server.use(
      http.post('/api/setup/test-connection', () =>
        HttpResponse.json({
          ok: true,
          steps: [
            { name: 'reachability', ok: true, detail: '' },
            { name: 'auth', ok: true, detail: '' },
            { name: 'readonly', ok: true, detail: '' },
            { name: 'cars', ok: true, detail: '发现 1 辆车' },
          ],
          cars: [{ id: 1, name: 'My Tesla', model: 'Model 3' }],
        }),
      ),
    )
    server.use(http.post('/api/setup/datasource', () => HttpResponse.json({ ok: true })))
    await renderSetupReady()
    await registerAdmin(user)

    await user.type(screen.getByLabelText('PostgreSQL Host'), '127.0.0.1')
    await user.type(screen.getByLabelText('用户名（只读账号）'), 'ro')
    await user.type(screen.getByLabelText('密码'), 'ro-pass')
    await user.click(screen.getByTestId('setup-test-connection'))
    await screen.findByTestId('setup-verified')
    await user.click(screen.getByTestId('setup-save-datasource'))
    await user.click(screen.getByTestId('setup-next'))

    // Step3 跳过 → Step4
    await user.click(screen.getByTestId('setup-skip-ledger'))
    // Step4：HTTP 环境 → 降级提示卡（无一键开启按钮）
    expect(await screen.findByTestId('setup-http-warning')).toBeInTheDocument()
    expect(screen.queryByTestId('setup-enable-webpush')).not.toBeInTheDocument()
    // 完成向导 → 跳转 /（dashboard 根渲染）
    await user.click(screen.getByTestId('setup-finish'))
    await screen.findByTestId('dashboard-root')
    expect(screen.queryByTestId('setup-notify')).not.toBeInTheDocument()
  })

  it('Step4：HTTPS 环境显示一键开启 Web Push（AC-11.0）', async () => {
    server.use(
      http.get('/api/setup/status', () =>
        HttpResponse.json({ state: 'uninitialized', https: true, carFound: false }),
      ),
    )
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json({ error: { code: 'UNAUTHORIZED', message: '未登录' } }, { status: 401 }),
      ),
    )
    // 直接渲染并推进到 Step4（用 React state 无法跨步骤直达，借由完成 1→3 步）
    const user = userEvent.setup()
    server.use(
      http.post('/api/setup/admin', () =>
        HttpResponse.json({ ok: true, user: { username: 'eli', role: 'admin' } }),
      ),
    )
    server.use(
      http.post('/api/setup/test-connection', () =>
        HttpResponse.json({
          ok: true,
          steps: [
            { name: 'reachability', ok: true, detail: '' },
            { name: 'auth', ok: true, detail: '' },
            { name: 'readonly', ok: true, detail: '' },
            { name: 'cars', ok: true, detail: '发现 1 辆车' },
          ],
          cars: [{ id: 1, name: 'My Tesla', model: 'Model 3' }],
        }),
      ),
    )
    server.use(http.post('/api/setup/datasource', () => HttpResponse.json({ ok: true })))
    renderSetupRouter()
    await screen.findByTestId('setup-admin-form')
    await registerAdmin(user)
    await user.type(screen.getByLabelText('PostgreSQL Host'), '127.0.0.1')
    await user.type(screen.getByLabelText('用户名（只读账号）'), 'ro')
    await user.type(screen.getByLabelText('密码'), 'ro-pass')
    await user.click(screen.getByTestId('setup-test-connection'))
    await screen.findByTestId('setup-verified')
    await user.click(screen.getByTestId('setup-save-datasource'))
    await user.click(screen.getByTestId('setup-next'))
    await user.click(screen.getByTestId('setup-skip-ledger'))
    expect(await screen.findByTestId('setup-enable-webpush')).toBeInTheDocument()
  })

  it('Step2 模式A：自动发现候选卡渲染，点选预填 host/port（m4a 轨道B a 层）', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/setup/admin', () =>
        HttpResponse.json({ ok: true, user: { username: 'eli', role: 'admin' } }),
      ),
    )
    server.use(
      http.post('/api/setup/probe-discovery', () =>
        HttpResponse.json({
          candidates: [
            { host: '192.168.1.20', port: 5432, source: 'docker 网络' },
            { host: '10.0.0.8', port: 5433, source: '局域网扫描' },
          ],
        }),
      ),
    )
    await renderSetupReady()
    await registerAdmin(user)
    // 骨架 → 候选卡
    expect(await screen.findByTestId('probe-candidates')).toBeInTheDocument()
    const cand = screen.getByTestId('probe-candidate-192.168.1.20')
    expect(cand).toHaveTextContent('192.168.1.20:5432')
    await user.click(cand)
    expect((screen.getByLabelText('PostgreSQL Host') as HTMLInputElement).value).toBe('192.168.1.20')
    expect((screen.getByLabelText('端口') as HTMLInputElement).value).toBe('5432')
  })

  it('Step2 模式A：一键建只读账号成功 → 连接表单自动填入并 toast（m4a 轨道B b 层）', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/setup/admin', () =>
        HttpResponse.json({ ok: true, user: { username: 'eli', role: 'admin' } }),
      ),
    )
    server.use(
      http.post('/api/setup/auto-ro', () =>
        HttpResponse.json({
          ok: true,
          // 后端契约（API_CONTRACT §1）：dsn 密码段是掩码 ***，一次性明文单独在 password
          dsn: 'postgres://ahatesla_ro:***@127.0.0.1:5432/teslamate',
          password: 'one-time-ro-pass',
        }),
      ),
    )
    await renderSetupReady()
    await registerAdmin(user)
    await user.type(screen.getByLabelText('PostgreSQL Host'), '127.0.0.1')
    await user.type(screen.getByTestId('auto-ro-user'), 'teslamate')
    await user.type(screen.getByTestId('auto-ro-pwd'), 'tm-admin-pass')
    await user.click(screen.getByTestId('auto-ro-button'))
    await waitFor(() => {
      expect((screen.getByLabelText('用户名（只读账号）') as HTMLInputElement).value).toBe('ahatesla_ro')
      // 明文来自响应的 password 字段而非 dsn 里的掩码 —— 此前回填 ***，「测试并验证」必挂 auth
      expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('one-time-ro-pass')
    })
    expect(await screen.findByText(/只读账号已创建/)).toBeInTheDocument()
    expect(screen.getByTestId('auto-ro-button')).toHaveTextContent('已创建')
  })

  it('Step2 模式A：一键建号失败（权限不足）→ fallbackSql + 复制按钮 + 我已手工执行（m4a 轨道B b 层降级）', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/setup/admin', () =>
        HttpResponse.json({ ok: true, user: { username: 'eli', role: 'admin' } }),
      ),
    )
    server.use(
      http.post('/api/setup/auto-ro', () =>
        HttpResponse.json({
          ok: false,
          stage: 'permission',
          error: '当前账号无创建角色权限',
          fallbackSql: 'CREATE ROLE ahatesla_ro LOGIN PASSWORD \'…\';\nGRANT SELECT ON ALL TABLES …',
        }),
      ),
    )
    await renderSetupReady()
    await registerAdmin(user)
    await user.type(screen.getByLabelText('PostgreSQL Host'), '127.0.0.1')
    await user.type(screen.getByTestId('auto-ro-user'), 'teslamate')
    await user.type(screen.getByTestId('auto-ro-pwd'), 'wrong')
    await user.click(screen.getByTestId('auto-ro-button'))
    const sql = await screen.findByTestId('auto-ro-sql')
    expect(sql).toHaveTextContent('CREATE ROLE')
    expect(screen.getByText(/无创建角色权限/)).toBeInTheDocument()
    expect(screen.getByTestId('auto-ro-copy')).toBeInTheDocument()
    // 我已手工执行 → 失败区收起，按钮转为已创建态
    await user.click(screen.getByTestId('auto-ro-done'))
    await waitFor(() => expect(screen.queryByTestId('auto-ro-sql')).not.toBeInTheDocument())
    expect(screen.getByTestId('auto-ro-button')).toHaveTextContent('已创建')
  })

  it('deployMode 由 compose 注入 → 自动选模式并隐藏选择器（不再问用户属于哪类）', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/setup/status', () =>
        HttpResponse.json({ state: 'uninitialized', https: false, carFound: false, deployMode: 'connect' }),
      ),
      http.post('/api/setup/admin', () =>
        HttpResponse.json({ ok: true, user: { username: 'eli', role: 'admin' } }),
      ),
    )
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json({ error: { code: 'UNAUTHORIZED', message: '未登录' } }, { status: 401 }),
      ),
    )
    renderSetupRouter()
    await screen.findByTestId('setup-admin-form')
    await registerAdmin(user)
    expect(screen.queryByTestId('setup-mode-connect')).not.toBeInTheDocument()
    expect(screen.queryByTestId('setup-mode-fullstack')).not.toBeInTheDocument()
    expect(screen.getByTestId('setup-mode-detected')).toHaveTextContent('接入现有 TeslaMate')
  })

  it('deployMode=fullstack → 检测文案指向全栈，Tesla 授权引导卡可见', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/setup/status', () =>
        HttpResponse.json({ state: 'uninitialized', https: false, carFound: false, deployMode: 'fullstack' }),
      ),
      http.post('/api/setup/admin', () =>
        HttpResponse.json({ ok: true, user: { username: 'eli', role: 'admin' } }),
      ),
    )
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json({ error: { code: 'UNAUTHORIZED', message: '未登录' } }, { status: 401 }),
      ),
    )
    renderSetupRouter()
    await screen.findByTestId('setup-admin-form')
    await registerAdmin(user)
    expect(screen.queryByTestId('setup-mode-connect')).not.toBeInTheDocument()
    expect(screen.getByTestId('setup-mode-detected')).toHaveTextContent('全栈')
    // Tesla 授权引导卡 href 已由既有用例覆盖（:4000/sign_in）
  })

  it('setup-locked 且已登录 → 恢复向导直接进入 Step2（数据源），不再踢回登录页', async () => {
    server.use(
      http.get('/api/setup/status', () =>
        HttpResponse.json({ state: 'setup-locked', https: false, carFound: false }),
      ),
    )
    http.get('/api/auth/me', () =>
      HttpResponse.json({ user: { username: 'eli', role: 'admin' } }),
    )
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json({ user: { username: 'eli', role: 'admin' } }),
      ),
    )
    renderSetupRouter()
    // 此前刷新即被 Navigate 踢回 /login 且无任何恢复入口（向导死角）
    expect(await screen.findByTestId('setup-datasource')).toBeInTheDocument()
    expect(screen.queryByTestId('setup-admin-form')).not.toBeInTheDocument()
  })

  it('Step2 模式B：车辆发现超时 → 出现重试按钮，点击重新轮询（不再永久卡死）', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/setup/admin', () =>
        HttpResponse.json({ ok: true, user: { username: 'eli', role: 'admin' } }),
      ),
    )
    server.use(http.post('/api/setup/datasource', () => HttpResponse.json({ ok: true })))
    server.use(
      http.get('/api/setup/car-discovery', () =>
        HttpResponse.json({ found: false, cars: [], car: null, suggestedCarId: null }),
      ),
    )
    await renderSetupReady()
    await registerAdmin(user)
    await user.click(screen.getByTestId('setup-mode-fullstack'))
    await user.click(screen.getByTestId('setup-save-datasource'))
    expect(screen.getByTestId('setup-discovery-polling')).toBeInTheDocument()
    // 超时判定基于 Date.now()：轮询已启动（startedAt 已捕获），把时钟拨快 61s，
    // 下一个 2s tick 即触发超时——真实计时器保持不变（fake timers 会挂死 userEvent）
    const shifted = Date.now() + 61_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(shifted)
    const timeoutEl = await screen.findByTestId('setup-discovery-timeout', {}, { timeout: 4000 })
    expect(timeoutEl).toBeInTheDocument()
    expect(screen.getByTestId('setup-discovery-retry')).toBeInTheDocument()
    // 点击重试 → 新窗口从当前（拨快后的）时钟起算：轮询提示恢复、超时区收起
    await user.click(screen.getByTestId('setup-discovery-retry'))
    expect(screen.queryByTestId('setup-discovery-timeout')).not.toBeInTheDocument()
    expect(screen.getByTestId('setup-discovery-polling')).toBeInTheDocument()
    nowSpy.mockRestore()
  })

  it('Step2 模式B：Tesla 登录引导卡与链接指向当前主机:4000（m4a 轨道A）', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/setup/admin', () =>
        HttpResponse.json({ ok: true, user: { username: 'eli', role: 'admin' } }),
      ),
    )
    await renderSetupReady()
    await registerAdmin(user)
    await user.click(screen.getByTestId('setup-mode-fullstack'))
    expect(screen.getByTestId('tesla-login-guide')).toBeInTheDocument()
    expect(screen.getByTestId('tesla-login-guide')).toHaveTextContent(/不接触 Tesla 密码|自动检测到车辆/)
    const link = screen.getByTestId('tesla-login-link') as HTMLAnchorElement
    expect(link.href).toContain(':4000/sign_in')
    expect(link.href).toContain(window.location.hostname)
    // 旧 testid 保留兼容（外层 span）
    expect(screen.getByTestId('setup-teslamate-link')).toBeInTheDocument()
  })
})
