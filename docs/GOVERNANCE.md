# 架构治理 — 进度 / 任务池 / 决策索引

> 目标：系统性降熵、归一、解耦，使本库成为高度规整、适合大量 Agent 并行开发的工程系统。
> 方法：每批 = 熵项确认 → 方案比选 → 迁移全部调用方 → 删除旧实现 → 全门禁验证 → 独立 commit。
> 运行分支：`refactor/arch-governance`（隔离 worktree）。ADR 见 `docs/adr/`。

## 门禁（每批必绿）

- `cd server && npm test`（node --test）
- `cd web && npx tsc --noEmit && npm test && npm run build`
- `node scripts/check-arch.mjs`（模块边界，ADR-0001）
- 合入 main 前：`bash scripts/run-e2e.sh`（连真实只读库的隔离实例）

## 基线（2026-11-28 起点 dfa89d3）

server 276/276 ✔ · web tsc+vitest+build ✔ · server 内部 import 边 133 条，core→api 违规 0。

## 架构地图（B5 后现状）

```
server/src
├─ index.mjs (430)  组合根：装配 db/monitor/notifier/路由/巡检/静态托管 + 生命周期；
│                   路由表一次注册，MQTT 经懒视图注入（桥接连上自动生效，无重注册）
├─ api/             HTTP 层（一处一域，只做编解码与调用组装）
│   http-kit(手写路由) · jwt · auth(-routes) · car-scope · static ·
│   trips · charging · dashboard · dashboard-extra(timeline/heatmap) ·
│   settings · system(+health-lite) · ledger · export · maintenance ·
│   setup · push(六渠道配置+订阅+矩阵+报告) · ai
└─ core/            领域层（不 import api/；ADR-0001 机器强制）
    state(→store SQLite) · db(pg 只读池) · teslamate-queries(全部 TM SQL) ·
    trip-views(行程视图装配) · pricing-ledger(计价原语) · fifo-ledger(回放+缓存) ·
    pricing-options · trip-monitor · monitor-persistence · push-dispatch(投递管线) ·
    patrols(三巡检) · maintenance(保养判定) · push-channels(六渠道+矩阵) ·
    report-engine · event-enrichment · alerts · health · battery-health ·
    demo-data · feishu · ai-copywriter · address-label · geo-geocode ·
    secret-box · events · util(含 lttbDownsample)
web/src
├─ api/client.ts    全部 REST 端点唯一封装（401→refresh→重试；金额字段 cost/fmtMoney）
├─ pages/           11 页（内部按卡片/分区函数组织）
├─ components/      跨页复用组件；settings/ 分区组件
├─ contexts/        Auth · Car · Theme（+ I18nProvider）
└── types/index.ts  API 契约类型（与 docs/API_CONTRACT.md 对应）
```

### 依赖规则（ADR-0001，`node scripts/check-arch.mjs` 强制）

- server：`api/* → core/*` 允许；`core/* → api/*` 禁止；core 无环。
- web：pages 互引禁止；components/layouts 不 import pages；contexts 不碰 pages/components。
- docs/API_CONTRACT.md 是接口唯一真相源；改接口先改它。

## 熵清单处置状态

| ID | 处置 | 批次/结论 |
|---|---|---|
| S1 车辆清单 3 套实现 | ✅ 收敛 getCars 唯一权威 | B1 |
| S2 月份窗口手写重复 | ✅ 复用 util.monthWindowIso/expr | B1 |
| S3 死代码（auth/bootstrap/statePath 等） | ✅ 删除 | B1/B7 |
| S4 v1 推送默认污染全新实例矩阵 | ✅ 修默认 + 回归测试锁定 | B2 |
| S5 computeTripViews 住错层 | ✅ 迁 core/trip-views | B3 |
| S6 路由模块跨域混杂 | ✅ settings/system 分家、飞书并入 push | B4 |
| S7 index.mjs 组合根混领域逻辑 | ✅ 五模块迁出 + MQTT 懒视图 | B5 |
| S8 state 兼容层 v1 残留 | ✅（随 S4） | B2 |
| S9 根 package.json 陈旧 | ✅ | B0 |
| E1 无边界防回归 | ✅ check-arch.mjs + CI arch job | B0 |
| E2 tsbuildinfo 被跟踪 | ✅ untrack+ignore | B0 |
| W1 client.ts 死/重条目 | ✅ | B0 |
| W2 costCny 漂移（契约 B1 未落地） | ✅ 全栈改名 cost/fmtMoney；快照 costCny 为不可变历史格式（契约注明） | B6 |
| W3 巨页 Settings/Setup/Push | ⏸️ 判定不改：三页内部已按分区函数/卡片组件组织（PushPage 六渠道卡 + ChannelCardHeader、SettingsPage 分区 + CollapseCard），无复用诉求的再拆分属无收益搬迁；待某分区出现第二调用方或成为并行热点时再抽 |
| D2 ARCHITECTURE.md 过时 | ✅ 本文件地图 + ARCHITECTURE.md 刷新 | B7 |
| — 模块导出面（19 个仅内部使用的 export） | ✅ 收回模块私有；index 硬编码 monitor_state_v1 改用常量 | B7 |

遗留观察（低优先，不阻塞）：
- demo 模式下 report scheduler setTimeout 溢出告警（合成日期遥远；真实实例无此现象）
- SettingsPage EVENT_MATRIX_DEFAULTS 与 server defaultMatrix 语义重复（UI 预载占位；GET 恒返回生效矩阵，无漂移风险）

## 进度日志

- **B0** ✅ 治理脚手架：GOVERNANCE + ADR-0001 + check-arch.mjs(CI) + E2/W1/S9 清理。
- **B1** ✅ server 去重：车辆清单归一 / 月份窗口复用 / 死代码删除（276→274 测试）。
- **B2** ✅ 全新实例默认矩阵修复 + v1 规则死 API 删除（含生产处理器测试重指向）。
- **B3** ✅ computeTripViews → core/trip-views；lttbDownsample → core/util；trips-routes 796→623 行。
- **B4** ✅ 路由一处一域：settings-routes/system-routes 新建、channel-routes 删除（顺带铲除 push-routes 内同名死 stub）。
- **B5** ✅ 组合根瘦身：push-dispatch/patrols/maintenance/monitor-persistence/static 五模块迁出；MQTT 懒视图替代重注册 hack；index 650→430 行；冒烟通过。
- **B6** ✅ costCny→cost 全栈对齐契约 B1（trips/charging/stats/dashboard/overview + web 全部 + fmtMoney）。
- **B7** ✅ 导出面收缩（19 项私有化）+ 文档收口（本文件 + ARCHITECTURE.md）。
- 待终验：`bash scripts/run-e2e.sh` 全链路 → 合入 main。
