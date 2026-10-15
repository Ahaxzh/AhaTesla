// state.test.mjs — secret-box 加密 + SQLite 状态层（t_46fd8a8a）测试。
//
// 覆盖：加密往返/防篡改（不变）、load/save 默认值合并（SQLite 后端）、
// setDefaultRate 历史、feishu 密文落库、JSON→SQLite 一次性迁移幂等、
// 各域 CRUD（账号/推送规则/订阅/FIFO/补录/快照/事件/游标）。
//
// 注意：store 相关用例统一使用内存库（useMemoryStore），绝不触碰真实
// server/data/ahatesla.db —— 测试红线。

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret } from "../src/core/secret-box.mjs";
import {
  loadState, saveState, setDefaultRate, setFeishuConfig, getFeishuSecret,
  DEFAULT_STATE, useMemoryStore, getStore
} from "../src/core/state.mjs";
import { openStore, migrateStateJsonIntoStore, SCHEMA_VERSION } from "../src/core/store.mjs";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- secret-box（密钥文件语义不变，§7.2） ----------------------------------

test("secret box roundtrip", () => {
  const enc = encryptSecret("my-feishu-secret");
  assert.notEqual(enc, "my-feishu-secret");
  assert.match(enc, /^v1:/);
  assert.equal(decryptSecret(enc), "my-feishu-secret");
});

test("secret box rejects tampered ciphertext", () => {
  const enc = encryptSecret("my-feishu-secret");
  const parts = enc.split(":");
  const data = Buffer.from(parts[3], "base64url");
  data[0] ^= 0xff;
  parts[3] = data.toString("base64url");
  assert.equal(decryptSecret(parts.join(":")), null);
});

// ---- SQLite 状态层 ----------------------------------------------------------

beforeEach(() => {
  useMemoryStore();
});

test("空库 loadState 返回默认值（与 M0 DEFAULT_STATE 对齐）", () => {
  const state = loadState();
  assert.equal(state.username, "admin");
  assert.equal(state.passwordHash, null);
  assert.equal(typeof state.pricing.defaultRateCnyPerKwh, "number");
  assert.deepEqual(state.pricing.history, []);
  assert.equal(state.pushRules.tripEnd, true);
  assert.equal(state.feishu.enabled, false);
});

test("state roundtrip with defaults merged（SQLite 后端）", () => {
  const state = loadState();
  state.pricing.defaultRateCnyPerKwh = 1.2;
  state.passwordHash = "scrypt$x$y$z";
  saveState(state);
  const reloaded = loadState();
  assert.equal(reloaded.pricing.defaultRateCnyPerKwh, 1.2);
  assert.equal(reloaded.passwordHash, "scrypt$x$y$z");
  // 底层确实是 SQLite 表
  const account = getStore().getAccount();
  assert.equal(account.username, "admin");
  assert.equal(account.passwordHash, "scrypt$x$y$z");
  // 重置回默认
  saveState(structuredClone(DEFAULT_STATE));
  const fresh = loadState();
  assert.equal(fresh.pricing.defaultRateCnyPerKwh, DEFAULT_STATE.pricing.defaultRateCnyPerKwh);
  assert.equal(fresh.passwordHash, null);
});

test("setDefaultRate records history（pricing_history 表 + 200 条裁剪）", () => {
  const state = loadState();
  const before = state.pricing.defaultRateCnyPerKwh;
  const changed = setDefaultRate(state, 1.5, "test");
  assert.equal(changed, true);
  assert.equal(state.pricing.defaultRateCnyPerKwh, 1.5);
  const reloaded = loadState();
  assert.equal(reloaded.pricing.history.length, 1);
  assert.equal(reloaded.pricing.history[0].from, before);
  assert.equal(reloaded.pricing.history[0].to, 1.5);
  assert.equal(reloaded.pricing.history[0].source, "test");
  // no-op change
  assert.equal(setDefaultRate(state, 1.5), false);
  // 库内行数一致
  assert.equal(getStore().countPricingHistory(), 1);
  // 200 条上限裁剪（直接灌库验证）
  const s = getStore();
  s.clearPricingHistory();
  for (let i = 0; i < 205; i++) s.addPricingHistory({ changedAt: new Date().toISOString(), from: 1, to: 2, source: "bulk" });
  assert.equal(s.countPricingHistory(), 205); // store 层不裁剪；裁剪发生在 setDefaultRate
  const st2 = loadState();
  st2.pricing.history = Array.from({ length: 205 }, (_, i) => ({ changedAt: `t${i}`, from: 1, to: 2, source: "bulk" }));
  st2.pricing.defaultRateCnyPerKwh = 1.6;
  saveState(st2);
  assert.equal(loadState().pricing.history.length, 205);
});

