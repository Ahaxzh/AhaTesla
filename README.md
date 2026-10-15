<div align="center">

# AhaTesla · 特斯拉小管家

**Tesla 行程 · 电费 · 充电站账本 — Ubuntu 自托管 Web + 飞书双通道**

记账与行程边界算法的设计灵感来自 [tesla-butler](https://github.com/manwithshit/tesla-butler) · 参考 AhaSlit 前后端分离架构

</div>

---

## 功能
- 🚗 **行程记录**：里程、能耗、路线图、每公里成本（数据源：TeslaMate PostgreSQL，只读）
- ⚡ **充电账本**：按充电站单价（geofences）自动计费，支持批次分摊算法
- 💰 **月度账单**：里程 / 电费 / 油车费用对比
- 🔔 **飞书推送**：行程结束、充电开始/结束、周报月报（Card 2.0）
- 📱 **Web / PWA**：iPhone 添加到主屏幕，深色科技风 UI，移动优先
- 🔐 **登录认证**：单用户 JWT + httpOnly cookie，scrypt 密码哈希

## 快速开始

```bash
# 1. 数据桥接（挂入现有 teslamate_default 网络，零侵入）
docker compose -f deploy/bridge-compose.yml up -d

# 2. 后端
cd server && npm ci && cp .env.example .env  # 填 DB_URL
npm test && npm start                        # :18500

# 3. 前端
cd web && npm ci && npm run dev              # :5173 → proxy /api
# 生产：npm run build 后由 server 托管 dist

# 4. iPhone PWA
# .4 NPM 反代 https://tesla.home.xxx → 192.168.31.3:18500
# Safari → 分享 → 添加到主屏幕（见 deploy/NPM-SETUP.md）
```

## 架构

```
TeslaMate 栈（不动） → socat 桥接 127.0.0.1:15432/11883
  → server/ Node22 ESM :18500（API+JWT+静态托管+飞书Worker）
  → web/ React19+Vite+TS+Tailwind+PWA
```

## 测试
- `server`: `npm test` — 单测（计价账本/API路由/认证），`node --test test/live` 连真库只读
- `web`: `npm test` — vitest 组件测试（每页面/每按钮/双视口），`npm run build`
- E2E: Playwright 全链路（登录→每页→每交互），见 `e2e/`

### 跑 e2e（Playwright）

需要 server 已在 `:18500` 运行（`cd server && npm start`，`--env-file=.env` 会自动加载 DB_URL/MQTT_URL），且已知登录密码。`state.json` 只存 scrypt 哈希无法反推密码，因此用脚本注入一个临时密码：

```bash
# 1) 注入 e2e 临时密码（会先备份 server/data/state.json → state.json.e2e-backup）
AHATESLA_E2E_PASSWORD='e2e-tmp-password' node scripts/e2e-reset-password.mjs

# 2) 重启 server 使新密码生效
cd server && npm start

# 3) 在仓库根执行 e2e（会自动加载 e2e/playwright.config.mjs，只跑 e2e/ 下的用例）
AHATESLA_E2E_PASSWORD='e2e-tmp-password' npm run test:e2e

# 4) 还原原始密码（并重启 server）
node scripts/e2e-reset-password.mjs --restore
```

脚本幂等：重复注入不会覆盖最初的备份；`--restore` 在没有备份时安全退出，还原后保留备份以便核对 state.json 与备份一致。脚本与日志均不会打印密码明文。详见 `scripts/e2e-reset-password.mjs --help`。

## 目录
```
server/  Node 后端      web/ React 前端
deploy/  桥接+systemd+NPM   docs/  契约与架构
e2e/     Playwright      scripts/ 图标生成
```

## 安全红线
只读 teslamate 库 · 不发车辆命令 · VIN/GPS/Token 不进日志与 Git · secret AES-GCM 加密落盘

## 致谢
行程边界状态机与电价批次账本的产品方向，灵感来自 [manwithshit/tesla-butler](https://github.com/manwithshit/tesla-butler)。本项目的实现按自有规格（`docs/PRD.md` / `docs/API_CONTRACT.md`）独立编写，未复制上游源码。
