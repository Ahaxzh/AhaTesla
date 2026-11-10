> 🗄️ **历史归档**（2026-11-10 移入）：快照类文档，现状以代码、README 与 docs/API_CONTRACT.md 为准——勿按此文件里的 checkbox/差距清单理解当前功能。

# AhaTesla 差距分析（GAP-ANALYSIS）— 现有骨架 vs PRD v1.3 / API_CONTRACT v2

**执行**：ahahermes（Hermes Agent）· **日期**：2026-10-14 · **对应卡**：t_c03ab81d（M0-2 差距分析）
**规格基线**：docs/PRD.md **v1.3**（§5 US-1~15 与 AC、§6 页面 P1-P6、§7 非功能）· docs/API_CONTRACT.md **v2**（唯一真相源）
**输入**：docs/PM_AUDIT.md（G1-G11 + B1-B5 + B1'）、docs/M0-VERIFICATION.md（测试全绿 + D1/D2/D3 环境差距）、server/src 与 web/src 全量源码逐行通读

**方法**：以 PRD 条款为轴逐条对照代码；每条差距标注 编号 / 描述 / 依据 / 代码位置 / 影响面 / 严重度 / 建议归属卡。严重度口径：**阻断** = 不解决则 M1 无法开工或触碰安全红线；**高** = P0 核心价值或 BREAKING 未落地；**中** = P1/规格项缺失但不阻断；**低** = 工程/发布项。

---

## 0. 结论速览

- **差距总数：49**（阻断 5 / 高 17 / 中 18 / 低 9）
- **测试基线**：server 64/64、web 34/34、web build、e2e 18/18 全绿（M0-VERIFICATION §一）——「功能存在 ≠ 功能可用」，本矩阵即功能级落差清单。
- **已实现且应保留**：行程耗电公式（AC-6.3）、FIFO 批次入池公式含充损（AC-7.2）、行程边界状态机（AC-12.1a）、轮询捕获基线、站点聚合统计（AC-8.2）、PWA 安装体验（US-14）、AES-256-GCM 密钥落盘、401 错误格式、UTC naive 时间处理、FIFO slices 明细结构、精度双轨（cost_cny_precise）。
- **阻断级缺口（5 项，M1 必须先补）**：

- GA-01｜无本地 SQLite 持久层
- GA-02｜只读强制未实现
- GA-03｜无 /setup 初始化向导与首个管理员注册
- GA-04｜无双模数据源接入向导
- GA-05｜多车隔离缺失且 car_id 硬编码

---

## 1. 差距矩阵（统一编号 GA-01 … GA-49）

> 编号说明：GA-xx 为本矩阵统一编号；PM_AUDIT 的 G1-G11 / B1-B5 与 M0-VERIFICATION 的 D1-D3 已映射并入（见 §2、§5），原文保留可追溯。

### 1.1 阻断级（5）

