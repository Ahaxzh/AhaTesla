// store.mjs — AhaTesla 自身数据 SQLite 持久层（PRD §7.1 / GA-01 / 卡 t_46fd8a8a）。
//
// 选型：Node 内置 node:sqlite（Node ≥22.5，DatabaseSync 同步 API），零第三方依赖，
// 与项目“pg + mqtt only”的轻依赖纪律一致；单库文件 server/data/ahatesla.db，
// WAL 模式 + foreign_keys 开启；schema 版本记录在 PRAGMA user_version。
//
// 覆盖 §7.1 列出的自身数据域：
//   account(账号 scrypt 凭据) / settings(电价默认值等) / pricing_history(电价变更)
//   / push_rules(推送开关) / push_subscriptions(Web Push 订阅)
//   / channel_secrets(渠道密钥，AES-256-GCM 密文，密钥=server/data/secret.key)
//   / datasource(teslamate 连接配置，密码密文) / fifo_batches+fifo_consumptions(FIFO 批次与消耗)
//   / charge_cost_overrides(本地补录费用，AC-7.1 第①层) / report_snapshots(报告快照)
//   / events(事件日志) / cursors(通知游标水线) / kv(杂项)
//
// 红线：本库只存 AhaTesla 自有数据，绝不写 TeslaMate 库；密文字段均为
// secret-box 加密后的 v1:… 封装串，明文不落库、不进日志。

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./secret-box.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 数据目录与 secret-box 对齐：AHA_DATA_DIR 可覆盖（e2e 隔离实例用）。
export const DEFAULT_DB_FILE = join(dataDir(), "ahatesla.db");

export const SCHEMA_VERSION = 1;

