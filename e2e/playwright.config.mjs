import { defineConfig } from "playwright/test";

export default defineConfig({
  // 明确指向 e2e 目录本身，使在仓库根 (`npm run test:e2e`) 或 e2e/ 内执行
  // 都只会加载 e2e/*.spec.mjs，而不会把 web/tests/*.test.tsx（vitest）当成用例。
  testDir: import.meta.dirname,
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: "http://127.0.0.1:18500",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  projects: [
    { name: "mobile", use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } }
  ],
  reporter: [["list"]]
});