| 编号 | 严重度 | 差距描述 | PRD/契约依据 | 代码位置（文件:行） | 影响面 | 建议归属卡 |
|---|---|---|---|---|---|---|
| GA-01 | 阻断 | 无本地 SQLite 持久层：自身数据落在 server/data/state.json（JSON 文件），PRD 要求的 /data/ahatesla.db 单文件卷挂载不存在；账号凭据、加密渠道密钥、Web Push 订阅、电价规则、FIFO 批次消耗记录、报告快照、事件日志均无 SQLite 落点 | PRD §7.1、§2.3；API_CONTRACT 数据源节 | server/src/core/state.mjs L33-96（statePath/saveState）、server/src/core/secret-box.mjs L9 | M1 全部卡（t_46fd8a8a）依赖此层；报价快照/FIFO 记录/事件日志无法落库 | t_46fd8a8a |
| GA-02 | 阻断 | 只读强制未实现：连接池未做元数据只读探测（has_table_privilege/has_schema_privilege），每 Session 未 SET default_transaction_read_only=on，应用侧无任何只读保障 | PRD AC-2.4、§7.2；契约 §1 /setup/test-connection | server/src/core/db.mjs L6-37（createDb 仅建连接）、无 setup 路由 | 安全红线（只读）无强制兜底；误配可写账号将直接违反红线 | t_3f9fe52a |
| GA-03 | 阻断 | 无 /setup 初始化向导与首个管理员注册：当前首个账号在服务端首启时生成随机密码并打印到日志（违反 AC-1.4 不得依赖日志打印密码），前端无 SetupPage，注册路由不关闭 | PRD AC-1.4、AC-3.1、§6.2、§6.3 P1 | server/src/index.mjs L37-47（bootstrap 打印初始密码）、web/src/App.tsx L24-36（无 /setup）、web/src/pages/LoginPage.tsx | US-1/US-3/P1 全缺；新人无法自助初始化 | t_3f9fe52a |
| GA-04 | 阻断 | 无双模数据源接入向导：无 POST /api/setup/datasource、无 /setup/test-connection 四级校验（可达性/凭据/库存在/只读）、无 /setup/car-discovery 车辆发现、无 TeslaMate 授权深链、:4000 反代保护缺失 | PRD US-2 全条、US-4 AC-4.1/4.3、§6.3 P1 Step2；契约 §1 | server/src/index.mjs L64-83（无 setup 路由）、web/src（无 setup 页） | US-2/US-4/P1 全缺；存量用户无法零侵入接入 | t_3f9fe52a |
| GA-05 | 阻断 | 多车隔离缺失且 car_id 硬编码：getDrivingState 硬编码 s.car_id=1（B1）；getCarSnapshot 仅按 display_priority LIMIT 1（G8）；所有核心 SQL 无 car_id 过滤，无主绑定车辆概念 | PRD AC-2.3、§7.1；PM_AUDIT §二 B1、§三 G8 | server/src/core/teslamate-queries.mjs L85、L30-31；L93/L104/L123/L162 等全部 drives 查询 | car_id≠1 的库车辆状态判定错误；多车数据串入同一 FIFO 池 | t_3f9fe52a |

### 1.2 高（17）

