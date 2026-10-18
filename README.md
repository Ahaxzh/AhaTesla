<div align="center">

# AhaTesla · 特斯拉小管家

**Tesla 行程 · 电费 · 充电站账本 — 自托管 Web + 多渠道推送**

记账与行程边界算法的设计灵感来自 [tesla-butler](https://github.com/manwithshit/tesla-butler) · 参考 AhaSlit 前后端分离架构

</div>

---

## 功能
- 🚗 **行程记录**：里程、能耗、路线图（**速度着色 + 悬停速度提示**）、FIFO 批次扣减明细、油车对比（数据源：TeslaMate PostgreSQL，只读）
- ⚡ **充电账本**：按充电站单价（geofences，支持分时电价 TOU）自动计费，批次分摊算法，功率曲线 + 桩端效率，实付补录
- 💰 **月度账单**：里程 / 电费 / 油车费用对比、驻车哨兵损耗、含行驶/驻车费用构成
- 📊 **仪表盘**：24h 状态时间轴、用车热力图、状态卡（行驶中/充电中/哨兵/睡眠语义化）
- 📄 **报告推送**：**每日早报**（昨日汇总 + 上周同日对比 + 异常提醒）、周报/月报（归档不可变快照）
- 🔔 **多渠道推送**：Web Push（**iPhone 桌面 PWA 可收通知**）/ Telegram / 飞书，6 事件 × 3 渠道独立矩阵；可选接入自己的 OpenAI 兼容模型润色文案（默认关闭，无模型也有完整模板）
- 🌓 **外观**：明暗主题（跟随系统/浅色/深色）· 中英界面
- 📱 **Web / PWA**：iPhone 添加到主屏幕，深色科技风 UI，移动优先
- 🔐 **登录认证**：单用户 JWT 双 Token（Access 24h + Refresh 30d）+ httpOnly cookie，scrypt 密码哈希，失败锁定

## 快速开始（二选一）

> 以下命令都在**部署机**（跑 Docker 的那台）执行；浏览器操作在你的电脑/手机上。

### 轨道 A · 全新用户（还没有 TeslaMate）— 一条命令全套

```bash
git clone https://github.com/Ahaxzh/AhaTesla.git && cd AhaTesla

# 1. 生成并填入 2 个密钥（文件里附了可直接复制的生成命令）
cp deploy/.env.example.fullstack deploy/.env && vim deploy/.env

# 2. 一条命令拉起全套（AhaTesla + TeslaMate + PostgreSQL + Mosquitto）
docker compose -f deploy/fullstack-compose.yml --profile fullstack up -d --build
```

然后浏览器完成初始化（约 3 分钟）：

1. 打开 `http://<部署机IP>:18500` → 注册管理员（第一位注册即管理员）
   - 远程主机部署时 18500/4000 默认只绑了 127.0.0.1，需在 compose 里放开或走反代（文件内有注释）
2. 向导会引导你打开 `http://<部署机IP>:4000` —— 用**特斯拉账号**登录 TeslaMate（这是全栈版唯一需要出向导的一步，登录完回到 AhaTesla 页面等车出现即可）
3. 车辆确认 → 账本/推送渠道（可跳过）→ 完成，仪表盘开始出数据

### 轨道 B · 已有 TeslaMate — 三步接入（不动你现有任何容器）

```bash
# 1. 确认你的 TeslaMate 网络名（官方 compose 默认就是 teslamate_default）
docker network ls | grep teslamate

# 2. 复制环境文件（一般一行都不用改）
cp deploy/.env.example.connect deploy/.env

# 3. 起容器（自动挂入你的 teslamate 网络，直连其数据库）
docker compose -f deploy/connect-compose.yml up -d --build
```

然后浏览器打开 `http://<部署机IP>:18500` → 向导选「**已有 TeslaMate**」：

1. 填你的 teslamate 库密码（就是你 TeslaMate `docker-compose.yml` / `.env` 里的 `DATABASE_PASS`；用户名默认 `teslamate`）
2. AhaTesla 用它**自动创建只读账号**并完成四级校验：网络可达 → 数据库认证 → 只读安全 → 发现车辆
3. 多车用户在下一步选择要接入的车 → 完成

**降级路径**（向导里都有对应提示，这里先说清楚）：

| 情况 | 怎么办 |
|---|---|
| 自动建只读账号失败（权限不足等） | 向导给出一条**可复制的 SQL**，粘到任何能连库的终端执行（或 `docker compose -f <你的teslamate>/docker-compose.yml exec database psql -U teslamate -d teslamate` 后粘贴），回来点「我已执行」 |
| 网络名不是 `teslamate_default` | `docker network connect <你的网络名> ahatesla-app`，或改 connect-compose.yml 里 `networks.teslamate.name` |
| TeslaMate 在另一台机器 | 编辑 `deploy/.env` 填 `DB_URL=postgres://...@<对端IP>:5432/teslamate`（对端 5432 需对你可达），并删掉 compose 里 teslamate 网络段 |
| 只读校验失败（你填了管理账号） | 属于预期拦截：AhaTesla 拒绝用可写账号直连，回上一步走「自动建号」 |

### 部署后：iPhone 收通知（可选）

任意 HTTPS 反代（如 NPM）指向 18500 → Safari 打开 → 分享 → 添加到主屏幕 → 推送页开启 Web Push（iOS ≥ 16.4）。反代配置见 [`deploy/NPM-SETUP.md`](deploy/NPM-SETUP.md)。

## 架构

```
Tesla(车) ←→ TeslaMate(车辆协议/Token) → PostgreSQL ←只读─ AhaTesla server(:18500)
                                                      ↘ Mosquitto MQTT(可选,事件提速) 
server/ Node22 ESM（API+JWT+静态托管+推送引擎） ← web/ React19+Vite+TS+Tailwind+PWA
```

- 对 teslamate 库**严格只读**（专用账号 + 启动时主动探测账号确无写权限）
- AhaTesla 自身数据（账号/推送规则/电价历史/密钥）存本地 SQLite，密钥 AES-256-GCM 加密落盘
- 无公共后端、无遥测、不给车辆发任何控制指令

## 测试
- `server`: `npm test` — 单测（计价账本/API路由/认证/推送引擎），`node --test test/live` 连真库只读
- `web`: `npm test` — vitest 组件测试（每页面/每按钮/双视口），`npm run build`
- E2E: Playwright 全链路，见 `e2e/`

### 跑 e2e（Playwright）

一键（推荐，自动处理密码注入与 /setup 向导隔离实例）：

```bash
bash scripts/run-e2e.sh          # 常规用例 + setup 向导用例
```

或手动走密码注入流程（对常驻实例）：

```bash
AHATESLA_E2E_PASSWORD='e2e-tmp-password' node scripts/e2e-reset-password.mjs   # 注入(自动备份)
cd server && npm start                                                          # 重启生效
AHATESLA_E2E_PASSWORD='e2e-tmp-password' npm run test:e2e                        # 跑
node scripts/e2e-reset-password.mjs --restore                                   # 还原(再重启)
```

脚本幂等：重复注入不覆盖最初备份；`--restore` 无备份时安全退出；不打印密码明文。详见 `--help`。

## 目录
```
server/  Node 后端      web/ React 前端
deploy/  compose×3+Dockerfile+SQL+NPM   docs/  契约与架构(唯一真相源: API_CONTRACT.md)
e2e/     Playwright      scripts/ 工具脚本
```

## 安全红线
只读 teslamate 库 · 不发车辆命令 · VIN/GPS/Token 不进日志与 Git · secret AES-GCM 加密落盘 · 无公共后端/无遥测

## 致谢
行程边界状态机与电价批次账本的产品方向，灵感来自 [manwithshit/tesla-butler](https://github.com/manwithshit/tesla-butler)。本项目的实现按自有规格（`docs/PRD.md` / `docs/API_CONTRACT.md`）独立编写，未复制上游源码。
