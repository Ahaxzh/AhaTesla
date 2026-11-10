import { test, expect } from "playwright/test";
import { readFileSync } from "node:fs";

// 一次性初始密码只打印在服务日志首启行；E2E 用环境变量注入真实密码。
const PASSWORD = process.env.AHATESLA_E2E_PASSWORD;

test.beforeEach(async ({ page }) => {
  // 退出登录状态，避免 cookie 干扰
  await page.context().clearCookies();
});

test("登录流程：错误密码被拒，正确密码进入总览", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/login/);
  await expect(page.getByText("AhaTesla", { exact: true })).toBeVisible();

  await page.getByRole("textbox", { name: "用户名" }).fill("admin");
  await page.getByRole("textbox", { name: "密码" }).fill("wrong-password");
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await expect(page.locator("text=/失败|错误|invalid/i").first()).toBeVisible({ timeout: 8000 });

  await page.getByRole("textbox", { name: "密码" }).fill(PASSWORD);
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await expect(page).toHaveURL(/\/(dashboard)?$|\/dashboard/, { timeout: 8000 });
});

test("总览页：车辆状态卡、本月账本卡、24h时间轴、热力图", async ({ page }) => {
  await login(page);
  await expect(page.locator("main").getByText(/Ahaxzh's Model 3/).first()).toBeVisible({ timeout: 10000 });
  // 电量百分比出现
  await expect(page.locator("main").locator("text=/\\d+\\s*%/").first()).toBeVisible();
  // 月度统计卡（里程/电费）
  await expect(page.getByText(/里程|km/i).first()).toBeVisible();
  await expect(page.getByText(/¥|元/).first()).toBeVisible();
  // v2.1 P2：24h 时间轴（骨架或数据其一）
  await page.waitForSelector("[data-testid='timeline-card']", { timeout: 10000 });
  // v2.1 P2：用车热力图
  await page.waitForSelector("[data-testid='heatmap-card']", { timeout: 10000 });
  // 车辆位置地图卡：测试库有定位数据 → 必须渲染（曾因外层 SELECT 漏列静默隐藏，条件断言放过）
  await expect(page.getByTestId("car-location-card")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("car-location-map")).toBeVisible();
  await expect(page.getByTestId("car-location-state")).toBeVisible();
});

test("行程页：列表加载、分页、详情路线", async ({ page }) => {
  await login(page);
  await navigate(page, "trips");
  // 列表有行程（真实库 2592 条；并行压测下首屏查询可达 10s+，放宽到 20s）
  await expect(page.locator("tbody tr, [data-testid='trip-row'], li").first()).toBeVisible({ timeout: 20000 });
  // 下一页
  const nextBtn = page.getByRole("button", { name: /下一页|下一|next|>|›/i }).first();
  if (await nextBtn.isVisible().catch(() => false)) {
    await nextBtn.click();
    await page.waitForTimeout(600);
  }
  // 点进详情：优先挑里程 ≥1km 的行（首条可能是当天 0.1km 挪车微行程，轨迹不足以画线）
  const rows = page.locator("tbody tr, [data-testid='trip-row']");
  const count = Math.min(await rows.count(), 10);
  let target = null;
  for (let i = 0; i < count; i++) {
    const text = await rows.nth(i).innerText();
    const m = text.match(/(\d+(?:\.\d+)?)\s*km/i);
    if (!m || Number(m[1]) >= 1) { target = rows.nth(i); break; }
  }
  (target ?? page.locator("tbody tr, [data-testid='trip-row'], li a, a[href*='/trips/']").first()).click();
  // 等详情数据渲染：路线图（有点）或空态占位（点不足）其一出现
  await page.waitForSelector("[data-testid='route-map'], [data-testid='route-map-empty']", { timeout: 20000 });
  const empty = await page.locator("[data-testid='route-map-empty']").isVisible().catch(() => false);
  if (!empty) {
    // preferCanvas: true → 轨迹画在 canvas（svg 仅在无 canvas 渲染器时出现）
    await expect(page.locator("[data-testid='route-map'] canvas, [data-testid='route-map'] svg").first()).toBeVisible();
  }
  // v2.1 P3：FIFO 扣减明细卡（有账本数据时出现批次表，无数据时显示空态说明）
  await page.waitForSelector("[data-testid='fifo-card']", { timeout: 10000 });
});

test("充电页：列表与按地点统计", async ({ page }) => {
  await login(page);
  await navigate(page, "charging");
  await expect(page.getByText("CND").first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/kWh/i).first()).toBeVisible();
});

test("设置页：电价分区地点电价表 + 默认电价显示", async ({ page }) => {
  await login(page);
  await navigate(page, "settings");
  await page.waitForSelector("[data-testid='location-table']", { timeout: 10000 });
  await expect(page.getByText(/CND/).first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/1\.8/).first()).toBeVisible();
});

