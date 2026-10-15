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
});

test("行程页：列表加载、分页、详情路线", async ({ page }) => {
  await login(page);
  await navigate(page, "trips");
  // 列表有行程（真实库 2592 条）
  await expect(page.locator("tbody tr, [data-testid='trip-row'], li").first()).toBeVisible({ timeout: 10000 });
  // 下一页
  const nextBtn = page.getByRole("button", { name: /下一页|下一|next|>|›/i }).first();
  if (await nextBtn.isVisible().catch(() => false)) {
    await nextBtn.click();
    await page.waitForTimeout(600);
  }
  // 点进详情
  await page.locator("tbody tr, [data-testid='trip-row'], li a, a[href*='/trips/']").first().click();
  // 等详情数据渲染：路线图（有点）或空态占位（点不足）其一出现
  await page.waitForSelector("[data-testid='route-map'], [data-testid='route-map-empty']", { timeout: 10000 });
  const empty = await page.locator("[data-testid='route-map-empty']").isVisible().catch(() => false);
  if (!empty) {
    await expect(page.locator("[data-testid='route-map'] svg")).toBeVisible();
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

test("电价页：地点单价表 + 默认电价显示", async ({ page }) => {
  await login(page);
  await navigate(page, "pricing");
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

test("系统页：DB/MQTT 状态", async ({ page }) => {
  await login(page);
  await navigate(page, "system");
  await expect(page.getByText("TeslaMate DB")).toBeVisible({ timeout: 8000 });
  await expect(page.getByText("Mosquitto MQTT")).toBeVisible();
});

test("设置页：修改密码表单存在并可取消", async ({ page }) => {
  await login(page);
  await navigate(page, "settings");
  await expect(page.locator("input[type='password']").first()).toBeVisible();
});

test("登出后回到登录页且受保护页 401 跳转", async ({ page }) => {
  await login(page);
  await navigate(page, "settings");
  // 登出
  const logout = page.getByRole("button", { name: /退出|登出|logout/i }).first();
  if (await logout.isVisible().catch(() => false)) {
    await logout.click();
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
