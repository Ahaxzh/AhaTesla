import { chromium } from 'playwright/test'
const base = 'http://127.0.0.1:18597'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
await page.goto(`${base}/login`)
await page.getByRole('textbox', { name: '用户名' }).fill('admin')
await page.getByRole('textbox', { name: '密码' }).fill('triptest123')
await page.getByRole('button', { name: /登\s*录/ }).click()
await page.waitForURL(/dashboard|^\S+\/$/, { timeout: 15000 })
await page.goto(`${base}/trips`)
await page.waitForSelector("[data-testid='trip-item']", { timeout: 20000 })
await page.waitForTimeout(9000) // 等 route-summary
const title = await page.locator('text=轨迹汇总').isVisible().catch(() => false)
const canvas = await page.locator("[data-testid='route-map'] canvas").count()
const label = await page.locator('text=/绘制/').textContent().catch(() => '')
console.log('轨迹汇总:', title, '| canvas:', canvas, '| 标注:', label?.trim())
await page.screenshot({ path: '/tmp/trips-seg.png', fullPage: false })
await browser.close()