| 编号 | 严重度 | 差距描述 | PRD/契约依据 | 代码位置（文件:行） | 影响面 | 建议归属卡 |
|---|---|---|---|---|---|---|
| GA-06 | 高 | 契约 v2 BREAKING B1 未落地：金额字段仍为 costCny/totalCostCny/fuelCostCny/defaultRateCnyPerKwh，前端 types/format 亦为 CNY 命名（B1'） | PRD AC-9.1；契约 §0 多币种、§9 B1/B7 | pricing-ledger L26/36/44/142 等；dashboard-routes L31/L99/L109；charging-routes L21/L79-80；pricing-routes L12；state.mjs L14；web/src/types/index.ts L15/33/55/58/59；web/src/utils/format.ts L7-10 | 全链路字段重命名 + 前端同步；契约不符 | t_59fea908（含契约同步） |
| GA-07 | 高 | 多币种/货币单位配置缺失：无 currency 实例配置（符号 ¥/$/€/£ 不可配），无 /api/settings 读写 currency/distanceUnit/timezone | PRD US-9 AC-9.1/9.2、§2.3；契约 §1 | server/src（无 settings 路由）、web/src/utils/format.ts L7-10 固定 ¥ | US-9 全缺；海外用户不可用 | t_59fea908 |
| GA-08 | 高 | 推送体系仅飞书单渠道：无统一 Notifier 接口（AC-10.1），无 Web Push（US-11），无 Telegram，渠道配置仅 feishu 一项；AC-12.2 多渠道并行/单渠道失败隔离无实现 | PRD US-10/11/12 AC-10.1/10.2/12.2；契约 §6 | server/src/core/feishu.mjs 全文、server/src/api/channel-routes.mjs L6-10、web/src/pages/PushPage.tsx | US-10/11 全缺；默认推送渠道（Web Push）不存在 | t_9f7a9148 |
| GA-09 | 高 | chargingStart/chargingDone 事件未接线：observeChargingStarted 返回值被调用方忽略（B4），observeChargingDone 在轮询循环中从未被调用 → 实际仅 tripEnd 会触发推送 | PRD US-12 AC-12.1；PM_AUDIT §五 B4 | server/src/core/trip-monitor.mjs L212-236、L171-193；server/src/index.mjs L176-181 | US-12 五类事件仅 1 类可用 | t_7d484459 与 t_f99102c4 |
| GA-10 | 高 | 充电侧冷启动水线缺失：last_charging_id 初始为 0，首次接入时存量未闭合 charging_process 会被当新事件（B2），违反 AC-12.1b 防历史风暴 | PRD AC-12.1b；PM_AUDIT §五 B2 | server/src/core/trip-monitor.mjs L23-24、L179-182 | 存量用户接入瞬间可能收到僵尸充电事件 | t_7d484459 |
| GA-11 | 高 | 周报/月报完全缺失：无报告生成、无定时调度（无 weekly/monthly 触发）、无报告归档与 /reports 页；pushRules 有 weeklyReport/monthlyReport 开关但无消费者 | PRD US-13 全条、§6.2/§6.3 P5；契约 §6 报告端点 | server/src（无报告模块）、web/src（无 /reports）、server/src/index.mjs L176-181 | US-13/P5 全缺 | t_f99102c4 |
| GA-12 | 高 | 推送时效 SLA 不可验证：事件日志无 deliveryMs 埋点，无法核对 AC-12.3 的 60 秒口径 | PRD AC-12.3；契约 §7 /api/system/events | server/src/core/events.mjs 全文、server/src/index.mjs L186-189 | 无法验收 60s SLA | t_f99102c4 |
| GA-13 | 高 | 驻车损耗事件驱动扣减完全缺失（G3）：无驻车能耗支出冲抵 FIFO、无 >0.5kWh 阈值/负损耗过滤 | PRD AC-7.5、§7.3；契约 §8.3 | server/src/core/pricing-ledger.mjs 全文（无 parking 相关逻辑） | 月度账本与充电总账无法对齐；P2 模块3 构成小字无数据源 | t_d9fb43bd |
| GA-14 | 高 | 账本修正窗口缺失：无 charge_cost_overrides 表/逻辑、无 PUT /api/charging/:id/cost、无 7 天内异步重算、无已校准标注 | PRD AC-7.6、§7.4；契约 §4/§8.4 | server/src（无该路由）、web/src/pages/ChargingPage.tsx（无录入入口） | AC-7.6 全缺 | t_d9fb43bd |
| GA-15 | 高 | 四层回退仅三层：缺第①层 AhaTesla 本地手动录入（SQLite charge_cost_overrides），现仅有 stated→geofence→default | PRD AC-7.1；契约 §8.1；PM_AUDIT §三 G5 | server/src/core/pricing-ledger.mjs L20-50 | 计价优先级不完整 | t_d9fb43bd |
| GA-16 | 高 | 历史重算缺失：无 POST /api/ledger/recalculate、无 job 进度查询、无设置页【重算历史账本】按钮（G6，仅 defaultRateHistory 雏形 L82-94） | PRD AC-7.3；契约 §5/§8.5 | server/src/core/pricing-ledger.mjs L82-94；无 recalc 路由；web/src/pages/PricingPage.tsx | US-7 AC-7.3 全缺 | t_d9fb43bd |
| GA-17 | 高 | 油车基准硬编码且与 PRD 不符：FUEL_REFERENCE 用 7.8 元/L（PRD 默认 8.20 元/L），不可配置，月报/卡片无“对比基准 8.0L/100km @ 8.2元/L”标注 | PRD AC-7.4、§8.2 Q1；契约 §1 fuelBaseline | server/src/api/dashboard-routes.mjs L12-18、L81 | 油车对比金额偏差，且不可自定义 | t_d9fb43bd |
| GA-18 | 高 | 无 /reports 路由与页面（G11）；契约 §6 GET /api/reports、/:id、/generate 全缺 | PRD §6.2/§6.3 P5、AC-13.3；契约 §6 | web/src/App.tsx L24-36（无 /reports）、server/src（无 reports 路由） | P5/AC-13.3 全缺 | t_f99102c4 |
| GA-19 | 高 | 设置页仅“改密码”，缺分组1（数据源健康/只读盾章）、分组2（货币/距离单位/默认电价/围栏分时/油车基准/重算按钮）、分组3（事件×渠道矩阵） | PRD §6.3 P6、US-9/7.4/10；契约 §1/§5/§6 | web/src/pages/SettingsPage.tsx、web/src/pages/PushPage.tsx（规则为单事件布尔） | P6 大部分缺 | t_59fea908 与 t_07731e4b |
| GA-20 | 高 | 分时电价（TOU）缺失（G4）：geofence 只取 cost_per_unit 单值，无谷/峰两档与时跨段比例计价，无 PUT /api/pricing/locations/:id | PRD §6.3 P4/P6、AC-7.1③；契约 §5/§8.1 | server/src/core/teslamate-queries.mjs L217-226、server/src/api/pricing-routes.mjs | 围栏分时计价无法配置 | t_d9fb43bd |
| GA-21 | 高 | 上游合规风险未消除（R1）：pricing-ledger/trip-monitor/feishu 文件头仍保留 tesla-butler 衍生注释（B5），上游无 LICENSE | PRD §8.1 R1、AC-15.3；PM_AUDIT §三 G2、§五 B5 | server/src/core/pricing-ledger.mjs L13-15/L108、trip-monitor.mjs L4-7、feishu.mjs L3-4 | 开源发布法务阻断；需重写而非移植 | t_f6ebddf1 与 t_b41ff1ab |
| GA-22 | 高 | MQTT 未按“显式配置才启用”：始终尝试连接默认 mqtt://127.0.0.1:1883（非可选增强），且订阅 topic 硬编码 teslamate/cars/1/... | PRD AC-5.1、§7.1；契约 B8 | server/src/index.mjs L29、L132-146 | 存量用户被强制触达 MQTT；多车/非 1 车号失效 | t_7d484459 与 t_07731e4b |

