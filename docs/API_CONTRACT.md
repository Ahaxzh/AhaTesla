# AhaTesla API 契约 v1

单一 Node 服务，端口 **18500**，同时提供 REST API 与前端静态资源（生产模式）。
认证：JWT (HS256)，`httpOnly` cookie `ahatesla_token`，24h 有效。单用户体系（首次启动生成初始密码，登录后可改）。

## 数据源
- TeslaMate PostgreSQL（经 socat 桥接容器暴露 `127.0.0.1:15432`，db=teslamate user=teslamate）
- Mosquitto MQTT（桥接 `127.0.0.1:1883`，无认证，仅用于充电/门锁实时信号）
- 只读访问，禁止任何写操作到 teslamate 库

## 端点

### 认证
- `POST /api/auth/login` {username, password} → {token, user}
- `POST /api/auth/logout` → {ok}
- `GET /api/auth/me` → {username, initialized}（401 未登录）
- `POST /api/auth/change-password` {oldPassword, newPassword} → {ok}

### 概览
- `GET /api/dashboard` → {
    car: {name, currentBattery, rangeKm, state, odometerKm},
    monthStats: {distanceKm, energyKWh, costCny, driveCount, driveHours},
    weekStats: {distanceKm, energyKWh, costCny},
    fuelComparison: {fuelCostCny, source, asOf},
    recentTrips: [Trip...top5], recentCharges: [Charge...top5]
  }

### 行程
- `GET /api/trips?limit=50&offset=0&from=ISO&to=ISO` → {total, items: [Trip]}
- `GET /api/trips/:id` → Trip 详情（含路线 polyline 点集、起终点地址、每公里能耗）
- Trip: {id, startAt, endAt, distanceKm, durationMin, energyKWh, costCny, startAddress, endAddress, kwhPer100km, routeKey}

### 充电
- `GET /api/charging?limit=50&offset=0` → {total, items: [Charge]}
- `GET /api/charging/stats?period=month|all` → {totalKWh, totalCostCny, avgPricePerKWh, byLocation: [{name, count, kwh, cost, pricePerUnit}]}
- Charge: {id, startAt, endAt, locationName, energyAddedKWh, costCny, pricePerUnit, startBattery, endBattery, durationMin, powerMaxKw}

### 电价（geofences 镜像 + 默认价）
- `GET /api/pricing` → {defaultRateCnyPerKwh, locations: [{id, name, pricePerUnit, sessionFee, billingType}]}
- `PUT /api/pricing/default` {rate} → {ok}（写本地库，不改 teslamate）
- `GET /api/pricing/history` → 费率变更历史 [{changedAt, from, to, source}]

### 推送渠道配置
- `GET /api/channels` → {feishu: {enabled, connected, appAlias, lastEventAt}, web: {enabled: true}}
- `PUT /api/channels/feishu` {enabled, appId, appSecret} → {ok, connected}（secret 落盘加密存储，不回传）
- `POST /api/channels/feishu/test` → {ok, message}（发送测试卡片）
- 推送规则: `GET/PUT /api/push-rules` {
    tripEnd: bool, chargingStart: bool, chargingDone: bool,
    weeklyReport: bool, weeklyReportDay: 1-7, monthlyReport: bool
  }

### 系统
- `GET /api/system/status` → {teslamate: {dbOk, mqttOk, lastDriveAt, driveCount}, uptime, version}
- `GET /api/system/events?limit=100` → 运行事件日志（推送记录、错误）
- WebSocket `/ws` → 实时事件推送（可选实现，前端轮询兜底）

## 计价规则（核心）
1. 充电会话若 `charging_processes.cost` 非空 → 直接使用（TeslaMate 已按 geofence 单价算好）
2. cost 为空但 geofence 有 cost_per_unit → energy × price + session_fee
3. 都没有 → 使用默认价（本项目 `pricing.defaultRate`，变更只影响之后的新行程）
4. 行程电费 = 行程耗电按时间顺序消耗"已购电价批次"，批次耗尽回落默认价（继承 tesla-butler electricity-accounting 模型，批次来源改为 TeslaMate 充电记录自动导入，非 OCR）

## 错误格式
`{error: {code, message}}`，HTTP 4xx/5xx。未认证访问受保护端点 → 401。
