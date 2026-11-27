# ADR-0001 — 模块依赖方向规则（机器可执行）

日期：2026-11-28 · 状态：已接受

## 背景

server 133 条内部 import 中 core→api 违规当前为 0（良好既有纪律），但无任何机制防止回潮。
web 侧 pages/components/contexts 边界同样只靠约定。

## 决策

1. server：`api/*` 可依赖 `core/*`；`core/*` 禁止依赖 `api/*`（含间接经 state/store 之外的旁路）。
   `core` 内部允许按域互引，但禁止环（对既有代码按文件级检测，发现即视为违规，白名单须在本 ADR 追记理由）。
2. web：`pages/*` 不得 import 其他 page；`components/*` 不得 import `pages/*`；`contexts/*` 不得 import `pages|components`。
3. 执行方式：`scripts/check-arch.mjs`（零依赖，解析 import/export 语句建图断言），接入 CI。
   该脚本只做边界断言，不做风格检查——风格交给评审，边界交给机器。

## 后果

- 新增「领域逻辑」时应落 `core/`，API 层只做 HTTP 编解码与调用组装。
- 违规要么改代码，要么在此 ADR 追加白名单条目 + 理由 + 期望移除时间。