// 建表语句纳入版本控制；新增迁移以 user_version 为序追加到 MIGRATIONS。
export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS kv (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  username      TEXT NOT NULL,
  password_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'admin',
  updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pricing_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  changed_at  TEXT NOT NULL,
  from_rate   REAL,
  to_rate     REAL NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS idx_pricing_history_at ON pricing_history(changed_at);
CREATE TABLE IF NOT EXISTS push_rules (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint    TEXT NOT NULL UNIQUE,
  keys_json   TEXT NOT NULL DEFAULT '{}',   -- p256dh/auth 等（加密后封装）
  meta_json   TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_secrets (
  channel     TEXT PRIMARY KEY,             -- 'feishu' | 'telegram' | ...
  config_json TEXT NOT NULL DEFAULT '{}',   -- 非敏感配置（enabled/appId/…）
  secret_enc  TEXT,                         -- AES-256-GCM v1:… 密文（appSecret 等）
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS datasource (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  mode            TEXT NOT NULL,            -- 'connect' | 'fullstack'
  host            TEXT,
  port            INTEGER,
  database        TEXT,
  user            TEXT,
  password_enc    TEXT,                     -- AES-256-GCM 密文，明文绝不落库
  car_id          INTEGER,
  configured      INTEGER NOT NULL DEFAULT 0,
  configured_at   TEXT,
  meta_json       TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS fifo_batches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        TEXT NOT NULL UNIQUE,     -- 如 'cp-<charging_process_id>'
  car_id          INTEGER,
  source_ref      TEXT,                     -- 来源充电会话标识
  available_at_ms INTEGER NOT NULL,         -- 批次可用时间（FIFO 排序键）
  energy_kwh      REAL NOT NULL,
  remaining_kwh   REAL NOT NULL,
  unit_price      REAL,                     -- 元/kWh（3~4 位小数精度，§7.3）
  currency        TEXT NOT NULL DEFAULT 'CNY',
  meta_json       TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fifo_batches_avail ON fifo_batches(available_at_ms);
CREATE TABLE IF NOT EXISTS fifo_consumptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id     TEXT NOT NULL REFERENCES fifo_batches(batch_id) ON DELETE CASCADE,
  drive_ref    TEXT,                        -- 消耗该批次的行程标识
  consumed_kwh REAL NOT NULL,
  unit_price   REAL,
  consumed_at  INTEGER,                     -- 行程开始时间 ms（FIFO 可用性判定）
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fifo_consumptions_batch ON fifo_consumptions(batch_id);
CREATE TABLE IF NOT EXISTS charge_cost_overrides (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  charging_process_id   INTEGER NOT NULL UNIQUE,  -- TeslaMate charging_processes.id（仅存引用）
  cost                  REAL NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'CNY',
  note                  TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS report_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,               -- 'weekly' | 'monthly' | 'push_summary'
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  payload_json TEXT NOT NULL,               -- 不可变快照（§7.4）
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_snapshots_kind ON report_snapshots(kind, period_start);
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  type        TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
CREATE TABLE IF NOT EXISTS cursors (
  name        TEXT PRIMARY KEY,             -- 'drives' | 'charging_processes' | …
  value       INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

const MIGRATIONS = [
  { version: 1, sql: SCHEMA_V1 }
];

function nowIso() {
  return new Date().toISOString();
}

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeJsonParse(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

/** 打开（必要时创建）SQLite 库并跑到最新 schema。file 可为 ":memory:"（测试用）。 */
export function openStore({ file = DEFAULT_DB_FILE } = {}) {
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  // WAL：崩溃安全 + 读写并发；busy_timeout：跨进程（server / e2e 脚本）短暂锁等待。
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  migrate(db);
  return createStoreApi(db, file);
}

function migrate(db) {
  const current = Number(db.prepare("PRAGMA user_version").get().user_version || 0);
  for (const step of MIGRATIONS) {
    if (step.version <= current) continue;
    db.exec("BEGIN");
    try {
      db.exec(step.sql);
      db.exec(`PRAGMA user_version=${step.version};`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return Number(db.prepare("PRAGMA user_version").get().user_version || 0);
}

function createStoreApi(db, file) {
  // ---- account ---------------------------------------------------------------
  const stAccountGet = db.prepare("SELECT username, password_hash AS passwordHash, role FROM account WHERE id=1");
  const stAccountPut = db.prepare(`
    INSERT INTO account (id, username, password_hash, role, updated_at) VALUES (1, @username, @passwordHash, @role, @at)
    ON CONFLICT(id) DO UPDATE SET username=@username, password_hash=@passwordHash, role=@role, updated_at=@at
  `);
  const stPricingGet = db.prepare("SELECT value_json FROM settings WHERE key='pricing'");
  const stPricingPut = db.prepare(`
    INSERT INTO settings (key, value_json, updated_at) VALUES ('pricing', @json, @at)
    ON CONFLICT(key) DO UPDATE SET value_json=@json, updated_at=@at
  `);
  const stHistoryIns = db.prepare("INSERT INTO pricing_history (changed_at, from_rate, to_rate, source) VALUES (@changedAt, @from, @to, @source)");
  const stHistoryAll = db.prepare('SELECT id, changed_at AS changedAt, from_rate AS "from", to_rate AS "to", source FROM pricing_history ORDER BY id');
  const stHistoryClear = db.prepare("DELETE FROM pricing_history");
  const stHistoryCount = db.prepare("SELECT count(*) AS c FROM pricing_history");
  const stRulesGet = db.prepare("SELECT key, value FROM push_rules");
  const stRulesDel = db.prepare("DELETE FROM push_rules");
  const stRulesPut = db.prepare("INSERT OR REPLACE INTO push_rules (key, value) VALUES (?, ?)");
  const stChannelGet = db.prepare("SELECT config_json, secret_enc, updated_at FROM channel_secrets WHERE channel=?");
  const stChannelPut = db.prepare(`
    INSERT INTO channel_secrets (channel, config_json, secret_enc, updated_at) VALUES (@channel, @configJson, @secretEnc, @at)
    ON CONFLICT(channel) DO UPDATE SET config_json=@configJson, secret_enc=coalesce(@secretEnc, channel_secrets.secret_enc), updated_at=@at
  `);
  const stDsGet = db.prepare("SELECT mode, host, port, database, user, password_enc AS passwordEnc, car_id AS carId, configured, configured_at AS configuredAt, meta_json AS metaJson FROM datasource WHERE id=1");
  const stDsPut = db.prepare(`
    INSERT INTO datasource (id, mode, host, port, database, user, password_enc, car_id, configured, configured_at, meta_json)
    VALUES (1, @mode, @host, @port, @database, @user, @passwordEnc, @carId, @configured, @configuredAt, @metaJson)
    ON CONFLICT(id) DO UPDATE SET mode=@mode, host=@host, port=@port, database=@database, user=@user,
      password_enc=@passwordEnc, car_id=@carId, configured=@configured, configured_at=@configuredAt, meta_json=@metaJson
  `);
  // 重新订阅（PWA 常态：浏览器轮换 subscription）走 UPSERT —— 旧版裸 INSERT
  // 撞 UNIQUE(endpoint) 直接 500。
  const stSubIns = db.prepare(`INSERT INTO push_subscriptions (endpoint, keys_json, meta_json, created_at, updated_at)
    VALUES (@endpoint, @keysJson, @metaJson, @at, @at)
    ON CONFLICT(endpoint) DO UPDATE SET keys_json=@keysJson, meta_json=@metaJson, updated_at=@at`);
  const stSubAll = db.prepare("SELECT id, endpoint, keys_json AS keysJson, meta_json AS metaJson, created_at AS createdAt, updated_at AS updatedAt FROM push_subscriptions ORDER BY id");
  const stSubDel = db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?");
  const stBatchUpsert = db.prepare(`
    INSERT INTO fifo_batches (batch_id, car_id, source_ref, available_at_ms, energy_kwh, remaining_kwh, unit_price, currency, meta_json, created_at, updated_at)
    VALUES (@batchId, @carId, @sourceRef, @availableAtMs, @energyKwh, @remainingKwh, @unitPrice, @currency, @metaJson, @at, @at)
    ON CONFLICT(batch_id) DO UPDATE SET car_id=@carId, source_ref=@sourceRef, available_at_ms=@availableAtMs,
      energy_kwh=@energyKwh, remaining_kwh=@remainingKwh, unit_price=@unitPrice, currency=@currency, meta_json=@metaJson, updated_at=@at
  `);
  const stBatchAll = db.prepare("SELECT batch_id AS batchId, car_id AS carId, source_ref AS sourceRef, available_at_ms AS availableAtMs, energy_kwh AS energyKwh, remaining_kwh AS remainingKwh, unit_price AS unitPrice, currency, meta_json AS metaJson FROM fifo_batches ORDER BY available_at_ms, batch_id");
  const stBatchGet = db.prepare("SELECT batch_id AS batchId, remaining_kwh AS remainingKwh FROM fifo_batches WHERE batch_id=?");
  const stBatchDec = db.prepare("UPDATE fifo_batches SET remaining_kwh=remaining_kwh-?, updated_at=? WHERE batch_id=?");
  const stConsIns = db.prepare("INSERT INTO fifo_consumptions (batch_id, drive_ref, consumed_kwh, unit_price, consumed_at, created_at) VALUES (@batchId, @driveRef, @consumedKwh, @unitPrice, @consumedAt, @at)");
  const stConsByBatch = db.prepare("SELECT id, drive_ref AS driveRef, consumed_kwh AS consumedKwh, unit_price AS unitPrice, consumed_at AS consumedAt FROM fifo_consumptions WHERE batch_id=? ORDER BY id");
  const stOverrideUpsert = db.prepare(`
    INSERT INTO charge_cost_overrides (charging_process_id, cost, currency, note, created_at, updated_at)
    VALUES (@cpId, @cost, @currency, @note, @at, @at)
    ON CONFLICT(charging_process_id) DO UPDATE SET cost=@cost, currency=@currency, note=@note, updated_at=@at
  `);
  const stOverrideGet = db.prepare("SELECT charging_process_id AS cpId, cost, currency, note, updated_at AS updatedAt FROM charge_cost_overrides WHERE charging_process_id=?");
  const stOverrideAll = db.prepare("SELECT charging_process_id AS cpId, cost, currency, note, updated_at AS updatedAt FROM charge_cost_overrides ORDER BY charging_process_id");
  const stOverrideDel = db.prepare("DELETE FROM charge_cost_overrides WHERE charging_process_id=?");
  const stReportIns = db.prepare("INSERT INTO report_snapshots (kind, period_start, period_end, payload_json, created_at) VALUES (@kind, @periodStart, @periodEnd, @payloadJson, @at)");
  const stReportList = db.prepare("SELECT id, kind, period_start AS periodStart, period_end AS periodEnd, payload_json AS payloadJson, created_at AS createdAt FROM report_snapshots WHERE kind=@kind ORDER BY period_start DESC LIMIT @limit");
  const stEventIns = db.prepare("INSERT INTO events (at, type, detail_json) VALUES (@at, @type, @detailJson)");
  const stEventList = db.prepare("SELECT id, at, type, detail_json AS detailJson FROM events ORDER BY id DESC LIMIT ?");
  const stEventPrune = db.prepare("DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)");
  const stCursorGet = db.prepare("SELECT value FROM cursors WHERE name=?");
  const stCursorPut = db.prepare("INSERT INTO cursors (name, value, updated_at) VALUES (@name, @value, @at) ON CONFLICT(name) DO UPDATE SET value=@value, updated_at=@at");
  const stKvGet = db.prepare("SELECT value FROM kv WHERE key=?");
  const stKvPut = db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (@key, @value, @at) ON CONFLICT(key) DO UPDATE SET value=@value, updated_at=@at");

  return {
    db,
    file,
    schemaVersion: () => Number(db.prepare("PRAGMA user_version").get().user_version || 0),
    close() { db.close(); },

    // ---- 账号（§7.1 账号凭据；scrypt 哈希由 auth.mjs 生成）--------------------
    getAccount: () => stAccountGet.get() || null,
    putAccount({ username, passwordHash, role = "admin" }) {
      stAccountPut.run({ username: String(username ?? "admin"), passwordHash: passwordHash ?? null, role, at: nowIso() });
    },

    // ---- 电价默认值 + 变更历史（§7.1 电价规则与变更历史）----------------------
    getPricing() {
      const row = stPricingGet.get();
      return row ? safeJsonParse(row.value_json, {}) : {};
    },
    putPricing(pricing) {
      stPricingPut.run({ json: JSON.stringify(pricing ?? {}), at: nowIso() });
    },
    addPricingHistory({ changedAt, from, to, source = "manual" }) {
      stHistoryIns.run({ changedAt: changedAt || nowIso(), from: num(from), to: num(to, 0), source });
    },
    listPricingHistory: () => stHistoryAll.all().map((r) => ({ changedAt: r.changedAt, from: r.from, to: r.to, source: r.source })),
    clearPricingHistory: () => { stHistoryClear.run(); },
    countPricingHistory: () => Number(stHistoryCount.get().c),

    // ---- 推送开关（§7.1 订阅规则的开关部分）----------------------------------
    getPushRules() {
      const out = {};
      for (const row of stRulesGet.all()) {
        out[row.key] = row.value === "true" ? true : row.value === "false" ? false : safeJsonParse(row.value, row.value);
      }
      return out;
    },
    putPushRules(rules) {
      stRulesDel.run();
      for (const [key, value] of Object.entries(rules ?? {})) {
        stRulesPut.run(key, typeof value === "boolean" ? String(value) : JSON.stringify(value));
      }
    },

    // ---- Web Push 订阅（§7.1）------------------------------------------------
    addPushSubscription({ endpoint, keys = {}, meta = {} }) {
      stSubIns.run({ endpoint: String(endpoint), keysJson: JSON.stringify(keys ?? {}), metaJson: JSON.stringify(meta ?? {}), at: nowIso() });
    },
    listPushSubscriptions: () => stSubAll.all().map((r) => ({
      id: r.id, endpoint: r.endpoint, keys: safeJsonParse(r.keysJson, {}), meta: safeJsonParse(r.metaJson, {}), createdAt: r.createdAt, updatedAt: r.updatedAt
    })),
    removePushSubscription(endpoint) {
      stSubDel.run(String(endpoint));
    },

    // ---- 渠道密钥（§7.1 加密的渠道密钥；secretEnc 为 AES-256-GCM 封装串）------
    getChannel(channel) {
      const row = stChannelGet.get(String(channel));
      if (!row) return null;
      return { config: safeJsonParse(row.config_json, {}), secretEnc: row.secret_enc ?? null, updatedAt: row.updated_at };
    },
    putChannel(channel, { config = {}, secretEnc = null } = {}) {
      stChannelPut.run({ channel: String(channel), configJson: JSON.stringify(config ?? {}), secretEnc: secretEnc ?? null, at: nowIso() });
    },

    // ---- teslamate 连接配置（卡红线：连接配置也存 SQLite，密码加密）-----------
    getDatasource() {
      const row = stDsGet.get();
      if (!row) return null;
      return {
        mode: row.mode, host: row.host, port: row.port, database: row.database, user: row.user,
        passwordEnc: row.passwordEnc, carId: row.carId,
        configured: row.configured === 1, configuredAt: row.configuredAt,
        ...safeJsonParse(row.metaJson, {})
      };
    },
    putDatasource(ds) {
      const { cars, ...rest } = ds ?? {};
      stDsPut.run({
        mode: String(rest.mode ?? "connect"),
        host: rest.host ?? null,
        port: num(rest.port),
        database: rest.database ?? null,
        user: rest.user ?? null,
        passwordEnc: rest.passwordEnc ?? null,
        carId: num(rest.carId),
        configured: rest.configured ? 1 : 0,
        configuredAt: rest.configuredAt ?? null,
        metaJson: JSON.stringify(cars ? { cars } : {})
      });
    },

    // ---- FIFO 批次与消耗（§7.1 FIFO 批次消耗记录）-----------------------------
    upsertFifoBatch(batch) {
      stBatchUpsert.run({
        batchId: String(batch.batchId), carId: num(batch.carId), sourceRef: batch.sourceRef ?? null,
        availableAtMs: Number(batch.availableAtMs) || 0,
        energyKwh: Number(batch.energyKwh) || 0, remainingKwh: Number(batch.remainingKwh ?? batch.energyKwh) || 0,
        unitPrice: num(batch.unitPrice), currency: batch.currency ?? "CNY",
        metaJson: JSON.stringify(batch.meta ?? {}), at: nowIso()
      });
    },
    listFifoBatches: () => stBatchAll.all().map((r) => ({ ...r, meta: safeJsonParse(r.metaJson, {}) })),
    /** FIFO 消耗：扣减批次余量并落一条消耗记录（同事务）。 */
    consumeFifoBatch({ batchId, driveRef, consumedKwh, unitPrice, consumedAt }) {
      db.exec("BEGIN");
      try {
        stBatchDec.run(Number(consumedKwh) || 0, nowIso(), String(batchId));
        stConsIns.run({ batchId: String(batchId), driveRef: driveRef ?? null, consumedKwh: Number(consumedKwh) || 0, unitPrice: num(unitPrice), consumedAt: num(consumedAt), at: nowIso() });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    getFifoBatch: (batchId) => stBatchGet.get(String(batchId)) || null,
    listFifoConsumptions: (batchId) => stConsByBatch.all(String(batchId)),

    // ---- 本地补录充电费用（AC-7.1 四层回退第①层；GA-15）-----------------------
    putChargeCostOverride({ cpId, cost, currency = "CNY", note = null }) {
      stOverrideUpsert.run({ cpId: Number(cpId), cost: Number(cost), currency, note, at: nowIso() });
    },
    getChargeCostOverride: (cpId) => stOverrideGet.get(Number(cpId)) || null,
    listChargeCostOverrides: () => stOverrideAll.all(),
    deleteChargeCostOverride(cpId) { stOverrideDel.run(Number(cpId)); },

    // ---- 报告快照（§7.1 报告快照；§7.4 不可变）--------------------------------
    addReportSnapshot({ kind, periodStart, periodEnd, payload }) {
      const res = stReportIns.run({ kind: String(kind), periodStart: String(periodStart), periodEnd: String(periodEnd), payloadJson: JSON.stringify(payload ?? {}), at: nowIso() });
      return Number(res.lastInsertRowid);
    },
    listReportSnapshots(kind, limit = 50) {
      return stReportList.all({ kind: String(kind), limit: Math.max(1, Number(limit) || 50) })
        .map((r) => ({ id: r.id, kind: r.kind, periodStart: r.periodStart, periodEnd: r.periodEnd, payload: safeJsonParse(r.payloadJson, {}), createdAt: r.createdAt }));
    },

    // ---- 事件日志（§7.1；环形语义：插入后裁剪至 maxEvents）--------------------
    logEvent({ at, type, detail = {} }) {
      stEventIns.run({ at: at || nowIso(), type: String(type), detailJson: JSON.stringify(detail ?? {}) });
      return null;
    },
    listEvents(limit = 100) {
      // 与内存版形状一致：detail 展开进顶层（{at, type, ...detail}）。
      return stEventList.all(Math.max(1, Math.min(500, Number(limit) || 100)))
        .map((r) => ({ at: r.at, type: r.type, ...safeJsonParse(r.detailJson, {}) }));
    },
    pruneEvents(keep = 2000) {
      stEventPrune.run(Math.max(1, Number(keep) || 2000) - 1);
    },
    countEvents() {
      return Number(db.prepare("SELECT count(*) AS c FROM events").get().c);
    },

    // ---- 通知游标水线（§7.1/AC-12.1b；B2 水线的持久化落点）--------------------
    getCursor(name) {
      const row = stCursorGet.get(String(name));
      return row ? Number(row.value) : null;
    },
    putCursor(name, value) {
      stCursorPut.run({ name: String(name), value: Number(value) || 0, at: nowIso() });
    },

    // ---- 杂项 kv ---------------------------------------------------------------
    kvGet(key) {
      const row = stKvGet.get(String(key));
      return row ? row.value : null;
    },
    kvPut(key, value) {
      stKvPut.run({ key: String(key), value: String(value), at: nowIso() });
    }
  };
}

// ---- state.json → SQLite 一次性迁移（幂等） -----------------------------------
//
// 规则（见 docs/STORAGE.md）：
//   - 仅当 JSON 文件存在且 kv.json_migrated 未置位时执行；
//   - 成功后把 state.json 原子改名为 state.json.migrated-<ts>（退役但保留备份，
//     内容含密码哈希/密文，继续被 .gitignore 覆盖）；
//   - 重复调用（文件已改名/已置位）直接跳过 —— 幂等可重跑。

export function migrateStateJsonIntoStore(store, { jsonPath } = {}) {
  const jsonPathResolved = jsonPath || join(dataDir(), "state.json");
  if (store.kvGet("json_migrated") === "1") return { migrated: false, reason: "already_migrated" };
  if (!existsSync(jsonPathResolved)) {
    store.kvPut("json_migrated", "1");
    return { migrated: false, reason: "no_json" };
  }

  let legacy;
  try {
    legacy = JSON.parse(readFileSync(jsonPathResolved, "utf8"));
  } catch {
    // 损坏的 JSON：改名隔离后按“无历史状态”处理（与旧 loadState 行为一致）。
    try { renameSync(jsonPathResolved, `${jsonPathResolved}.corrupt-${Date.now()}`); } catch { /* best effort */ }
    store.kvPut("json_migrated", "1");
    return { migrated: false, reason: "corrupt_json_quarantined" };
  }

  // 逐域写入（只写存在的键，避免用默认值覆盖空库）。
  if (legacy.username || legacy.passwordHash) {
    store.putAccount({ username: legacy.username ?? "admin", passwordHash: legacy.passwordHash ?? null, role: legacy.role ?? "admin" });
  }
  if (legacy.pricing) {
    const { history, ...pricing } = legacy.pricing;
    store.putPricing(pricing);
    for (const h of Array.isArray(history) ? history : []) {
      store.addPricingHistory({ changedAt: h.changedAt, from: h.from, to: h.to, source: h.source });
    }
  }
  if (legacy.pushRules) store.putPushRules(legacy.pushRules);
  if (legacy.feishu) {
    const { enabled = false, appId = "", appSecretEnc = null, lastEventAt = null, openId } = legacy.feishu;
    store.putChannel("feishu", { config: { enabled, appId, lastEventAt, ...(openId ? { openId } : {}) }, secretEnc: appSecretEnc });
  }
  if (legacy.datasource) store.putDatasource(legacy.datasource);

  store.kvPut("json_migrated", "1");
  const backup = `${jsonPathResolved}.migrated-${Date.now()}`;
  try { renameSync(jsonPathResolved, backup); } catch { /* best effort；下次启动会重试 */ }
  return { migrated: true, backup };
}

export function sqlitePathFor(dir) {
  return join(dir, "ahatesla.db");
}
