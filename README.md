<div align="center">

# AhaTesla · 特斯拉小管家

**自托管的特斯拉行程 · 电费 · 充电账本 — Web(PWA) 与多渠道推送**

[![CI](https://github.com/Ahaxzh/AhaTesla/actions/workflows/ci.yml/badge.svg)](https://github.com/Ahaxzh/AhaTesla/actions/workflows/ci.yml)
[![Docker](https://github.com/Ahaxzh/AhaTesla/actions/workflows/docker.yml/badge.svg)](https://github.com/Ahaxzh/AhaTesla/actions/workflows/docker.yml)
[![ghcr](https://img.shields.io/badge/ghcr-ahaxzh%2Fahatesla-blue)](https://github.com/Ahaxzh/AhaTesla/pkgs/container/ahatesla)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](./README_EN.md)

</div>

---

AhaTesla 基于 [TeslaMate](https://github.com/teslamate-org/teslamate) 采集的数据,提供开箱即用的中文行程账本与充电成本核算:按充电站单价(支持分时电价)自动计费、FIFO 批次分摊、月度账单与每日报告,并通过 Web Push / Telegram / 飞书推送。对 TeslaMate 数据库**严格只读**,不向车辆发送任何控制指令,无公共后端、无遥测。

## 功能一览

| 模块 | 说明 |
|---|---|
| 🚗 行程记录 | 里程、能耗、路线图(速度着色 + 悬停速度提示)、FIFO 批次扣减明细、油车费用对比 |
| ⚡ 充电账本 | 按充电站单价(geofences,支持分时电价 TOU)自动计费,批次分摊算法,功率曲线 + 桩端效率,实付补录 |
| 💰 月度账单 | 里程 / 电费 / 油车对比、驻车哨兵损耗、行驶/驻车费用构成 |
| 📊 仪表盘 | 24h 状态时间轴、用车热力图、语义化车辆状态卡(行驶/充电/哨兵/睡眠) |
| 📄 报告推送 | 每日早报(昨日汇总 + 上周同日对比 + 异常提醒)、周报/月报(归档不可变快照) |
| 🔔 多渠道推送 | Web Push(iPhone PWA 可收)/ Telegram / 飞书,6 事件 × 3 渠道独立矩阵;可选接入 OpenAI 兼容模型润色文案 |
| 🌓 界面 | 明暗主题(跟随系统/浅色/深色)· 中英双语 |
| 📱 Web / PWA | iPhone 添加到主屏幕,移动优先,深色科技风 UI |
| 🔐 认证 | 单用户 JWT 双 Token(Access 24h + Refresh 30d)+ httpOnly cookie,scrypt 哈希,失败锁定 |

## 快速开始

> 以下命令都在**部署机**(跑 Docker 的那台)执行;浏览器操作在你的电脑/手机上。
> 两种轨道按是否已有 TeslaMate 二选一,完成后都会进入 `/setup` 初始化向导。

### 轨道 A · 全新用户(还没有 TeslaMate)— 一条命令全套

```bash
git clone https://github.com/Ahaxzh/AhaTesla.git && cd AhaTesla

# 1. 生成并填入 2 个密钥(文件里附了可直接复制的生成命令)
cp deploy/.env.example.fullstack deploy/.env && vim deploy/.env

# 2. 拉起全套(AhaTesla + TeslaMate + PostgreSQL + Mosquitto)
docker compose -f deploy/fullstack-compose.yml --profile fullstack up -d
```

然后浏览器完成初始化(约 3 分钟):

1. 打开 `http://<部署机IP>:18500` → 注册管理员(第一位注册即管理员)
   - 远程主机部署时 18500/4000 默认只绑 127.0.0.1:18500 走 NPM HTTPS 反代对外(见 [NPM-SETUP.md](deploy/NPM-SETUP.md));
     4000 是 TeslaMate 无密码管理页(可下发车辆指令),**严禁**直接映射公网 —— 远程访问用 SSH 隧道 `ssh -L 4000:127.0.0.1:4000 <主机>`
2. 向导会引导你打开 `http://<部署机IP>:4000`,用**特斯拉账号**登录 TeslaMate(全栈版唯一需要出向导的一步,登录完回到 AhaTesla 等车出现即可)
3. 车辆确认 → 账本/推送渠道(可跳过)→ 完成,仪表盘开始出数据

### 轨道 B · 已有 TeslaMate — 三步接入(不动你现有任何容器)

```bash
git clone https://github.com/Ahaxzh/AhaTesla.git && cd AhaTesla

# 1. 确认你的 TeslaMate 网络名(官方 compose 默认就是 teslamate_default)
docker network ls | grep teslamate

# 2. 复制环境文件(一般一行都不用改)
cp deploy/.env.example.connect deploy/.env

# 3. 起容器(自动挂入你的 teslamate 网络,直连其数据库)
docker compose -f deploy/connect-compose.yml up -d
```

然后浏览器打开 `http://<部署机IP>:18500` → 向导选「**已有 TeslaMate**」:

1. 填你的 teslamate 库密码(即 TeslaMate `docker-compose.yml` / `.env` 里的 `DATABASE_PASS`,用户名默认 `teslamate`)
2. AhaTesla 用它**自动创建只读账号**并完成四级校验:网络可达 → 数据库认证 → 只读安全 → 发现车辆
3. 多车用户在下一步选择要接入的车 → 完成

**降级路径**(向导里都有对应提示):

| 情况 | 怎么办 |
|---|---|
| 自动建只读账号失败(权限不足等) | 向导给出一条**可复制的 SQL**,粘到任何能连库的终端执行,回来点「我已执行」 |
| 网络名不是 `teslamate_default` | `docker network connect <你的网络名> ahatesla-app`,或改 connect-compose.yml 里 `networks.teslamate.name` |
| TeslaMate 在另一台机器 | 编辑 `deploy/.env` 填 `DB_URL=postgres://...@<对端IP>:5432/teslamate`(对端 5432 需对你可达),并删掉 compose 里 teslamate 网络段 |
| 只读校验失败(填了管理账号) | 属于预期拦截:AhaTesla 拒绝用可写账号直连,回上一步走「自动建号」 |

> 两个 compose 默认拉取 GHCR 预构建镜像(`linux/amd64` + `linux/arm64`);改了本地代码想构建自己的镜像,加 `--build` 即可。

### 部署后:iPhone 收通知(可选)

任意 HTTPS 反代(如 NPM)指向 18500 → Safari 打开 → 分享 → 添加到主屏幕 → 推送页开启 Web Push(iOS ≥ 16.4)。反代配置见 [`deploy/NPM-SETUP.md`](deploy/NPM-SETUP.md)。

### 先看看效果:Demo 模式(无需 Tesla、无需数据库)

```bash
AHATESLA_DEMO=1 PORT=18590 node server/src/index.mjs
# 打开 http://127.0.0.1:18590 → /setup 注册管理员 → 仪表盘即有 90 天合成数据
```

- 行程/充电/账本/热力图/报表全部可浏览(固定种子合成数据,坐标刻意低精度)
- 轨迹图为空态(Demo 不合成百万行轨迹点);推送渠道与 AI 助手可**真实配置**体验
- API 契约不变;`/api/system/status` 返回 `demo: true` 标记

## 架构

```
Tesla(车) ←→ TeslaMate(车辆协议/Token) → PostgreSQL ←只读─ AhaTesla server(:18500)
                                                      ↘ Mosquitto MQTT(可选,事件提速)
server/ Node 22 ESM(API + JWT + 静态托管 + 推送引擎) ← web/ React 19 + Vite + TS + Tailwind + PWA
```

- 对 teslamate 库**严格只读**(专用账号 + 启动时主动探测账号确无写权限)
- AhaTesla 自身数据(账号/推送规则/电价历史/密钥)存本地 SQLite,密钥 AES-256-GCM 加密落盘
- 无公共后端、无遥测、不给车辆发任何控制指令

## 开发与测试

```bash
# 单元/组件测试 + 前端构建
cd server && npm test          # node --test(计价账本/API 路由/认证/推送引擎)
cd web && npm test             # vitest(每页面/每按钮/双视口)
cd web && npm run build        # dist 由 server 静态托管

# E2E(Playwright,mobile + desktop 双视口;自动拉起隔离实例并注入临时凭据)
bash scripts/run-e2e.sh        # 常规用例 + /setup 向导用例
```

- `server` 另有连真库的 live 测试(只读): `npm run test:live`
- 密码注入脚本幂等,不打印明文,详见 `node scripts/e2e-reset-password.mjs --help`

## 目录结构

```
server/   Node 后端(API · 认证 · 计价账本 · 推送引擎)
web/      React 前端(PWA · i18n · 明暗主题)
deploy/   Dockerfile · compose × 3 · SQL · NPM 反代文档
e2e/      Playwright 全链路测试
docs/     契约与架构(API_CONTRACT.md 为接口唯一真相源)
scripts/  工具脚本(e2e 启动器 · 密码注入)
```

## 安全与隐私

只读 teslamate 库 · 不发车辆控制命令 · VIN/GPS/Token 不进日志与 Git · secret AES-GCM 加密落盘 · 无公共后端/无遥测 · 桥接容器只绑 127.0.0.1。详见 [SECURITY.md](SECURITY.md)。

## CI/CD

| 工作流 | 触发 | 内容 |
|---|---|---|
| [CI](.github/workflows/ci.yml) | push main / PR | server 单测 · web 单测 + tsc + build |
| [Docker](.github/workflows/docker.yml) | push main / tag `v*` / 手动 / PR | 多架构镜像构建,推 GHCR(`latest` / semver / sha) |
| [Cleanup](.github/workflows/cleanup-ghcr.yml) | 每日定时 | 清理 2 周前的旧镜像(需配置 `PAT_TOKEN` Secret) |

## License

[MIT](LICENSE)
