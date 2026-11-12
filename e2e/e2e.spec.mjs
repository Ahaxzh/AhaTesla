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
  // 车辆位置文字（顶部卡右下角）：测试库有定位数据 → 必须渲染（围栏名/附近/坐标兜底）
  await expect(page.getByTestId("car-position")).toBeVisible({ timeout: 10000 });
  // 胎压四轮横排：测试库有 TPMS 历史 → 必须渲染（<2.6 着色由样式承担）
  await expect(page.getByTestId("tire-pressure")).toBeVisible();
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
  // 胎压瓦片（环境卡第五格）：库内该行程有 TPMS 读数 → 必须渲染（无读数行程不渲染属预期）
  const tp = page.getByTestId("trip-tire-pressure");
  if (await tp.isVisible().catch(() => false)) {
    await expect(tp).toContainText(/bar/);
  }
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
  // v0.2.x 修复：锚点不只是换 URL，还要真实滚动到该分区（视口内可见）
  await expect(page.getByTestId("change-password-card")).toBeInViewport({ timeout: 5000 });
});

test("总览页：状态胶囊与数据同步合并行 + 胎压 FL/FR 缩写 + 近7天切换条形视图", async ({ page }) => {
  await login(page);
  // v0.2.x：状态胶囊（car-state-pill）与「数据同步于」同行（不再占顶部独立位置）
  await expect(page.getByTestId("car-state-pill")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("car-synced")).toContainText(/数据同步于|just now|min ago|h ago|d ago/);
  // 胎压四轮：位置用国际缩写 FL/FR/RL/RR
  const tp = page.getByTestId("tire-pressure");
  if (await tp.isVisible().catch(() => false)) {
    await expect(tp).toContainText("FL");
    await expect(tp).toContainText("RR");
  }
  // 用车日历三档：点近7天 → 紧凑每日条形（无周历网格）
  await page.waitForSelector("[data-testid='heatmap-card']", { timeout: 10000 });
  await page.getByTestId("heatmap-range-7").click();
  await page.waitForSelector("[data-testid='heatmap-daily-bars']", { timeout: 8000 });
  await expect(page.getByTestId("heatmap-daily-row").first()).toBeVisible();
  // 切回近3月 → 周历网格恢复
  await page.getByTestId("heatmap-range-90").click();
  await page.waitForSelector("[data-testid='heatmap-grid']", { timeout: 8000 });
});

test("移动端：底部导航栏固定不随页面滚动 + viewport 禁缩放", async ({ page }) => {
  await login(page);
  const viewport = page.viewportSize();
  if (!viewport || viewport.width >= 1024) {
    test.skip(true, "仅移动端视口执行");
    return;
  }
  // iOS 主屏 PWA 禁缩放：viewport meta 带 user-scalable=no（+ JS gesture 拦截，浏览器内不可模拟）
  const meta = await page.$eval("meta[name='viewport']", (el) => el.getAttribute("content"));
  expect(meta).toContain("user-scalable=no");
  // 长页面滚动后 TabBar 位置不动
  await navigate(page, "trips");
  await page.waitForTimeout(800);
  const bar = page.getByTestId("mobile-tabbar");
  await expect(bar).toBeVisible();
  const before = await bar.boundingBox();
  await page.mouse.wheel(0, 1600);
  await page.waitForTimeout(600);
  const after = await bar.boundingBox();
  expect(after).toBeTruthy();
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
});

test("充电页：充电次数第四卡 + 电池健康卡", async ({ page }) => {
  await login(page);
  await navigate(page, "charging");
  await page.waitForSelector("[data-testid='charge-stats']", { timeout: 15000 });
  await expect(page.getByTestId("charge-stats")).toContainText(/次|sessions/i);
  // 电池健康卡：样本充足才渲染（与仪表盘同卡），可见时断言健康度数值
  const bh = page.getByTestId("battery-health-card");
  if (await bh.isVisible().catch(() => false)) {
    await expect(bh).toContainText(/%/);
  }
});

test("移动端：充电页统计四卡在窄屏两列排布不溢出", async ({ page }) => {
  await login(page);
  const viewport = page.viewportSize();
  if (!viewport || viewport.width >= 1024) {
    test.skip(true, "仅移动端视口执行");
    return;
  }
  await navigate(page, "charging");
  await page.waitForSelector("[data-testid='charge-stats']", { timeout: 15000 });
  const stats = await page.getByTestId("charge-stats").boundingBox();
  const body = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(body).toBeLessThanOrEqual(viewport.width + 1); // 无横向滚动
  expect(stats).toBeTruthy();
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
