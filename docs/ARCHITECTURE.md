# AhaTesla 特斯拉小管家 — Ubuntu 自托管版

> 基于 [manwithshit/tesla-butler](https://github.com/manwithshit/tesla-butler) 的架构与核心算法，移植到 Ubuntu Server + Web 化。飞书推送 + Web/PWA 双通道。

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
│ server/  Node 22 ESM，端口 18500           │
│  ├─ core/  tesla-butler 移植核心           │
│  │   trip-session 边界 · electricity-       │
│  │   accounting 电价批次 · lark-bot 飞书    │
│  ├─ api/   Express 风格路由+JWT+分层        │
│  └─ 静态托管 web/dist（生产）              │
└────────────┬───────────────────────────────┘
             │
   ┌─────────┴──────────┐
   │ web/ React19+Vite  │   .4 NPM 反代 → https://tesla.home.xxx
   │ +TS+Tailwind+PWA   │   iPhone 添加到主屏幕
   └────────────────────┘
```

## 端口
18500（Web+API，五位规范 18xxx 专项应用段）

## 目录
```
server/   Node 后端（worker+api 同进程）
web/      React 前端 + PWA
docs/     API_CONTRACT.md 等
deploy/   socat 桥接 compose、systemd unit、NPM 配置说明
scripts/  初始化、图标生成
```

## 部署形态
- 开发: web vite:5173 proxy→18500
- 生产: server 托管 web/dist，systemd `ahatesla.service`，NPM(.4) 反代 HTTPS

## 从 tesla-butler 继承的核心资产
（源：~/.hermes/cache/scratch/tesla-butler，MIT 无 LICENSE 文件以 README 口径为准，保留出处）
- trip-session.mjs 行程结束边界状态机（门锁信号+DB兜底）
- electricity-accounting.mjs 电价批次账本（入账来源改为 TeslaMate charging_processes.cost 自动导入）
- cards.mjs 飞书 Card 2.0 模板
- lark 长连接事件消费模式（spawn lark-cli → 改为内嵌 WebSocket client）

## 已砍掉
- Apple Vision OCR / kimi.mjs（geofence 单价 + charging.cost 已覆盖）
- launchd（→ systemd）
- docker-compose 采集栈（用户已有）

## 安全红线（继承 AGENTS.md）
- 只读 teslamate 库；不发车辆命令；VIN/GPS/token 不进日志和 Git
