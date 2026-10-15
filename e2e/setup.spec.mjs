// setup.spec.mjs — /setup 初始化向导 E2E（t_3f9fe52a，US-1~4 / P1 规格）。
//
// 实例管理：scripts/run-e2e.sh 以 shell 后台作业在 :18590 + 临时数据目录
// （AHA_DATA_DIR）拉起隔离实例，从零走完向导，不污染常驻 :18500 实例的
// state.json（scripts/e2e-reset-password.mjs 机制保持不变）。
// 覆盖：模式 A（存量接入，指向真实只读库 127.0.0.1:15432）全流程、校验失败
// 分支（错误端口）、/setup 注册锁死行为（AC-1.4）、模式 B 语义（AC-4.1/4.3）。
// 注：本项目 Playwright 1.64 的 page 无 getByLabelText，统一 getByRole("textbox")。
import { test, expect } from "playwright/test";

const BASE = process.env.SETUP_E2E_BASE_URL || "http://127.0.0.1:18590";
const RO_PASSWORD = process.env.AHATESLA_E2E_DB_PASSWORD;
const BASE_RE = new RegExp(BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/(\\?|#|$)");
// 注意：本文件用例按序共享同一隔离实例的初始化状态（首用例注册管理员后 /setup 即
// 锁定），语义上是 serial；跑本文件请用 --workers=1 --retries=0（scripts/run-e2e.sh 已封装）。

test.beforeEach(async ({ page }) => {
  await page.context().clearCookies();
});

test("向导模式A：注册管理员 → 四级校验全绿 → 车辆确认 → 跳过两步 → 进入仪表盘", async ({ page }) => {
  test.skip(!RO_PASSWORD, "需要 AHATESLA_E2E_DB_PASSWORD（真库只读账号密码）");

  // Step1 创建管理员（首位注册即管理员，AC-1.4）
  await page.goto(`${BASE}/setup`);
  await expect(page.getByTestId("setup-admin-form")).toBeVisible();
  await page.getByRole("textbox", { name: "用户名" }).fill("e2e-admin");
  await page.locator("#setup-password").fill("e2e-pass-123");
  await page.locator("#setup-confirm").fill("e2e-pass-123");
  await page.getByTestId("setup-admin-submit").click();

  // Step2 模式A：填真实只读连接
  await expect(page.getByTestId("setup-datasource")).toBeVisible({ timeout: 8000 });
  await page.getByTestId("setup-mode-connect").click();
  await page.getByRole("textbox", { name: "PostgreSQL Host" }).fill("127.0.0.1");
  await page.getByRole("textbox", { name: "端口" }).fill("15432");
  await page.getByRole("textbox", { name: "库名" }).fill("teslamate");
  await page.getByRole("textbox", { name: "用户名（只读账号）" }).fill("ahatesla_ro");
  await page.locator("#setup-pwd").fill(RO_PASSWORD);
  await page.getByTestId("setup-test-connection").click();

  // 四级校验全绿（含只读元数据探测 AC-2.4 + 车辆发现 AC-2.3）
  for (const name of ["reachability", "auth", "readonly", "cars"]) {
    await expect(page.getByTestId(`setup-check-${name}`)).toHaveAttribute("data-ok", "true", { timeout: 15000 });
  }
  await expect(page.getByTestId("setup-verified")).toBeVisible();

  // 保存 → 下一步
  await page.getByTestId("setup-save-datasource").click();
  await expect(page.getByTestId("setup-save-datasource")).toBeDisabled(); // 已保存
  await page.getByTestId("setup-next").click();

  // Step3 跳过 → Step4 跳过 → 仪表盘
  await expect(page.getByTestId("setup-ledger")).toBeVisible();
  await page.getByTestId("setup-skip-ledger").click();
  await expect(page.getByTestId("setup-http-warning")).toBeVisible(); // http 环境 → Web Push 降级提示（AC-11.0）
  await page.getByTestId("setup-finish").click();
  await page.waitForURL(BASE_RE, { timeout: 8000 });
}, 60_000);

test("向导校验失败分支：错误端口 → reachability/auth 失败且不允许保存", async ({ page }) => {
  test.skip(!RO_PASSWORD, "需要 AHATESLA_E2E_DB_PASSWORD");

  // 上一用例已注册管理员 → 登录后走 API 失败分支（向导 UI 的失败渲染由组件测试覆盖）
  await page.goto(`${BASE}/login`);
  await page.getByRole("textbox", { name: "用户名" }).fill("e2e-admin");
  await page.getByRole("textbox", { name: "密码" }).fill("e2e-pass-123");
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await page.waitForURL(BASE_RE, { timeout: 8000 });

  const res = await page.evaluate(async () => {
    const r = await fetch("/api/setup/test-connection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ host: "127.0.0.1", port: 15999, database: "teslamate", user: "ahatesla_ro", password: "whatever" })
    });
    return r.json();
  });
  expect(res.ok).toBe(false);
  expect(res.steps.find((s) => s.name === "reachability").ok).toBe(false);
  expect(res.steps.find((s) => s.name === "auth").ok).toBe(false);
}, 30_000);

test("/setup 锁死行为：管理员已注册后 status 非 uninitialized 且再注册 403（AC-1.4）", async ({ request }) => {
  const status = await (await request.get(`${BASE}/api/setup/status`)).json();
  expect(status.state === "setup-locked" || status.state === "ready").toBe(true);
  const res = await request.post(`${BASE}/api/setup/admin`, {
    data: { username: "intruder", password: "intruder-pass-123" }
  });
  expect(res.status()).toBe(403);
  expect((await res.json()).error.code).toBe("setup_locked");
});

test("向导模式B：fullstack 数据源 + 车辆发现可用（AC-4.1/4.3）", async ({ page }) => {
  test.skip(!RO_PASSWORD, "需要 AHATESLA_E2E_DB_PASSWORD");
  await page.goto(`${BASE}/login`);
  await page.getByRole("textbox", { name: "用户名" }).fill("e2e-admin");
  await page.getByRole("textbox", { name: "密码" }).fill("e2e-pass-123");
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await page.waitForURL(BASE_RE, { timeout: 8000 });

  // fullstack 模式数据源可保存 + 车辆发现轮询端点工作（模式 B 的 UI 元素由组件测试覆盖）
  const result = await page.evaluate(async () => {
    const save = await fetch("/api/setup/datasource", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ mode: "fullstack" })
    });
    const discovery = await fetch("/api/setup/car-discovery", { credentials: "include" });
    return { saveOk: save.ok, discovery: await discovery.json() };
  });
  expect(result.saveOk).toBe(true);
  expect(result.discovery.found).toBe(true);
  expect(Array.isArray(result.discovery.cars)).toBe(true);
}, 30_000);
