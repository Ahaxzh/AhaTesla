# AhaTesla API 契约 v2

> **状态**：定稿（2026-10-14，对应 PRD v1.2）· 前一版：v1（见 Git 历史）
> **本文档是唯一真相源**：改接口先改它，再改 server、web、测试（CLAUDE.md 纪律）。

单一 Node 服务，端口 **18500**，同时提供 REST API 与前端静态资源（生产模式）。

## 0. 全局规范

- **认证**：JWT (HS256) httpOnly cookie `ahatesla_token`，**Access 24h + Refresh 30d 双 Token**（AC-3.2）；受保护端点未认证 → 401 `{error:{code,message}}`
- **初始化状态机**：实例三态 `uninitialized`（无管理员）→ `setup-locked`（管理员已建，/api/setup/* 注册类端点 403）→ `ready`。`GET /api/setup/status` 可匿名查询
- **金额与精度（PRD §7.3）**：金额 2 位小数、单价 3~4 位小数（均以字符串传输，避免浮点误差）；内部计算高精度，展示层截断
- **多币种（AC-9.1）**：金额字段统一 `cost` / `totalCost` / `avgPrice` 命名，**不带货币后缀**；货币由实例配置（`/api/settings` currency）决定
- **错误格式**：`{error: {code, message}}`，HTTP 4xx/5xx

## 数据源

- TeslaMate PostgreSQL（只读；连接分级见 PRD §7.1——同机 external network / 跨机局域网直连，socat 仅高级附录）
- 事件捕获基线为 PG 轮询（15~30s，AC-12.1b）；MQTT 可选增强（显式配置才启用）
- AhaTesla 自有数据（账号/密钥/订阅/电价/FIFO 记录/报告快照/事件日志）存本地 SQLite `/data/ahatesla.db`，**严禁写 teslamate 库**

## 1. 初始化与数据源（v2 新增）

- `GET /api/setup/status`（匿名）→ {state: "uninitialized"|"setup-locked"|"ready", https: bool, carFound: bool}
- `POST /api/setup/admin`（仅 uninitialized）{username, password(≥8)} → {ok}（自动登录设 cookie）
- `POST /api/setup/test-connection` {host, port=5432, database="teslamate", user, password} → {steps:[{name:"reachability"|"auth"|"readonly"|"cars", ok, detail}]}
  - readonly 步 = **元数据探测**：`SELECT has_table_privilege(current_user,'public.drives','INSERT,UPDATE,DELETE,TRUNCATE') OR has_schema_privilege(current_user,'public','CREATE')`，返回 true 即危险配置（ok:false，要求降级只读账号，AC-2.4）；**严禁 CREATE/INSERT 实写探测**；连接池每 Session 初始化强制 `SET default_transaction_read_only = on`
- `POST /api/setup/datasource` {mode:"connect"|"fullstack", ...连接参数} → {ok}（连接信息 AES-GCM 加密存 SQLite）
- `GET /api/setup/car-discovery`（管理员）→ {found, car:{id,name,model}|null}（前端 2s 轮询，AC-2.3 的 60 秒发现）
- `POST /api/setup/probe-discovery`（管理员）→ {candidates:[{host, port, reachable}]}（m4a 轨道 B：容器服务名/网关 + `AHATESLA_PROBE_HOSTS` env 展开 + 已配 DB_URL 目标，800ms TCP 探测，只报可达性不猜库名）
- `POST /api/setup/auto-ro`（管理员）{host, port=5432, database="teslamate", adminUser, adminPassword} → 成功 {ok:true, dsn:"postgres://ahatesla_ro:***@host:port/db", password}（一次性明文仅此返回）；失败 {ok:false, stage:"auth"|"permission"|"verify", error, fallbackSql?} —— adminPassword 仅内存使用绝不落盘/入日志；permission 失败附可复制执行的 fallbackSql；RO 建号幂等（角色存在只改密码）
- `GET /api/settings`（管理员）→ {currency:{symbol:"¥",code:"CNY"}, distanceUnit:"km"|"mi", timezone, fuelBaseline:{consumptionL100:8.0, pricePerL:8.20}}
- `PUT /api/settings`（管理员）→ {ok}（fuelBaseline 即 AC-7.4 油车基准可配置）

## 2. 认证（v1 演进）

- `POST /api/auth/login` {username, password} → {token, user}（连续 5 次失败锁 15 分钟，AC-3.3）
- `POST /api/auth/refresh` → {ok}（Refresh cookie 续 Access；失效则 401 重登）
- `POST /api/auth/logout` → {ok}
- `GET /api/auth/me` → {username, initialized}
- `POST /api/auth/change-password` {oldPassword, newPassword} → {ok}（吊销其他会话）
- `POST /api/auth/sessions/revoke-all`（管理员）→ {ok}（AC-3.2 手动吊销）

## 3. 仪表盘与行程（v1 演进）

- `GET /api/dashboard` → {
    car: {name, model, currentBattery, rangeKm, state, stateSince, odometerKm, positionAt},
    monthStats: {distanceKm, energyKwh, **cost**, driveCount, driveHours},
    weekStats: {distanceKm, energyKwh, **cost**},
    fuelComparison: {**fuelCost**, **saved**, savedPct, baseline, asOf},
    recentTrips:[Trip top5], recentCharges:[Charge top5]
  }
- `GET /api/dashboard/timeline`（v2.1 新增，P2 模块2）→ {segments:[{from, to, state:"driving"|"charging"|"online"|"asleep"|"offline"}], summary:{drivingH, chargingH, asleepH, onlineH, offlineH}}（最近 24h，按实例时区对齐零点或滚动窗口）
- `GET /api/dashboard/heatmap`（v2.1 新增，P2 模块4）→ {days:[{date:"YYYY-MM-DD", distanceKm}], maxKm}（最近 90 天按实例时区聚合，date 为本地日期）
- `GET /api/trips?limit=50&offset=0&from=ISO&to=ISO` → {total, items:[Trip]}
- `GET /api/trips/:id` → Trip 详情：{...Trip, polyline:[点集（LTTB 降采样 ≤300 点）], fifo:{batches:[{source, kwh, price, amount}], totalCost, blendedPrice}, fuelComparison:{baseline, fuelCost, saved, savedPct}, efficiency:{ratedKwh, actualKwh, ratio}, environment:{avgTempC, acEstimateKwh, avgSpeedKmh, cruiseSpeedKmh}}
- Trip: {id, startAt, endAt, distanceKm, durationMin, energyKwh, **cost**（原 costCny）, startAddress, endAddress, kwhPer100km, routeKey}

## 4. 充电（v1 演进）

- `GET /api/charging?limit=50&offset=0&month=YYYY-MM` → {total, items:[Charge]}
- `GET /api/charging/stats?period=month|all` → {totalKwh, **totalCost**, **avgPrice**, byLocation:[{name, count, kwh, cost, pricePerUnit}]}
- `GET /api/charging/:id` → {**...Charge, powerCurve:[{soc, kw}]（峰值打点 maxKw@soc）**, efficiency:{meterKwh, batteryKwh, ratio, lossKwh}, costSource:"manual"|"geofence"|"default"}
- `PUT /api/charging/:id/cost` {amount, source:"manual"} → {ok}（费用补录；触发 7 天窗口异步重算，AC-7.6）
- Charge: {id, startAt, endAt, locationName, energyAddedKwh, **cost**（原 costCny）, pricePerUnit, startBattery, endBattery, durationMin, powerMaxKw, costSource}

## 5. 电价与账本（v1 演进）

- `GET /api/pricing` → {defaultRate（原 defaultRateCnyPerKwh）, locations:[{id, name, **priceMode:"fixed"|"tou"**, pricePerUnit, **tou:{offPeakStart:"23:00", offPeakEnd:"07:00", offPeakRate, peakRate}**, sessionFee, billingType}]}
- `PUT /api/pricing/default` {rate} → {ok}（只影响新行程，AC-7.3）
- `GET /api/pricing/history` → [{changedAt, from, to, source}]
- `PUT /api/pricing/locations/:id` {priceMode, pricePerUnit?, tou?} → {ok}（围栏分时电价配置，本地 SQLite 存）
- `POST /api/ledger/summary?month=YYYY-MM` → {distanceKm, energyKwh, totalCost, costPerKm, fuelComparison, parkingLoss:{kwh, cost}, breakdown:{drivingCost, parkingCost}}（**v2 新增**：月度账本 + 驻车损耗 + 口径构成，AC-7.5；P2 模块3 小字数据源）
- `POST /api/ledger/recalculate` {from?, to?|all} → {jobId}（【重算历史账本】，AC-7.3）
- `GET /api/ledger/recalculate/:jobId` → {status, progress}（重算进度）

## 6. 推送（渠道抽象，v1 演进）

### 渠道配置（三渠道平权，AC-10.1）
- `GET /api/channels` → {webpush:{enabled, subscriberCount}, telegram:{enabled, connected}, feishu:{enabled, connected, appAlias}}
- `PUT /api/channels/webpush` {enabled} → {ok}
- `GET /api/push/env`（匿名）→ {https: bool}（AC-11.0 前端置灰依据）
- `POST /api/push/webpush/subscribe` {endpoint, keys:{p256dh, auth}} → {ok}
- `POST /api/push/webpush/unsubscribe` {endpoint} → {ok}
- `POST /api/push/webpush/test` → {ok}（向当前设备发测试，AC-10.2）
- `PUT /api/channels/telegram` {botToken, chatId} → {ok}（密文存储）
- `POST /api/channels/telegram/test` → {ok}
- `PUT /api/channels/feishu` {enabled, appId, appSecret} → {ok, connected}
- `POST /api/channels/feishu/test` → {ok, message}

### 推送规则（矩阵化）
- `GET /api/push-rules` → {matrix: {tripEnd:{webpush,telegram,feishu}, chargingStart:{...}, chargingDone:{...}, daily:{...}, weekly:{...}, monthly:{...}}}
- `PUT /api/push-rules` {matrix} → {ok}
  - v1 为每事件单一 bool → v2 为 6 事件 × 3 渠道矩阵（P6 分组3）；weeklyReportDay 并入 settings
  - `daily`（m4c-c1）：昨日用车日报，每日 08:00 推送；昨日无行程且无充电自动跳过；不落报告归档表

### 报告（v2 新增）
- `GET /api/reports` → {items:[{id, type:"weekly"|"monthly", periodLabel, distanceKm, totalCost, saved}]}
- `GET /api/reports/:id` → 报告快照（KPI 四宫格 / 主跑路线 TOP3 / 账本结语 / 深度洞察数据，P5 规格）
- `POST /api/reports/generate` {type} → {ok}（手动触发，调试用）

### AI 助手（m4c-c3，BYO 模型）
- `GET /api/ai/config` → {enabled, baseUrl, model, hasKey, keyAlias}（绝不回明文 key；keyAlias 为 sha256 指纹前 4 位）
- `PUT /api/ai/config` {enabled, baseUrl, model, apiKey?} → {ok}
  - OpenAI 兼容端点；apiKey 省略 = 保持不变，空串 = 清除；AES-256-GCM 落库
  - 默认关闭。启用后行程小结/日报/周报/月报正文末尾追加一行「💡 洞察」；超时(8s)/失败静默回退模板，推送永不因 AI 失败

## 7. 系统（v1 演进）

- `GET /api/system/status` → {teslamate:{dbOk, **latencyMs**, lastDriveAt, driveCount, **readonlyVerified**}, mqtt:{...}（**仅已配置时返回**，AC-5.1）, uptime, version}
- `GET /api/system/events?limit=100` → 事件日志（含推送时效埋点 **deliveryMs**，AC-12.3 验证依据）
- `GET /api/system/health-lite`（匿名）→ {dbOk}（失联横幅轮询，无需登录态）
- WebSocket `/ws` → 实时事件 {type:"tripEnd"|"chargingStart"|"chargingDone", payload}（可选，前端轮询兜底）

## 8. 计价规则（核心，v1.3 评审后定稿）

1. 充电会话费用优先级（**四层回退**）：① AhaTesla 本地手动录入（SQLite `charge_cost_overrides`）→ ② `charging_processes.cost` 非空 → ③ geofence 单价（支持**分时电价**：谷段时段+两档价，按充电起止跨时段比例计价）→ ④ 默认价（变更仅对未来生效）
2. **FIFO 批次入池公式（含充损闭合）**：批次可用电量 = `charge_energy_added`（电池净吸收）；批次折算单价 = 实付总额 ÷ `charge_energy_added`。批次耗尽时分摊总和 ≡ 实付总额（账本闭合）；行程耗电 = `(start_rated_range_km − end_rated_range_km) × cars.efficiency`（ideal 回退同式）
3. **驻车损耗（AC-7.5）**：事件驱动——每次新行程/充电开始时对比上一事件结束的表显电量，差值 >0.5 kWh 立即冲抵 FIFO（含负损耗过滤 BMS 温漂）
4. **修正窗口（AC-7.6）**：推送小结=不可变快照；7 天内补录费用（PUT /charging/:id/cost，存 charge_cost_overrides）触发异步重算，UI 标注校准
5. **历史重算**：`POST /api/ledger/recalculate` {from?, to?|all} → {jobId}（P6【重算历史账本】，进度可查）
6. **冷启动水线**：首次接入数据源时记录最大 drives.id / charging_processes.id 为通知游标，水线前历史数据仅静默建档不推送（AC-12.1b）
7. 地点名称一律 JOIN TeslaMate `addresses` 表（county/city/road），**严禁调用外部逆地理编码 API**

## 9. BREAKING 变更清单（v1 → v2）

| # | 变更 | v1 | v2 | 前端同步点 |
|---|---|---|---|---|
| B1 | 金额字段去 CNY | costCny / totalCostCny / fuelCostCny 等 | cost / totalCost / fuelCost | client.ts + 全部展示组件 |
| B2 | 初始化方式 | 日志打印初始密码 | /setup 首注册管理员（AC-1.4） | LoginPage → 新 SetupPage |
| B3 | 会话模型 | 单 JWT 24h | Access 24h + Refresh 30d | client.ts 401→refresh→重试 |
| B4 | 推送规则 | 每事件单 bool | 5×3 矩阵 | PushPage 矩阵 UI |
| B5 | 数据源配置 | .env DB_URL | /api/setup/datasource（SQLite 加密） | SetupPage Step2 |
| B6 | 充电详情 | 无单条端点 | GET /charging/:id（功率曲线/效率） | ChargingPage 详情模态 |
| B7 | 默认价字段名 | defaultRateCnyPerKwh | defaultRate | PricingSettings |
| B8 | MQTT 状态 | 恒定返回 | 仅配置时返回 | StatusPage 条件渲染 |

## 10. 实现状态标注

**v2 全部端点已实现（2026-10-15，M1+M2 收官）**。逐节状态：

| 节 | 端点组 | 状态 | 备注 |
|---|---|---|---|
| 1 | /api/setup/*（status/admin/test-connection/datasource/car-discovery） | ✅ 已实现 | 四级校验含 has_table_privilege 元数据探测（M1） |
| 1 | /api/setup/probe-discovery · /api/setup/auto-ro | ✅ 已实现 | m4a 轨道 B 存量接入自动探测+代建只读账号 |
| 1 | GET/PUT /api/settings | ✅ 已实现 | GA-36；fuelBaseline 油车基准可配置（M2） |
| 2 | /api/auth/*（login/refresh/logout/me/change-password/sessions/revoke-all） | ✅ 已实现 | 双 Token AC-3.2 + 连续 5 败锁 15 分钟 AC-3.3（M2） |
| 3 | GET /api/dashboard | ✅ 已实现 | car 增 state/stateSince/odometerKm/positionAt |
| 3 | GET /api/dashboard/timeline · /api/dashboard/heatmap | ✅ 已实现 | P2 模块2/4（M2）；前端 Timeline24h/HeatmapCalendar |
| 3 | GET /api/trips · /api/trips/:id | ✅ 已实现 | 详情含 FIFO 批次/能效/环境/速度轨迹（M2，speed 字段随 route 点返回） |
| 4 | GET /api/charging（month 筛选）· /api/charging/:id · PUT /:id/cost | ✅ 已实现 | powerCurve 峰值打点 + 桩端效率 + costSource 三态（M2） |
| 5 | GET/PUT /api/pricing（defaultRate/locations TOU 双模）· /api/pricing/history | ✅ 已实现 | kv pricing:location-tou:<id>（M1 承接） |
| 5 | POST /api/ledger/summary · /api/ledger/recalculate(+jobId) | ✅ 已实现 | 月度账本 + 7 天补录窗口 + 进度（M1） |
| 6 | 渠道配置（webpush/telegram/feishu）+ /api/push/env | ✅ 已实现 | 三渠道平权 AC-10.1；Telegram/飞书密文 AES-GCM 落库（M2） |
| 6 | GET/PUT /api/push-rules（6×3 矩阵） | ✅ 已实现 | B4 矩阵替换 v1 单 bool（M2）；daily 事件 m4c 新增 |
| 6 | /api/reports（列表/详情/generate） | ✅ 已实现 | 不可变快照 report_snapshots；周一/月初 08:00 定时（M2） |
| 7 | /api/system/status（latencyMs/readonlyVerified）· /events（deliveryMs）· /health-lite | ✅ 已实现 | GA-31/32；health-lite 匿名供失联横幅轮询（M2） |
| 7 | WebSocket /ws | ⏸ 未实现 | 契约标注"可选，前端轮询兜底"；轮询路径已全覆盖，按需后补 |

计价规则（§8）七条全部落地并有单测覆盖（pricing-ledger 测试组）。BREAKING B1~B8 前端已全部同步。