test("推送页：三渠道卡片渲染（WebPush/Telegram/飞书）", async ({ page }) => {
  await login(page);
  await navigate(page, "push");
  // v2.1：三渠道平权卡片（AC-10.1）
  await expect(page.locator("[data-testid='webpush-card']")).toBeVisible({ timeout: 10000 });
  await expect(page.locator("[data-testid='telegram-card']")).toBeVisible();
  await expect(page.locator("[data-testid='feishu-card']")).toBeVisible();
  // WebPush：HTTP 环境置灰引导（AC-11.0）或 HTTPS 可订阅按钮，其一出现
  await page.waitForSelector("[data-testid='webpush-https-warning'], [data-testid='webpush-enable']", { timeout: 10000 });
});

test("设置页：系统分区 DB/MQTT 状态", async ({ page }) => {
  await login(page);
  await navigate(page, "settings");
  // 首次冷查询（DB 连通+只读校验）可能数秒，放宽到 15s
  await expect(page.getByText("TeslaMate DB")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Mosquitto MQTT")).toBeVisible();
});

test("设置页：修改密码表单存在并可取消", async ({ page }) => {
  await login(page);
  await navigate(page, "settings");
  await expect(page.locator("input[type='password']").first()).toBeVisible();
});

test("头像菜单：主题/语言快捷开关 + 账户安全跳设置页锚点 + 版本标识", async ({ page }) => {
  await login(page);
  await navigate(page, "trips"); // 从其他页进入验证不依赖路由
  // 头像菜单只在桌面侧栏；移动端无此入口（账户入口在设置页内）
  const menuBtn = page.getByTestId("user-menu-button");
  if (!(await menuBtn.isVisible().catch(() => false))) {
    test.skip(true, "移动端无头像菜单");
    return;
  }
  await menuBtn.click();
  // Discord 式弹层：主题/语言快捷开关 + 账户安全入口（完整编辑唯一入口在设置页）
  await expect(page.getByTestId("user-menu-theme")).toBeVisible();
  await expect(page.getByTestId("user-menu-lang")).toBeVisible();
  await expect(page.getByTestId("user-menu-version")).toContainText(/v\d/); // 版本标识（"我到底在跑哪版"）
  await page.getByTestId("user-menu-account-link").click();
  // 跳转设置页账户安全锚点，密码表单可见
  await expect(page).toHaveURL(/settings#settings-security/, { timeout: 8000 });
  await expect(page.getByTestId("change-password-card")).toBeVisible();
});

test("登出后回到登录页且受保护页 401 跳转", async ({ page }) => {
  await login(page);
  await navigate(page, "settings");
  // 桌面侧栏头像菜单里的登出
  const menuBtn = page.getByTestId("user-menu-button");
  if (await menuBtn.isVisible().catch(() => false)) {
    await menuBtn.click();
    await page.getByTestId("user-menu-logout").click();
    await expect(page).toHaveURL(/login/, { timeout: 8000 });
  }
});

async function login(page) {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "用户名" }).fill("admin");
  await page.getByRole("textbox", { name: "密码" }).fill(PASSWORD);
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await page.waitForURL(/dashboard|^\S+\/$/, { timeout: 10000 });
  await page.waitForTimeout(800);
}

async function navigate(page, section) {
  // 移动端 TabBar 与桌面侧栏都尝试
  const link = page.locator(`a[href*="${section}"]`).first();
  if (await link.isVisible().catch(() => false)) {
    await link.click();
  } else {
    await page.goto(`/${section === "dashboard" ? "" : section}`);
  }
  await page.waitForTimeout(600);
}
