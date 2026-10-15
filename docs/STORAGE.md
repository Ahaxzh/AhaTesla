# AhaTesla 自身存储设计（SQLite）

> 对应 PRD §7.1 架构基线 / GAP-ANALYSIS GA-01 / Kanban 卡 t_46fd8a8a。
> M0 基线（state.json + secret.key）→ M1（单文件 SQLite）的一次性迁移记录与设计说明。

## 1. 选型结论

| 项 | 决策 | 理由 |
|---|---|---|
| SQLite 驱动 | **Node 内置 `node:sqlite`**（`DatabaseSync`） | Node ≥22.5 内置、零第三方依赖，与项目"pg + mqtt only"轻依赖纪律一致；本项目为单进程同步写场景，`DatabaseSync` 的同步语义足够（API 层本就以同步 state 对象为轴）。不引入 better-sqlite3（原生编译依赖，收益仅在大规模异步并发，当前无此需求） |
| 库文件 | `server/data/ahatesla.db`（开发/裸机部署） | PRD §7.1 卷挂载规范为容器内 `/data/ahatesla.db`，compose 卷映射到宿主该路径即可；单文件 + WAL |
| 模式 | WAL + `foreign_keys=ON` + `busy_timeout=5000` | 崩溃安全；跨进程（server / e2e 脚本）短暂锁等待 |
| schema 版本 | `PRAGMA user_version` | 轻量迁移序号，新增迁移以数组追加（`MIGRATIONS`），逐版本事务执行 |
| 加密密钥 | 沿用 `server/data/secret.key`（或 `.env APP_SECRET_KEY`） | 密钥是数据库密文的加密密钥，属引导级凭据（先有密钥才能解密库），保留独立文件（§7.2） |

## 2. 数据域 → 表映射（PRD §7.1）

| §7.1 数据域 | 表 | 说明 |
|---|---|---|
| 账号凭据（scrypt 哈希） | `account` | 单行（id=1）；`password_hash` 为 `scrypt$N$salt$hash` 格式，由 `api/auth.mjs` 生成；用户名/角色同表 |
| JWT 会话 | （无表） | JWT 为无状态 HS256，密钥派生自 secret.key，与 M0 行为一致；如需服务端吊销再立 `sessions` 表（未列入本卡范围） |
| 电价规则与变更历史 | `settings(key='pricing')` + `pricing_history` | 默认电价存 settings（JSON）；每次变更插一行历史（changed_at/from/to/source），API `GET /api/pricing/history` 读此表 |
| 渠道密钥（AES-256-GCM） | `channel_secrets` | `channel='feishu'` 等；`secret_enc` 存 secret-box 的 `v1:iv:tag:ct` 封装串，明文绝不落库；非敏感配置（enabled/appId/lastEventAt/openId）存 `config_json` |
| Web Push 订阅 | `push_subscriptions` | endpoint 唯一键 + keys JSON（p256dh/auth）+ meta（UA 等）；M1 落表，Web Push 渠道接入时直接消费 |
| 推送开关矩阵 | `push_rules` | key-value（boolean 序列化为 'true'/'false'，weeklyReportDay 存数字） |
| teslamate 连接配置 | `datasource` | **卡红线**：连接配置也存 SQLite；`password_enc` 加密存（向导 `POST /api/setup/datasource` 写入）；carId（AC-2.3 主绑定车辆）同表 |
| FIFO 批次消耗记录 | `fifo_batches` + `fifo_consumptions` | 批次（batch_id 唯一，如 `cp-<charging_process_id>`）含 energy/remaining/unit_price；`consumeFifoBatch` 同事务扣减余量+落消耗记录；注意：实时计价仍由 pricing-ledger 从真库内存计算，本表是持久化落点（供报告重算/审计，AC-7.5） |
| 本地补录充电费用 | `charge_cost_overrides` | AC-7.1 四层回退第①层（GA-15）；`charging_process_id` 唯一（只存引用，不复制 TeslaMate 数据） |
| 报告快照 | `report_snapshots` | weekly/monthly/push_summary；payload 为不可变 JSON（§7.4 推送小结不可变快照） |
| 事件日志 | `events` | `at/type/detail_json`；DB 后端保留 2000 条（`pruneEvents`），内存 ring 500 条语义保留在无 store 模式 |
| 通知游标水线 | `cursors` | `drives` / `charging_processes` 最大 id 水线（AC-12.1b、B2）；当前水线在 TripMonitor 内存态，本表为跨重启持久化落点 |
| 杂项 | `kv` | `json_migrated` 迁移标记等 |