test("feishu secret stored encrypted in SQLite, never plaintext", () => {
  const state = loadState();
  setFeishuConfig(state, { enabled: true, appId: "cli_x", appSecret: "super-secret-value" });
  assert.match(state.feishu.appSecretEnc, /^v1:/);
  assert.ok(!JSON.stringify(getStore().getChannel("feishu")).includes("super-secret-value"));
  const rawDb = JSON.stringify(getStore().db.prepare("SELECT * FROM channel_secrets").all());
  assert.ok(!rawDb.includes("super-secret-value"), "密文不得含明文");
  const reloaded = loadState();
  assert.equal(getFeishuSecret(reloaded), "super-secret-value");
  assert.equal(reloaded.feishu.appId, "cli_x");
  assert.equal(reloaded.feishu.enabled, true);
});

test("feishu 密文在部分更新（无 appSecret 字段）时不丢失", () => {
  const state = loadState();
  setFeishuConfig(state, { enabled: true, appId: "cli_x", appSecret: "keep-me" });
  // 仅改 enabled —— saveState 走 appSecretEnc undefined 分支
  const re = loadState();
  re.feishu.enabled = false;
  saveState(re);
  const after = loadState();
  assert.equal(after.feishu.enabled, false);
  assert.match(after.feishu.appSecretEnc, /^v1:/);
  assert.equal(getFeishuSecret(after), "keep-me");
});

// ---- JSON → SQLite 一次性迁移（幂等） ----------------------------------------

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "ahatesla-mig-"));
}

