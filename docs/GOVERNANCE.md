# 架构治理 — 进度 / 任务池 / 决策索引

> 目标：系统性降熵、归一、解耦，使本库成为高度规整、适合大量 Agent 并行开发的工程系统。
> 方法：每批 = 熵项确认 → 方案比选 → 迁移全部调用方 → 删除旧实现 → 全门禁验证 → 独立 commit。
> 运行分支：`refactor/arch-governance`（隔离 worktree）。ADR 见 `docs/adr/`。

## 门禁（每批必绿）

- `cd server && npm test`（node --test，276+ 用例）
- `cd web && npx tsc --noEmit && npm test && npm run build`
- 合入 main 前：`bash scripts/run-e2e.sh`（连真实只读库的隔离实例）

## 基线（2026-11-28，dfa89d3）

server 276/276 ✔ · web tsc+vitest+build ✔ · server 内部 import 边 133 条，core→api 违规 0 条。

## 架构地图（现状）

```
server/src
├─ index.mjs        组合根：bootstrap → db → monitor → notifier → 路由 → 巡检/静态托管
├─ api/             HTTP 层（http-kit 手写路由；每域一个 *-routes.mjs 工厂）
│   auth+auth-routes+jwt · car-scope · trips · charging · dashboard(+extra) ·
│   ledger · export · maintenance · setup · pricing · channel · push · ai
├─ core/            领域层（不 import api/，依赖方向 api→core 单向）
│   state(→store SQLite) · db(pg 只读池) · teslamate-queries(全部 TM SQL) ·
│   pricing-ledger(计价原语) · fifo-ledger(全量回放+缓存) · pricing-options(选项装配) ·
│   trip-monitor · push-channels(六渠道+矩阵) · report-engine · event-enrichment ·
│   alerts · health · battery-health · demo-data · feishu · ai-copywriter ·
│   address-label · geo-geocode · secret-box · events · util
web/src
├─ api/client.ts    全部 REST 端点唯一封装（401→refresh→重试）
├─ pages/           11 页（路由级 lazy chunk；App.tsx 空闲预载）
├─ components/      跨页复用组件；settings/ 分区组件
├─ contexts/        Auth · Car · Theme（+ I18nProvider）
└─ types/index.ts   API 契约类型（与 docs/API_CONTRACT.md 对应）
```

### 依赖规则（ADR-0001，机器可执行：scripts/check-arch.mjs）

- server：`api/* → core/*` 允许；`core/* → api/*` 禁止；`core` 内部禁止环。
- web：`pages → components/contexts/api/i18n` 允许；`pages → pages`、`components → pages` 禁止。
- docs/API_CONTRACT.md 是接口唯一真相源；改接口先改它。

## 熵清单（扫描产出，逐批消化）

| ID | 层 | 熵 | 批次 |
|---|---|---|---|
| S1 | server | 车辆清单 3 套实现（index.mjs 内联 SQL / car-scope.listCars / teslamate-queries.getCars），demo-data 被迫逐个特判 | B1 |
| S2 | server | chargingRangeFilter 手写月份→时区窗口+ts 字符串拼接，重复 util.monthWindowIso/expr | B1 |
| S3 | server | 死代码：generateInitialPassword(仅自测)、jwtSecret(0 调用)、bootstrap()(仅测试兼容) | B1 |
| S4 | server | DEFAULT_STATE.pushRules 残留 v1 布尔默认 → 全新实例经 v1 兼容路径得「内容事件全渠道开」，违反契约默认矩阵 | B2 |
| S5 | server | computeTripViews（领域视图逻辑）从 api/trips-routes 导出、注入 core/report-engine —— 领域逻辑住错层 | B3 |
| S6 | server | 路由模块内聚：settings/health-lite 住 dashboard-extra-routes；渠道域被 channel-routes 与 push-routes 任意切分 | B4 |
| S7 | server | index.mjs 650 行组合根混入领域逻辑（dispatchPush 富化管线、三巡检、MQTT 重注册 hack） | B5 |
| S8 | server | state.mjs 兼容层带 v1 推送默认（见 S4）与全量同步语义 | B2 |
| S9 | root | package.json 陈旧字段（main/index.js 不存在、test 脚本损坏、type:commonjs 误导） | B0 |
| E2 | repo | web/tsconfig.tsbuildinfo 构建产物被跟踪，每次 build 产生脏 diff | B0 |
| W1 | web | client.ts 死/重条目：changePassword、channels(=channelStatus)、pushRules/setPushRules v1、PushRules 类型 | B0 |
| W2 | 全栈 | costCny 命名漂移：契约 §9 B1 声称已改 cost，实际 server/web 全量仍是 costCny（含 fmtCny） | B6 |
| W3 | web | 巨页：SettingsPage 941 / SetupPage 805 / PushPage 670 行 | B7 |
| D2 | docs | ARCHITECTURE.md 局部过时（scripts 职责、模块清单） | B8 |
| E1 | CI | 无依赖方向/边界防回归检查 | B0 |

## 进度日志

- **B0（进行中）** 治理脚手架：本文件 + ADR-0001 + check-arch.mjs + E2/W1/S9 清理。
- 基线全绿；worktree `AhaTesla-gov` 建立。