建表语句全文见 `server/src/core/store.mjs` 顶部 `SCHEMA_V1`（纳入版本控制；后续迁移追加 `MIGRATIONS` 数组）。

## 3. 代码结构

```
server/src/core/store.mjs   # 新增：openStore()/schema/CRUD/migrateStateJsonIntoStore()
server/src/core/state.mjs   # 改造：loadState/saveState 等签名不变，后端 JSON→SQLite
server/src/core/events.mjs  # 改造：createEventLog({store}) 可选 SQLite 后端（无 store 保持内存 ring）
server/src/core/secret-box.mjs # 不变：secret.key + AES-256-GCM（密文格式沿用 v1:…）
server/src/index.mjs        # 接线：main() 的 eventLog 用 getStore() 后端
```

**兼容层设计**：`loadState()/saveState()/setDefaultRate()/setFeishuConfig()/getFeishuSecret()` 全部保留原签名与 state 对象形状（username/passwordHash/pricing/pushRules/feishu/datasource），API 路由层零改动；`saveState(state)` 语义变为"全量同步到 SQLite"。

## 4. state.json → SQLite 一次性迁移

- **触发**：`getStore()` 首次打开库时（server 启动 / e2e 脚本），执行 `migrateStateJsonIntoStore`。
- **幂等**：`kv.json_migrated` 标记 + 文件改名双重保险；重跑（标记已置位或文件已不存在）直接跳过。损坏 JSON 隔离为 `state.json.corrupt-<ts>` 后按空库处理（与 M0 loadState 行为一致）。
- **退役**：成功后 `state.json` 改名为 `state.json.migrated-<ts>`（保留备份，含哈希/密文，被 .gitignore 覆盖）。回滚 = 改回原名并删 ahatesla.db（旧代码直接可读）。
- **域映射**：username/passwordHash/role → account；pricing.defaultRateCnyPerKwh → settings；pricing.history[] → pricing_history；pushRules → push_rules；feishu（含 appSecretEnc 密文原样迁移，无需重加密）→ channel_secrets；datasource（含 passwordEnc）→ datasource。
- **e2e 脚本**：`scripts/e2e-reset-password.mjs` 已改为操作 `account` 表（注入/还原/幂等语义不变；备份 `server/data/e2e-account-backup.json`，0600）。若库不存在且存在旧 state.json，脚本会先执行同款迁移，未重启新代码的仓库也能直接跑 e2e。

## 5. 测试与验证

- `server/test/state.test.mjs` 重写/扩展：加密往返（不变）、SQLite 读写与默认值合并、pricing 历史、feishu 密文落库与部分更新不丢密钥、迁移全域+幂等+损坏隔离、12 表 CRUD（订阅/FIFO 事务/补录 upsert/快照/事件/游标）、跨 openStore 持久化（WAL）。
- store 单测全部使用 `:memory:` 或 tmpdir，**绝不触碰真实 `server/data/ahatesla.db`**。
- 基线：server 99 例（setup 卡合入后）→ **106 例全绿**；web 41/41；e2e 见卡内回帖。

## 6. 红线自查

- 只写本地 SQLite，**未对 teslamate 库做任何写操作**（本卡不触碰 db.mjs 查询层）。
- 密文字段（channel secret / datasource password）均为 AES-256-GCM 封装串；明文不落库、不进日志、不进 Git（.db 与迁移备份均 ignore）。
- secret.key、JWT 派生逻辑不变（§7.2 兼容）。