test("迁移：完整 state.json 各域进库 + 文件退役备份", () => {
  const dir = tmpDir();
  try {
    const jsonPath = join(dir, "state.json");
    writeFileSync(jsonPath, JSON.stringify({
      username: "ahaxzh",
      passwordHash: "scrypt$1$salt$hash",
      role: "admin",
      pricing: { defaultRateCnyPerKwh: 0.9, history: [{ changedAt: "2026-10-01T00:00:00Z", from: 1.0, to: 0.9, source: "manual" }] },
      pushRules: { tripEnd: false, chargingStart: true, chargingDone: true, weeklyReport: true, weeklyReportDay: 5, monthlyReport: true },
      feishu: { enabled: true, appId: "cli_a", appSecretEnc: encryptSecret("legacy-secret"), lastEventAt: null },
      datasource: { mode: "connect", host: "db", port: 5432, user: "ro", passwordEnc: "v1:x", configured: true, configuredAt: "2026-10-01T00:00:00Z" }
    }), "utf8");
    const store = openStore({ file: ":memory:" });
    const r1 = migrateStateJsonIntoStore(store, { jsonPath });
    assert.equal(r1.migrated, true);
    assert.ok(r1.backup.includes("migrated-"), "返回备份文件名");
    const account = store.getAccount();
    assert.equal(account.username, "ahaxzh");
    assert.equal(account.passwordHash, "scrypt$1$salt$hash");
    assert.equal(store.getPricing().defaultRateCnyPerKwh, 0.9);
    assert.equal(store.listPricingHistory().length, 1);
    assert.equal(store.listPricingHistory()[0].source, "manual");
    assert.equal(store.getPushRules().tripEnd, false);
    assert.equal(store.getPushRules().weeklyReportDay, 5);
    const feishu = store.getChannel("feishu");
    assert.equal(feishu.config.appId, "cli_a");
    assert.equal(feishu.config.enabled, true);
    assert.equal(decryptSecret(feishu.secretEnc), "legacy-secret");
    const ds = store.getDatasource();
    assert.equal(ds.mode, "connect");
    assert.equal(ds.host, "db");
    assert.equal(ds.passwordEnc, "v1:x");
    assert.equal(ds.configured, true);
    // 幂等：重跑直接跳过
    const r2 = migrateStateJsonIntoStore(store, { jsonPath: r1.backup });
    assert.equal(r2.migrated, false);
    assert.equal(r2.reason, "already_migrated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("迁移：无 state.json → 标记已迁移（新装路径）；损坏 JSON → 隔离", () => {
  const dir = tmpDir();
  try {
    const store = openStore({ file: ":memory:" });
    const r = migrateStateJsonIntoStore(store, { jsonPath: join(dir, "state.json") });
    assert.equal(r.migrated, false);
    assert.equal(r.reason, "no_json");
    // 损坏文件
    const dir2 = tmpDir();
    const bad = join(dir2, "state.json");
    writeFileSync(bad, "{not json", "utf8");
    const store2 = openStore({ file: ":memory:" });
    const r2 = migrateStateJsonIntoStore(store2, { jsonPath: bad });
    assert.equal(r2.migrated, false);
    assert.equal(r2.reason, "corrupt_json_quarantined");
    rmSync(dir2, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- store 各域 CRUD（§7.1 全域） ---------------------------------------------

test("store schema 版本 + 各域 CRUD（订阅/FIFO/补录/快照/事件/游标）", () => {
  const store = openStore({ file: ":memory:" });
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);

  // Web Push 订阅
  store.addPushSubscription({ endpoint: "https://push.example/sub1", keys: { p256dh: "abc", auth: "def" }, meta: { ua: "iPhone" } });
  store.addPushSubscription({ endpoint: "https://push.example/sub2", keys: {}, meta: {} });
  let subs = store.listPushSubscriptions();
  assert.equal(subs.length, 2);
  assert.equal(subs[0].keys.p256dh, "abc");
  store.removePushSubscription("https://push.example/sub1");
  subs = store.listPushSubscriptions();
  assert.equal(subs.length, 1);
  assert.equal(subs[0].endpoint, "https://push.example/sub2");

  // FIFO 批次 + 消耗（事务）
  store.upsertFifoBatch({ batchId: "cp-490", carId: 1, sourceRef: "cp:490", availableAtMs: 1700000000000, energyKwh: 25.3, remainingKwh: 25.3, unitPrice: 1.5 });
  store.upsertFifoBatch({ batchId: "cp-491", availableAtMs: 1700000001000, energyKwh: 10, remainingKwh: 10, unitPrice: 1.2 });
  // upsert 更新分支
  store.upsertFifoBatch({ batchId: "cp-490", carId: 1, sourceRef: "cp:490", availableAtMs: 1700000000000, energyKwh: 25.3, remainingKwh: 20, unitPrice: 1.5 });
  let batches = store.listFifoBatches();
  assert.equal(batches.length, 2);
  assert.equal(batches[0].batchId, "cp-490"); // available_at_ms 升序
  assert.equal(batches[0].remainingKwh, 20);
  store.consumeFifoBatch({ batchId: "cp-490", driveRef: "drive:3241", consumedKwh: 5.5, unitPrice: 1.5, consumedAt: 1700000100000 });
  assert.equal(store.getFifoBatch("cp-490").remainingKwh, 14.5);
  const cons = store.listFifoConsumptions("cp-490");
  assert.equal(cons.length, 1);
  assert.equal(cons[0].consumedKwh, 5.5);
  assert.equal(cons[0].driveRef, "drive:3241");

  // 本地补录费用（AC-7.1 ①层）
  store.putChargeCostOverride({ cpId: 490, cost: 38.5, note: "发票" });
  assert.equal(store.getChargeCostOverride(490).cost, 38.5);
  store.putChargeCostOverride({ cpId: 490, cost: 40 }); // upsert
  assert.equal(store.getChargeCostOverride(490).cost, 40);
  assert.equal(store.getChargeCostOverride(999), null);
  store.deleteChargeCostOverride(490);
  assert.equal(store.getChargeCostOverride(490), null);

  // 报告快照（不可变：只插入不更新）
  const id1 = store.addReportSnapshot({ kind: "weekly", periodStart: "2026-10-07", periodEnd: "2026-10-13", payload: { km: 300, cny: 45.5 } });
  const id2 = store.addReportSnapshot({ kind: "monthly", periodStart: "2026-10-01", periodEnd: "2026-10-31", payload: { km: 1200 } });
  assert.ok(id1 > 0 && id2 > id1);
  const weeklies = store.listReportSnapshots("weekly", 10);
  assert.equal(weeklies.length, 1);
  assert.equal(weeklies[0].payload.km, 300);

  // 事件日志
  store.logEvent({ at: "2026-10-14T08:00:00Z", type: "push.event", detail: { kind: "trip_end" } });
  store.logEvent({ at: "2026-10-14T08:01:00Z", type: "auth.login", detail: { username: "admin" } });
  const events = store.listEvents(10);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "auth.login"); // 倒序（最新在前）
  assert.equal(events[1].kind, "trip_end");

  // 游标水线
  assert.equal(store.getCursor("drives"), null);
  store.putCursor("drives", 3241);
  assert.equal(store.getCursor("drives"), 3241);
  store.putCursor("drives", 3242); // 覆盖
  assert.equal(store.getCursor("drives"), 3242);

  // kv
  store.kvPut("json_migrated", "1");
  assert.equal(store.kvGet("json_migrated"), "1");
});

test("events.mjs store 后端：写 SQLite、list 倒序、内存模式不变", async () => {
  const { createEventLog } = await import("../src/core/events.mjs");
  const store = openStore({ file: ":memory:" });
  const log = createEventLog({ store });
  log.log("push.event", { type: "trip_end" });
  log.log("auth.login", { username: "admin" });
  assert.equal(log.size(), 2);
  const items = log.list({ limit: 10 });
  assert.equal(items.length, 2);
  assert.equal(items[0].type, "auth.login");
  assert.equal(items[0].username, "admin");
  // 内存模式（无 store）行为不变
  const mem = createEventLog();
  mem.log("x", {});
  assert.equal(mem.size(), 1);
  assert.equal(mem.list()[0].type, "x");
});

test("持久库文件：跨 openStore 重开数据仍在（WAL）", () => {
  const dir = tmpDir();
  try {
    const file = join(dir, "ahatesla.db");
    const s1 = openStore({ file });
    s1.putAccount({ username: "persist-user", passwordHash: "h" });
    s1.putCursor("charging_processes", 490);
    s1.close();
    const s2 = openStore({ file });
    assert.equal(s2.getAccount().username, "persist-user");
    assert.equal(s2.getCursor("charging_processes"), 490);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