### 1.3 中（18）

| 编号 | 严重度 | 差距描述 | PRD/契约依据 | 代码位置（文件:行） | 影响面 | 建议归属卡 |
|---|---|---|---|---|---|---|
| GA-23 | 中 | 行程详情 P3 缺：FIFO 批次扣减明细卡、油车对比栏、能效达成率标签、双层联动曲线（速度/海拔/功率/SoC 游标联动）、环境剖析微卡片（均温/空调估算/均速/巡航） | PRD §6.3 P3 模块1-4；契约 §3 | web/src/pages/TripDetailPage.tsx（仅 4 张 StatCard + 端点）、server/src/api/trips-routes.mjs L117-133 | P3 核心价值卡缺失 | t_c7dbbc73 与 t_59fea908 |
| GA-24 | 中 | 契约 §3 GET /api/trips/:id 返回结构与目标态不符：返回 route:[{t,lat,lng}] 而非 polyline（LTTB≤300），缺 fifo/fuelComparison/efficiency/environment | PRD §6.3 P3、§6.5；契约 §3 | server/src/api/trips-routes.mjs L124-132 | 前端无法实现 P3 目标交互 | t_59fea908 |
| GA-25 | 中 | 行程能耗口径未在 UI 标注（AC-6.3 要求标注“基于起止表显续航差 × cars.efficiency”，并可选 battery_level 校核）——算法本身已正确 | PRD AC-6.3；PM_AUDIT §一 | web/src/pages/TripsPage.tsx / TripDetailPage.tsx（无口径文案） | 口径不可见，用户无法核对 | t_59fea908 |
| GA-26 | 中 | GPS 降采样为等距抽样而非 LTTB（G7），且未限制单图 ≤300 点 | PRD §6.5-3；PM_AUDIT §三 G7 | server/src/core/teslamate-queries.mjs L195-201、L185-192（maxPoints=500） | 长途行程渲染性能与保真度不达标 | t_9a126806 与 t_c7dbbc73 |
| GA-27 | 中 | 地图为内联 SVG 等距投影折线，无底图瓦片源、无 WGS-84→GCJ-02 转换、无起终点地址联动 | PRD §6.3 P3 模块2、§6.5-4 | web/src/components/RouteMap.tsx 全文 | P3 路线图体验不达标（无地理底图） | t_c7dbbc73 |
| GA-28 | 中 | 充电页 P4 缺：月份筛选 DatePicker、单次充电详情模态（功率曲线/峰值打点）、充电损耗与真实效率模块、费用来源标签（已录入/规则计价/默认估算）、【录入实付电费】入口；契约缺 GET /charging/:id 与 PUT /:id/cost | PRD §6.3 P4 视图A/单次详情；契约 §4 | web/src/pages/ChargingPage.tsx 全文、server/src/api/charging-routes.mjs L31-38 | P4 大部分缺 | t_c7dbbc73 与 t_d9fb43bd |
| GA-29 | 中 | 单价精度展示不符：充电/地点单价以 toFixed(2) 展示，§7.3 要求单价 3~4 位小数（后端内部 round(...,4) 已对） | PRD §7.3；契约 §0 | web/src/pages/ChargingPage.tsx L40/L56/L97、PricingPage.tsx L116 | 精度规范未贯彻到展示层 | t_59fea908 |
| GA-30 | 中 | 仪表盘 P2 缺模块：24h 状态时间轴（模块2）、用车日历热力图（模块4）、月度构成小字（行驶¥/驻车¥，模块3）、状态持续时长与“数据同步于 N 分钟前”、最近活动混合流（模块5） | PRD §6.3 P2 模块2/3/4/5；契约 §3 | web/src/pages/DashboardPage.tsx 全文 | P2 洞察模块缺失 | t_9a126806 与 t_59fea908 |
| GA-31 | 中 | 系统状态缺 latencyMs 与 readonlyVerified；MQTT 项恒定展示（契约 B8 要求仅配置时返回） | PRD AC-5.1、§7.2；契约 §7、§9 B8 | server/src/api/dashboard-routes.mjs L120-140、web/src/pages/SystemPage.tsx L64-69 | US-5 部分缺 | t_07731e4b |
| GA-32 | 中 | 数据源异常横幅告警缺失（AC-5.2/§6.1/§6.4）：无 /api/system/health-lite 匿名探活、无全站黄底横幅、无失联告警推送 | PRD AC-5.2、§6.1/§6.4；契约 §7 | server/src（无 health-lite）、web/src（无横幅）、web/src/layouts/AppLayout.tsx | US-5 AC-5.2 全缺 | t_07731e4b |
| GA-33 | 中 | 会话模型仅单 JWT 24h：无 Refresh Token/30d 长效、无 /api/auth/refresh、无 /api/auth/sessions/revoke-all、无主动吊销 | PRD AC-3.2；契约 §2、§9 B3 | server/src/api/auth.mjs L8、auth-routes.mjs L8-11、web/src/api/client.ts（无 401→refresh） | PWA 掉登录态；AC-3.2 缺 | t_3f9fe52a 与 t_59fea908 |
| GA-34 | 中 | 登录失败限速缺失：无“连续 5 次失败锁 15 分钟”逻辑 | PRD AC-3.3；契约 §2 | server/src/api/auth-routes.mjs L14-24 | 暴力破解防护缺 | t_3f9fe52a |
| GA-35 | 中 | 设置 P6 分组1 缺：只读模式运行中安全盾章、连接池活跃数、Ping 延迟、【立即重新同步元数据】 | PRD §6.3 P6 分组1 | web/src/pages/SystemPage.tsx / SettingsPage.tsx | P6 分组1 缺 | t_07731e4b |
| GA-36 | 中 | 契约 §1 GET/PUT /api/settings 缺失（currency/distanceUnit/timezone/fuelBaseline 均无端点与存储） | 契约 §1；PRD AC-9.1/7.4 | server/src/index.mjs L64-83（无 settings）、state.mjs（无 currency/unit/tz） | 多币种/单位/时区/油车基准无落点 | t_46fd8a8a 与 t_59fea908 |
| GA-37 | 中 | 路由与布局偏差：充电路由 /charging（PRD 为 /charges）；移动端底部 TabBar 7 项（PRD 要求 4 项 概览/行程/充电/设置）；桌面缺顶部轻量栏 | PRD §6.1、§6.2 | web/src/App.tsx L30、web/src/layouts/AppLayout.tsx L18-26/L113-138 | 布局与路由规格不符（E2E 亦按现状固化） | t_59fea908 |
| GA-38 | 中 | 启动期 TeslaMate schema 校验缺失（R4）：表结构变更无启动期探测与可读报错，无固定版本范围声明 | PRD §7.5 R4；契约 数据源节 | server/src/core/db.mjs、server/src/index.mjs（无 schema 校验） | TeslaMate 升级后静默失效 | t_46fd8a8a 与 t_07731e4b |
| GA-39 | 中 | trip-monitor 状态未持久化：index.mjs 每次以 state:{} 新建 monitor，sent_keys/pending_events 重启即丢 → 可能重复推送，违反 §7.4 崩溃自愈 | PRD §7.4；契约 §8.6 | server/src/index.mjs L174-182 | 重启后重复推送/水线重算 | t_7d484459 |
| GA-40 | 中 | 连接方式分级错位：主线文档/部署以 socat 桥接为准（deploy/bridge-compose.yml），PRD §7.1 要求主线为 external network 直连 / 跨机局域网直连，socat 仅高级附录 | PRD §7.1、§8.2 Q2 | deploy/bridge-compose.yml、README.md、CLAUDE.md | 与既定决策不符，存量用户方案偏离 | t_ea81a202 |

