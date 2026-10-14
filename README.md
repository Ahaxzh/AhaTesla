<div align="center">

# AhaTesla · 特斯拉小管家

**Tesla 行程 · 电费 · 充电站账本 — Ubuntu 自托管 Web + 飞书双通道**

基于 [tesla-butler](https://github.com/manwithshit/tesla-butler) 核心算法移植 · 参考 AhaSlit 前后端分离架构

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

## 目录
```
server/  Node 后端      web/ React 前端
deploy/  桥接+systemd+NPM   docs/  契约与架构
e2e/     Playwright      scripts/ 图标生成
```

## 安全红线
只读 teslamate 库 · 不发车辆命令 · VIN/GPS/Token 不进日志与 Git · secret AES-GCM 加密落盘

## 致谢
核心行程边界状态机与电价批次账本源自 [manwithshit/tesla-butler](https://github.com/manwithshit/tesla-butler)，MIT 口径，文件头保留出处注释。
