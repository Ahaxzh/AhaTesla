# AhaTesla 特斯拉小管家 — Ubuntu 自托管版

> 记账与行程边界算法的设计灵感来自 [manwithshit/tesla-butler](https://github.com/manwithshit/tesla-butler)；本项目按自有规格（docs/PRD.md / docs/API_CONTRACT.md）独立实现，并移植到 Ubuntu Server + Web 化。飞书推送 + Web/PWA 双通道。

> ℹ️ 部署形态已演进：发行版走 deploy/fullstack-compose.yml（全栈）与 deploy/connect-compose.yml（挂入现有 teslamate 网络，直连容器名，无需 socat 桥）。下方 socat 桥接图保留为**裸机开发模式**参考。

## 架构（参考 AhaSlit 前后端分离模式）

```
┌─ 采集层（已存在，零改动）────────────────┐
│ teslamate_default 网络                     │
│   TeslaMate 18400 · Grafana 18300          │
│   PostgreSQL(内部5432) · Mosquitto(内部1883)│
└────────────┬───────────────────────────────┘
             │ socat 桥接容器（唯一新增基础设施）
             │ 127.0.0.1:15432→DB  127.0.0.1:1883→MQTT
┌────────────┴───────────────────────────────┐
│ server/  Node 26 ESM，端口 18500           │
│  ├─ core/  核心领域逻辑（自有实现）        │
│  │   trip-monitor 行程边界 · pricing-       │
│  │   ledger 电价批次 · feishu 飞书推送      │
│  ├─ api/   Express 风格路由+JWT+分层        │
│  └─ 静态托管 web/dist（生产）              │
└────────────┬───────────────────────────────┘
             │
   ┌─────────┴──────────┐
   │ web/ React19+Vite  │   NPM 反代 → https://tesla.home.example.com
   │ +TS+Tailwind+PWA   │   iPhone 添加到主屏幕
   └────────────────────┘
```

## 端口
18500（Web+API，五位规范 18xxx 专项应用段）

## 目录
```
server/   Node 后端（worker+api 同进程）
  src/index.mjs   组合根（装配与生命周期，不装领域逻辑）
  src/api/        HTTP 层：一处一域的 *-routes + http-kit 手写路由 + jwt + static
  src/core/       领域层：不依赖 api/（ADR-0001，scripts/check-arch.mjs 机器强制）
web/      React 前端 + PWA
docs/     API_CONTRACT.md（接口唯一真相源）· GOVERNANCE.md（架构治理）· adr/
deploy/   全栈/挂接双 compose、systemd unit、NPM 配置说明
scripts/  run-e2e.sh · check-arch.mjs（模块边界检查）· e2e 辅助
```

## 部署形态
- 开发: web vite:5173 proxy→18500
- 生产: server 托管 web/dist，systemd `ahatesla.service`，NPM(.4) 反代 HTTPS

## 核心领域模块（自有实现，规格见 docs/PRD.md）
- `trip-monitor.mjs` 行程结束边界状态机（门锁信号 + DB 兜底；首次接入通知水线，历史数据静默建档不回放）；`monitor-persistence.mjs` kv 崩溃自愈
- `pricing-ledger.mjs` 计价原语（四层回退 + FIFO 批次分摊）→ `fifo-ledger.mjs` 全量回放缓存（任意入口每公里成本一致）；选项装配统一走 `pricing-options.mjs`
- `trip-views.mjs` 行程视图装配（trips/dashboard/export/报表共用的唯一 Trip 形状）
- `push-dispatch.mjs` 推送投递管线（富化→多车标记→矩阵投递→去重→派生告警→pending 补发）
- `push-channels.mjs` 六渠道 + 12 事件矩阵；`patrols.mjs` 胎压/低电量/保养巡检（kv 节流）
- `report-engine.mjs` 日报/周报/月报/年报快照（不可变归档）
- `feishu.mjs` 飞书推送通道（Card 1.0 兼容子集 + 长连接事件消费）

## 工程约束（机器强制）
- 模块边界：`node scripts/check-arch.mjs`（CI arch job；规则见 docs/adr/0001）
- 接口契约：docs/API_CONTRACT.md 先行；金额字段不带货币后缀（cost/totalCost/fuelCost）
- 架构治理任务池与进度：docs/GOVERNANCE.md

## 已砍掉
- Apple Vision OCR / kimi.mjs（geofence 单价 + charging.cost 已覆盖）
- launchd（→ systemd）
- docker-compose 采集栈（用户已有）
- v1 推送布尔规则 API 与默认值（v2 矩阵唯一实现，2026-11 B2）
- costCny/totalCostCny/fuelCostCny 字段族（B1 多币种语义落地，2026-11 B6；报告快照 costCny 为不可变历史格式保留）

## 安全红线（继承 AGENTS.md）
- 只读 teslamate 库；不发车辆命令；VIN/GPS/token 不进日志和 Git