### 1.4 低（9）

| 编号 | 严重度 | 差距描述 | PRD/契约依据 | 代码位置（文件:行） | 影响面 | 建议归属卡 |
|---|---|---|---|---|---|---|
| GA-41 | 低 | 双发行版 compose 缺失（AC-15.1）：仅有 deploy/bridge-compose.yml，无全栈版（TeslaMate+Grafana profile+只读用户自动创建）与 connect 版 | PRD US-15 AC-15.1、US-1 AC-1.1/1.2/1.3；契约 数据源节 | deploy/ 目录（仅 bridge-compose.yml） | US-1/US-15 部署工程缺 | t_ea81a202 |
| GA-42 | 低 | LICENSE 文件缺失（AC-15.3 确立 MIT；且上游 tesla-butler 无 LICENSE，R1 未闭环） | PRD AC-15.3、§8.1 R1 | 仓库根（无 LICENSE） | 开源合规未落地 | t_d8cf7906 与 t_b41ff1ab |
| GA-43 | 低 | 缺 .env.example（AC-15.4 要求列出全部可配置项；README 却指引 cp .env.example .env） | PRD AC-15.4 | 仓库根/server（无 .env.example）、README.md 快速开始 | 新人按文档执行即失败 | t_d8cf7906 |
| GA-44 | 低 | 无 gitleaks 扫描配置/CI（AC-15.4） | PRD AC-15.4 | 仓库根（无 gitleaks 配置） | VIN/Token 泄露防护未自动化 | t_d8cf7906 |
| GA-45 | 低 | README 与事实矛盾：称核心算法“MIT 口径、保留出处注释”，与 R1（上游无 LICENSE）冲突；功能清单含未实现项（Card 2.0/双通道/批次分摊仅部分） | PRD §8.1 R1、AC-15.2 | README.md 全文、CLAUDE.md | 发布文档误导，法务风险 | t_d8cf7906 与 t_b41ff1ab |
| GA-46 | 低 | 环境工程差距 D1/D2/D3：根目录无 playwright config 兜底（D1，需 cd e2e）、e2e 凭据不可复现（D3，缺 reset-password 脚本）；D2 已修（npm start 已带 --env-file） | M0-VERIFICATION §二 D1/D2/D3 | package.json（test:e2e 已加 --config）、scripts/（空）、e2e/ | 新人/CI 无法一键跑 e2e | t_02f82541 |
| GA-47 | 低 | /api/push/env（匿名 https 检测，AC-11.0 前端置灰依据）缺失 | PRD AC-11.0；契约 §6 | server/src/index.mjs（无该路由）、web/src | AC-11.0 缺 | t_9f7a9148 |
| GA-48 | 低 | 实时通道缺失：无 WebSocket /ws（契约 §7 可选）、前端无轮询兜底（除系统页 refetchInterval） | 契约 §7 | server/src（无 /ws）、web/src/api/client.ts | 可选增强缺失（轮询已满足基线） | t_f99102c4 与 t_9f7a9148 |
| GA-49 | 低 | i18n 架构未预留（§2.2 G4 要求架构按 i18n 设计，英文 v1.x），前端文案硬编码中文无 i18n 层 | PRD §2.2 G4、§2.3 | web/src（无 i18n 框架/资源） | v1.x 英文化改造成本高 | t_d8cf7906 |

