# 架构治理报告 — B0~B7 八批闭环

> **日期**: 2026-11-28 · **跨度**: `dfa89d3 → 073655d`（8 commits，63 文件，+1225/−1144 行）
> **方法**: 「假设今天是产品第一天」视角全库降熵、归一、解耦；每批 = 熵项确认 → 方案比选（取总复杂度最低）→ 行为基线测试 → 迁移全部调用方 → 删除旧实现 → 门禁验证 → 防回归约束 → 独立 commit。隔离 worktree 执行，结束后合入 main。
> **活文档**: 熵清单与任务池见 [`docs/GOVERNANCE.md`](../GOVERNANCE.md)；边界规则见 [`docs/adr/0001`](../adr/0001-module-dependency-rules.md)。

## 总览

| 指标 | 结果 |
|---|---|
| 熵清单项 | **15 / 15 全部收口**（14 完成 + 1 项判定不处置并说明理由） |
| 治理途中挖出的隐性缺陷 | **4 个**（见下节） |
| 新领域模块 | 9 个（core ×5 · api ×3 · 检查器 ×1） |
| index.mjs 组合根 | 650 → 407 行（纯装配） |
| api/trips-routes.mjs | 796 → 686 行（视图装配迁出） |
| 仅内部使用的 export 收回私有 | 19 个 |
| e2e | 常规 37 过 3 跳（双视口去重）+ 向导 4 过（连真实只读库隔离实例） |

红线全程未触碰：VIN/GPS/Token/Secret 零出现于提交与日志；`server/data` 与 `.env` 未入库；teslamate 库只读；无任何车辆控制命令。

## 治理途中挖出的四个隐性缺陷

均为「平行实现长期并存」的既成产物，非治理引入：

1. **全新实例推送矩阵默认错误**（B2 修复）—— `DEFAULT_STATE` 残留的 v1 布尔默认（`tripEnd: true`…）经 `matrixFromRules` 兼容路径被误读为「内容事件全部六渠道开」，与契约 §6「内容事件新渠道默认关」相反；全新实例配好任一渠道后，未显式订阅的 trip/charge 推送会直接送达。修复：删 v1 默认 + 从未注册到生产路由的 v1 规则 API（channel-routes 的 list/getPushRules/putPushRules），回归测试锁定默认矩阵语义；存量 v1 实例的已存布尔不受影响。
2. **死 stub 覆盖真实实现**（B4 铲除）—— push-routes 内早已存在一个返回 `undefined` 的 `updateFeishu` 占位 stub；JS 对象字面量后键覆盖前键，接线者会拿到坏端点（参数校验 400 变 200）。并入真实现时暴露，随批删除。
3. **/api/cars 排序与契约漂移**（B1 修复）—— 车辆清单同时存在 3 套实现；契约要求 `display_priority` 排序，car-scope 自建查询却按 `id ASC`，demo-data 被迫对三种 SQL 指纹逐个特判。收敛为 `teslamate-queries.getCars` 唯一权威。
4. **契约 B1 声称完成、实现从未执行**（B6 落地）—— 契约 §10 明示「B1~B8 前端已全部同步」，实际 server/web 全量仍传 `costCny`，唯一真相源与实现漂移三年字段，多币种实例下 CNY 后缀本就语义错误。全栈改名 `cost`/`totalCost`/`fuelCost`/`fmtMoney`；报告快照 `costCny` 以「不可变历史归档格式」豁免并回写契约注明。

## 八批明细

| 批 | 提交 | 内容 |
|---|---|---|
| B0 | `7603942` | 治理脚手架：`scripts/check-arch.mjs` 零依赖模块边界断言（注入违规自测捕获后接入 CI arch job）· ADR-0001 · GOVERNANCE.md 熵清单/任务池 · client.ts 死条目/tsbuildinfo/根 package.json 清理 |
| B1 | `bb36a08` | 车辆清单 3 套→`getCars` 唯一（demo-data 特判分支随删）· 充电月份过滤复用 `monthWindowIso`/`expr` · 死代码 6 处删除 |
| B2 | `c8e1ea9` | 全新实例默认矩阵纠正（缺陷①）+ v1 规则死 API 删除 + 回归测试锁定 |
| B3 | `61be9ca` | `computeTripViews` 迁 `core/trip-views`（原经 buildDeps 反向注入 core，ADR-0001 旁路）· `lttbDownsample` 迁 `core/util` |
| B4 | `1edf19f` | settings/system 路由分家 · channel-routes.mjs 删除（飞书并入 push-routes）· 铲除死 stub（缺陷②）· dashboard-extra 重复 helpers 改用 util |
| B5 | `c89e3f1` | 组合根瘦身：push-dispatch/patrols/maintenance/monitor-persistence/static 五模块迁出 · MQTT 懒视图替代「清表重注册」hack · 双飞书实例合一 · index 650→407 行 · demo 冒烟通过 |
| B6 | `159a2e5` | 金额字段契约落地（缺陷④）：costCny→cost 全栈 + fmtCny→fmtMoney + 契约回写 |
| B7 | `073655d` | 19 个仅内部 export 私有化 · monitor kv 键硬编码改常量 · ARCHITECTURE.md/GOVERNANCE.md 收口 |

## 验证门禁（每批独立全绿）

| 门禁 | 结果 | 说明 |
|---|---|---|
| `server npm test` | 275/275 | 基线 276：删 2 个死代码测试、增 1 个默认矩阵回归锁 |
| `web tsc --noEmit` | 通过 | |
| `web vitest` | 132/132 | mock 字段全部随 B6 改名 |
| `web build` | 通过 | |
| `node scripts/check-arch.mjs` | 通过 | B0 新增；CI arch job 常驻拦截回潮 |
| `bash scripts/run-e2e.sh` | 41+4 过 | 常规 37 过 3 跳 · 向导 4 过；连真实只读库隔离实例 |
| demo 冒烟 | health-lite 200 | `AHATESLA_DEMO=1` 隔离实例 boot 正常 |

## 判定与遗留

- **巨页（Settings 941 / Setup 805 / Push 670 行）判定不拆**：三页内部已按分区函数/渠道卡片组织（PushPage 六渠道卡 + 共用 ChannelCardHeader、SettingsPage 分区 + CollapseCard），无复用诉求的再拆分属无收益搬迁；触发条件（某分区出现第二调用方、或成为并行开发热点）记录于 GOVERNANCE.md。
- **观察①** demo 模式 report scheduler `setTimeout` 溢出告警（合成日期遥远；基线同样存在，非本轮引入，真实实例无此现象）。
- **观察②** SettingsPage 矩阵默认与 server `defaultMatrix` 语义重复（UI 预载占位；GET 恒返回生效矩阵，无漂移风险）。
- **防回归已固化**：CI arch job 机器拦截边界回潮（ADR-0001）；接口变更先改契约；后续架构任务统一走 GOVERNANCE.md 任务池。
