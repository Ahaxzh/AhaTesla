> 🗄️ **历史归档**（2026-11-10 移入）：快照类文档，现状以代码、README 与 docs/API_CONTRACT.md 为准——勿按此文件里的 checkbox/差距清单理解当前功能。

# PM 静态审计报告 — 现有骨架 vs PRD v1.3

**审计人**：Eli（PM）· **日期**：2026-10-14（两轮）· **方法**：逐行人工审读核心文件（无终端执行环境，静态分析）
**范围**：`server/src/core/teslamate-queries.mjs`（279 行）、`server/src/core/pricing-ledger.mjs`（208 行）、`server/src/core/trip-monitor.mjs`（257 行）
**发现总计**：✅ 已符合 3 项 · 🔴 新发现 bug 2 个（B1 car_id 硬编码、B2 充电侧水线缺失）· 🟡 隐患 3 个（B3 优先级、B4 事件未接线、B1' 前端 CNY 命名面）· 📋 差距 11 条（G1-G11，对应既有卡）

---

## 一、好消息：v1.3 的两条最关键技术修正，现有代码已经做对了

1. **行程耗电公式（AC-6.3）✅ 已符合**：`listDrivesSql`/`getDriveByIdSql` 已经用 `greatest(start_ideal_range_km − end_ideal_range_km, 0)` + `greatest(rated...)` 双列 + `cars.efficiency` 计算（queries.mjs L146-147），`driveEnergyKwh`（pricing-ledger L96-106）还做了 efficiency 单位归一（Wh/km vs kWh/km，>1 除以 1000）——**代码从未假设 power_consumed_kwh 存在**。v1.3 评审担心的坑实际不存在。
2. **FIFO 批次公式（AC-7.2）✅ 部分已符合**：`batchesFromChargingSessions`（pricing-ledger L56-77）批次电量就是 `charge_energy_added`，单价 = 实付 ÷ energy（经 priceChargingSession 的 pricePerUnit 计算）——**含充损闭合的正确方向已经在**。缺的是：无驻车损耗、无分时电价、无本地补录层。

## 二、🔴 新发现的真 Bug（v1.3 评审也没抓到）

**`getDrivingState` 硬编码 `s.car_id = 1`**（queries.mjs L85）：
```sql
SELECT s.state FROM states s WHERE s.car_id = 1 AND s.end_date IS NULL
```
任何 car_id ≠ 1 的库（TeslaMate 重装过、多车、导入数据后 id 从非 1 开始），车辆状态判定会读到错误车辆的 states 或读不到。修复：参数化 car_id 并沿用 AC-2.3 选定的主绑定车辆。**应并入 t_3f9fe52a（向导卡）的 car_id 绑定改造**。

## 三、确认存在的差距（与既有任务卡对齐，无需新建卡）

| # | 差距 | 位置 | 对应卡 |
|---|---|---|---|
| G1 | `costCny`/`unit_price_cny_per_kwh`/`amount_cny` 命名遍布（契约 B1 BREAKING） | pricing-ledger 全文 | t_d9fb43bd |
| G2 | 文件头"Algorithm semantics inherited from tesla-butler"（L13-15, L108）——上游无 LICENSE，衍生风险实锤 | pricing-ledger L13-15/L108 | t_f6ebddf1 重写卡 |
| G3 | 无驻车损耗逻辑（AC-7.5 事件驱动扣减完全缺失） | pricing-ledger | t_d9fb43bd |
| G4 | 无分时电价（geofence 只取 cost_per_unit 单值） | queries getGeofences L217-226 | t_d9fb43bd |
| G5 | 无本地补录层（charge_cost_overrides 四层回退第①层缺失） | priceChargingSession 三层 | t_d9fb43bd |
| G6 | 无历史重算（defaultRateHistory 已有按时间生效雏形 L82-94，可扩展） | pricing-ledger | t_d9fb43bd |
| G7 | 降采样是等距抽样非 LTTB（downsamplePoints L195-201） | queries | t_9a126806 |
| G8 | getCarSnapshot `LIMIT 1` 按.display_priority——无用户选车概念 | queries L30-31 | t_3f9fe52a |
| G9 | listChargingForStats 全表载入内存（3 年存量 ≈ 数千行，v1 可接受；10 万行规模需分页重算） | queries L257-269 | M1 观察项 |
| G10 | states 表被使用（L83-87）——TeslaMate states 表在部分版本/Fleet API 模式下可能稀疏，Live 验证时确认覆盖率 | queries | t_3689fa50 |