---

## 2. PM_AUDIT 发现落座表（可追溯）

| PM_AUDIT 编号 | 内容 | 落入 GA |
|---|---|---|
| B1 | getDrivingState 硬编码 car_id=1 | GA-05 |
| B1' | 前端 CNY 命名面（fmtCny + costCny 系） | GA-06 |
| B2 | charging 侧冷启动水线缺失 | GA-10 |
| B3 | 运算符优先级隐患（trip-monitor L220，`(a&&b) or c` 实解析为 `(a&&b)` 或 `c`） | GA-09（同属该轮询分支重写范围） |
| B4 | chargingStart 事件未接线 | GA-09 |
| B5 | tesla-butler 衍生注释（trip-monitor/feishu 第二处） | GA-21 |
| G1 | costCny 命名遍布 | GA-06 |
| G2 | 上游衍生注释（L13-15/L108） | GA-21 |
| G3 | 无驻车损耗 | GA-13 |
| G4 | 无分时电价 | GA-20 |
| G5 | 无本地补录层 | GA-14, GA-15 |
| G6 | 无历史重算 | GA-16 |
| G7 | 降采样非 LTTB | GA-26 |
| G8 | getCarSnapshot LIMIT 1 无选车 | GA-05 |
| G9 | listChargingForStats 全表载入内存 | GA-01/GA-38（10 万行规模需分页重算，M1 观察项） |
| G10 | states 表覆盖率待 Live 验证 | t_3689fa50（Live 验证卡） |
| G11 | 前端无 /setup 与 /reports | GA-03, GA-18 |

