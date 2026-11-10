# AhaTesla 项目指南 — AI 协作文档

**版本**: v0.1.0 · **更新**: 2026-10-14

## 项目定位
特斯拉小管家 Ubuntu 自托管版：TeslaMate 数据 → 行程/电费/充电账本 → Web(PWA) + 飞书双通道。
参考 AhaSlit 前后端分离架构（server/ + web/），核心算法源自 tesla-butler（已按本项目需求重写，非照搬）。

## 技术栈
| 层 | 技术 | 端口 |
|---|---|---|
| 后端 | Node 22+ ESM(镜像/CI 已升 26 LTS) · 手写路由(零框架) · pg · mqtt | 18500 |
| 前端 | React 19 · Vite · TS · Tailwind · Lucide · PWA | dev 5173 |
| 测试 | node --test / vitest / Playwright | — |

## 关键路径
- API 契约: `docs/API_CONTRACT.md`（唯一真相源，改接口先改它）
- 计价规则: 契约第4节 —— charging.cost 优先 → geofence 单价 → 默认价；批次分摊
- 认证: scrypt + 手写 HS256 JWT，cookie `ahatesla_token`，单用户
- 秘密: `server/.env`（gitignored, 600）· secret AES-256-GCM 落 `server/data/`

## 命令
```bash
cd server && npm test && npm start     # :18500
cd web && npm test && npm run build    # dist 由 server 托管
bash scripts/run-e2e.sh               # e2e 全链路（隔离实例；勿在根目录裸跑 npx playwright test——会把 web/tests 的 vitest 文件误当用例）
docker compose -f deploy/bridge-compose.yml up -d   # socat 桥接
```

## 远程与提交纪律
- 远程: `origin = https://github.com/Ahaxzh/AhaTesla`(分支 `main`)
- **每批功能完成且门禁全绿后,必须 commit 并 push**(用户明令,2026-10-18 起)
- push 前自查:VIN/GPS/Token/Secret 不得出现在任何提交(红线 2);server/data 与 .env 永不入库

## 安全红线（不可违反）
1. 对 teslamate 库只读；禁止任何车辆控制命令
2. VIN/GPS/Token/Secret 不进 Git、日志、错误信息
3. 桥接容器只绑 127.0.0.1；对外仅 NPM(.4) HTTPS 反代
4. 不引入账号体系/公共后端/数据上传

## 测试纪律
- 每个功能按钮、每个页面、移动+桌面双视口都要有自动化测试
- live 测试（连真库）单独目录，只读，可跳过
- 提交前: server npm test + web npm test + web build + playwright 全绿

## 常见任务
- 加接口: 改 API_CONTRACT.md → server/src/api/ → web/src/api/client.ts → 测试 → e2e
- 改计价: server/src/core/pricing-ledger.mjs + 单测构造序列断言分摊
- 图标: scripts/ 下生成，manifest 与 apple-touch-icon 必须齐全（safe zone 内缩 20%）