## 四、值得表扬的现有实现（重写时保留的设计）

- **UTC 处理**：naive UTC 时间戳 + `AT TIME ZONE 'UTC'` 比较（queries L1-4 注释明确）——时区正确性已想清楚
- **僵尸充电会话过滤**：30 分钟 recency 窗口排除僵尸 charging_process（L36-37 注释）——边界意识好
- **allocation slices 明细**：每次扣减记 slice（batch_id/电量/单价/金额）——正好是 P3 FIFO 明细卡的现成数据结构
- **cost_cny_precise 高精度内部值**（L194）：round(cost,10) 内部 + round(,2) 展示——与 §7.3 精度规范一致
- **efficiency 单位归一**（L97-100）：防 Wh/km 旧数据坑

## 五、trip-monitor.mjs 审读补充（2026-10-14 第二轮审计）
**好消息**：v1.3 要求的冷启动水线，**drives 侧已天然实现**——`reconcile()` 首次调用时 `last_drive_id = max(completed ids)`（L81-84），水线前的历史行程会被 `id <= last_drive_id` 跳过，不产生事件。AC-12.1b 的行程侧已被骨架满足（设计层面）。

**新发现问题**：

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| B2 | **charging 侧无水线**：`last_charging_id` 初始为 0，首次接入时若有未完成的历史 charging_process（僵尸会话），`observeChargingStarted` 会当"新事件"处理 | L23-24, L179-182 | 违反 AC-12.1b 充电侧——存量用户接入瞬间可能收到僵尸充电事件 |
| B3 | **运算符优先级隐患**：`charging && charging.end_at === null || charging?.end_date === null` 实际解析为 `(a&&b)||c`，当前碰巧结果正确但语义错误 | startTripMonitorLoop L220 | 重构时极易引入 bug，重写时必须修 |
| B4 | **chargingStart 事件未接线**：`observeChargingStarted` 返回的 isNew 被调用方忽略，充电开始推送在骨架中实际不存在 | L221 | M2 推送管线的已知缺口 |
| B5 | tesla-butler 衍生注释第二处确认：文件头 L4-7"semantics inherited from tesla-butler trip-session.mjs" | L4-7 | t_f6ebddf1 重写范围实锤（两文件都有） |

## 七、web 前端骨架扫描（2026-10-14 第三轮）

- **B1' 前端 CNY 命名面**：`fmtCny` 工具函数 + `costCny`/`totalCostCny`/`fuelCostCny`/`defaultRateCnyPerKwh` 字段引用遍布 5 个页面（TripsPage/ChargingPage/PricingPage/DashboardPage/TripDetailPage）——契约 v2 BREAKING B1 的前端同步点比预估多一个 `fmtCny` 工具层，改造成本集中在 `web/src/utils/format.ts` 一处（好消息：集中、可控）
- **G11 无 /setup 页面**：前端完全没有 setup/wizard/onboarding 相关代码——M1-2 向导卡的前端工作量确认是**从零新建**（非改造），P1 规格四步向导按 PRD §6.3 全量开发
- 页面清单现状：Login/Dashboard/Trips/TripDetail/Charging/Pricing/Push 7 页已有基础，对照 §6.2 路由树缺 `/setup`、`/reports` 两页

## 八、给三张卡的直接输入

- **t_c03ab81d 差距分析**：本文档 §三 可直接并入差距矩阵（10 条已编号）
- **t_f6ebddf1 合规重写**：重写范围确认 = pricing-ledger 全文（含 tesla-butler 注释 L13-15/L108）+ trip-monitor；**保留 §四 列出的设计**（UTC 处理/slices/精度双轨/单位归一不是衍生算法，是通用工程实践）
- **t_3689fa50 Live 验证**：新增验证点——① states 表在你的真库里有数据吗（G10）② 你的 car_id 是不是 1（§二 bug 是否已实际影响你）③ 充电侧水线缺失（§五 B2）在你真库上的实际表现：接入瞬间是否产生僵尸充电事件