---

## 3. PRD 条款覆盖对照

### 3.1 用户故事（US-1~15）

| 条款/项 | 状态 | 说明 | 关联 GA |
|---|---|---|---|
| US-1 全新用户一键部署 | 未实现 | AC-1.1~1.4 全缺（无全栈 compose/无只读用户/无 /setup） | GA-03, GA-41 |
| US-2 存量用户零侵入接入 | 部分实现 | 桥接容器有；向导/四级校验/car_id 隔离/只读探测全缺 | GA-02, GA-04, GA-05 |
| US-3 首账号注册与管理员即位 | 部分实现 | AC-3.4 已实现；AC-3.1 部分；AC-3.2/3.3 缺 | GA-03, GA-33, GA-34 |
| US-4 Tesla 授权经由 TeslaMate | 部分实现 | AC-4.2 已实现（无 Fleet API/Token）；AC-4.1/4.3 缺 | GA-04 |
| US-5 数据源健康可见 | 部分实现 | status 基本项有；latencyMs/readonlyVerified/条件 MQTT/失联横幅缺 | GA-31, GA-32 |
| US-6 行程列表与详情 | 部分实现 | 列表/分页/筛选/route 有；polyline(LTTB)/FIFO 明细/环境/效率缺，口径未标注 | GA-23, GA-24, GA-25, GA-26 |
| US-7 FIFO 电价批次账本 | 部分实现 | AC-7.2 公式已实现（含充损）；AC-7.1/7.3/7.5/7.6 缺或部分 | GA-13, GA-14, GA-15, GA-16, GA-17 |
| US-8 充电账本与站点统计 | 部分实现 | AC-8.2 已实现（month/all）；AC-8.1 缺月份筛选/详情/精度 | GA-28, GA-29 |
| US-9 多币种计价 | 未实现 | AC-9.1/9.2 全缺 | GA-06, GA-07 |
| US-10 推送渠道抽象 | 部分实现 | AC-10.3 已实现（AES-GCM）；AC-10.1/10.2 缺（仅飞书） | GA-08, GA-19 |
| US-11 Web Push | 未实现 | AC-11.0~11.3 全缺 | GA-08, GA-47 |
| US-12 实时事件推送 | 部分实现 | AC-12.1a 状态机与轮询基线已实现；仅 tripEnd 推送、水线充电侧缺、SLA 埋点缺 | GA-09, GA-10, GA-12, GA-22 |
| US-13 周报与月报 | 未实现 | AC-13.1~13.3 全缺 | GA-11, GA-18 |
| US-14 PWA 安装体验 | 已实现 | manifest/图标/双视口 E2E/SW 均在（SW 无 push 处理，归 US-11） | - |
| US-15 双发行版与文档 | 部分实现 | README 有；双 compose/LICENSE/.env.example/gitleaks 缺 | GA-41, GA-42, GA-43, GA-44, GA-45 |

### 3.2 页面规格（§6.2 / §6.3 P1-P6）

| 条款/项 | 状态 | 说明 | 关联 GA |
|---|---|---|---|
| P1 初始化向导 /setup | 未实现 | 从零新建（非改造） | GA-03, GA-04 |
| P2 仪表盘 / | 部分实现 | 模块1/3/5 部分有；模块2/4 与时长/构成缺 | GA-30 |
| P3 行程详情 /trips/:id | 部分实现 | 缺 FIFO 明细/联动曲线/效率/环境；地图无底图 | GA-23, GA-24, GA-27 |
| P4 充电账本 /charges | 部分实现 | 缺详情模态/曲线/损耗/来源标签/月筛选/补录入 | GA-28, GA-29 |
| P5 报告页 /reports | 未实现 | 页与端点全缺 | GA-11, GA-18 |
| P6 系统设置 /settings | 部分实现 | 缺分组1/2/3 主体与分时电价/重算 | GA-19, GA-20, GA-35, GA-36 |

### 3.3 架构基线（§7.1）与非功能（§7.2-§7.5）

| 条款/项 | 状态 | 说明 | 关联 GA |
|---|---|---|---|
| §7.1 本地 SQLite /data/ahatesla.db | 未实现 | 现为 JSON state.json | GA-01 |
| §7.1 轮询事件捕获基线 15~30s | 已实现 | 30s 轮询；冷启动水线行程侧已实现 | - |
| §7.1 MQTT 可选增强（显式配置才启用） | 部分实现 | 始终尝试连接 + topic 硬编码 car 1 | GA-22 |
| §7.1 连接方式分级（external/LAN 主线，socat 附录） | 部分实现 | 主线以 socat 桥接为准 | GA-40 |
| §7.2 只读元数据探测 + 会话锁 | 未实现 | 连接池无任何只读强制 | GA-02 |
| §7.2 无车辆控制 / 无 Fleet API | 已实现 | AC-4.2 通过 | - |
| §7.2 渠道密钥 AES-256-GCM + APP_SECRET_KEY | 部分实现 | AES-GCM 已实现；密钥来源为 data/secret.key 而非 .env APP_SECRET_KEY | GA-01 |
| §7.3 精度规范（金额2/单价3~4位） | 部分实现 | 后端已对；展示层单价 2 位 | GA-29 |
| §7.4 单渠道失败隔离 / 崩溃自愈 | 部分实现 | 仅单渠道；监测状态未持久化 | GA-39 |
| §7.5 schema 校验 / 测试纪律 | 部分实现 | 测试全绿；schema 校验缺 | GA-38 |

---

## 4. 未实现 / 部分实现的 PRD 条款清单（机器可读）

- **未实现**：AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-2.2, AC-2.4, AC-3.2, AC-3.3, AC-4.1, AC-4.3, AC-5.2, AC-7.3, AC-7.5, AC-7.6, AC-9.1, AC-9.2, AC-10.1, AC-11.0, AC-11.1, AC-11.2, AC-11.3, AC-12.3, AC-13.1, AC-13.2, AC-13.3, AC-15.1, AC-15.3, AC-15.4, US-11, US-13, P1, P5
- **部分实现**：AC-2.1, AC-2.3, AC-3.1, AC-5.1, AC-6.1, AC-6.2, AC-6.3, AC-7.1, AC-7.4, AC-8.1, AC-10.2, AC-12.1, AC-12.1b, AC-12.2, AC-15.2, US-2, US-4, US-6, US-7, US-8, US-10, US-12, P2, P3, P4, P6, §7.1, §7.2, §7.3, §7.4, §7.5
- **已实现**：AC-3.4, AC-4.2, AC-7.2, AC-8.2, AC-10.3, AC-12.1a, AC-14.1, AC-14.2, AC-14.3, US-14

---

## 5. 环境/工程差距（M0-VERIFICATION §二，D1-D3）

| 编号 | 内容 | 状态 |
|---|---|---|
| D1 | 仓库根无 playwright config，`npx playwright test` 误扫 web/tests（假失败）；根 package.json 已加 `test:e2e --config e2e/playwright.config.mjs`，config testDir 已明确 | 部分修复（GA-46） |
| D2 | `npm start` 不加载 .env 导致真库接口 500；已修为 `node --env-file=.env src/index.mjs` | 已修复 |
| D3 | e2e 凭据不可复现（初始密码仅首启日志一次）；缺 `scripts/e2e-reset-password.mjs` | 未修复（GA-46） |

---

## 6. 出口条件自检（卡 t_c03ab81d）

- 15 个 US：全部覆盖（§3.1，含 US-14 标「已实现」）✅
- 6 个页面 P1-P6：全部覆盖（§3.2）✅
- §7.1 架构基线（SQLite/轮询/连接分级）：覆盖（§3.3）✅
- §7.2-§7.5 非功能：覆盖（§3.3）✅
- 每条差距均含：编号 / 描述 / 依据 / 代码位置 / 影响面 / 严重度 / 建议归属卡 ✅

**进 M1 建议**：先落 GA-01（SQLite）→ GA-02/03/04/05（向导、只读强制、car_id 绑定），再按 M1 既有卡推进；GA-06（契约 B1 去 CNY）与前端同步点集中在 web/src/utils/format.ts + types/index.ts。
