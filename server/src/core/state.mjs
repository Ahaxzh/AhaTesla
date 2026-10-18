// state.mjs — 应用状态入口（t_46fd8a8a 后：SQLite 持久层）。
//
// 历史与现状：
//   - M0：状态存 server/data/state.json（JSON 文件），密钥 server/data/secret.key。
//   - M1（PRD §7.1 / GA-01）：自有数据全部落 server/data/ahatesla.db（node:sqlite），
//     state.json 在首次启动时一次性迁移进库后退役（改名保留为备份）。
//
// 兼容层设计（为零改动保留全部消费方签名）：
//   loadState()/saveState() 继续返回/接受原来的 state 形状
//   （username/passwordHash/pricing/pushRules/feishu/datasource/…），
//   但读写直达 SQLite —— saveState(state) 现在是“全量同步到库”。
//   setDefaultRate/setFeishuConfig/getFeishuSecret 语义不变。
//
// secret.key（AES-GCM 主密钥）继续保留为独立文件：它是数据库密文的加密密钥，
// 属引导级凭据（chicken-and-egg），按 §7.2 由 .env APP_SECRET_KEY 或该文件承载。

import {
  openStore, migrateStateJsonIntoStore, DEFAULT_DB_FILE
} from "./store.mjs";
import { encryptSecret, decryptSecret } from "./secret-box.mjs";

export const DEFAULT_STATE = {
  version: 2, // v2 = SQLite 时代；v1 = state.json 时代
  username: "admin",
  passwordHash: null, // scrypt hash; created by /setup wizard (AC-1.4)
  pricing: {
    defaultRateCnyPerKwh: 1.0,
    history: [] // [{changedAt, from, to, source}]
  },
  pushRules: {
    tripEnd: true,
    chargingStart: true,
    chargingDone: true,
    weeklyReport: true,
    weeklyReportDay: 1,
    monthlyReport: true
  },
  feishu: {
    enabled: false,
    appId: "",
    appSecretEnc: null, // encrypted, never returned to clients
    lastEventAt: null
  }
};

// ---- SQLite 单例（进程内共享；测试可用 useMemoryStore/useStateFile 切换） -------

let store = null;

function testSafeStore() {
  // 测试红线：node --test 进程（或显式 AHA_STATE_IN_MEMORY=1）绝不触碰真实库，
  // 强制内存库 —— 防止误迁移/污染 server/data/ahatesla.db。
  return process.env.AHA_STATE_IN_MEMORY === "1" || Boolean(process.env.NODE_TEST_CONTEXT);
}

/** 进程级单例：首次调用打开 server/data/ahatesla.db 并执行 JSON→SQLite 迁移。 */
export function getStore() {
  if (store) return store;
  if (testSafeStore()) {
    store = openStore({ file: ":memory:" });
    return store;
  }
  store = openStore({ file: DEFAULT_DB_FILE });
  try {
    const result = migrateStateJsonIntoStore(store);
    if (result.migrated) {
      process.stdout.write(`[state] state.json 已迁移至 SQLite（备份：${result.backup}）\n`);
    }
  } catch (error) {
    process.stderr.write(`[state] JSON→SQLite 迁移失败（忽略，继续空库启动）：${error?.message}\n`);
  }
  return store;
}

/** 测试辅助：注入内存库。返回先前 store（供恢复）。 */
export function useMemoryStore() {
  const prev = store;
  store = openStore({ file: ":memory:" });
  return prev;
}

/** 测试辅助：注入指定文件库。 */
export function useStateFile(file) {
  const prev = store;
  store = openStore({ file });
  return prev;
}

/** 深度默认值合并（沿用 M0 语义：数组整体覆盖、null 保底为 base）。 */
function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base === "object" && typeof override === "object" && base !== null) {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = key in base ? deepMerge(base[key], override[key]) : override[key];
    }
    return out;
  }
  return override;
}

/** DB 行 → 旧 state 形状（供 API 层零改动消费）。 */
function stateFromStore(s) {
  const state = structuredClone(DEFAULT_STATE);
  const account = s.getAccount();
  if (account) {
    state.username = account.username;
    state.passwordHash = account.passwordHash;
    if (account.role) state.role = account.role;
  }
  const pricing = s.getPricing();
  if (pricing && typeof pricing.defaultRateCnyPerKwh === "number") {
    state.pricing.defaultRateCnyPerKwh = pricing.defaultRateCnyPerKwh;
  }
  state.pricing.history = s.listPricingHistory();
  state.pushRules = { ...state.pushRules, ...s.getPushRules() };
  const feishu = s.getChannel("feishu");
  if (feishu) {
    state.feishu = {
      enabled: Boolean(feishu.config.enabled),
      appId: String(feishu.config.appId ?? ""),
      appSecretEnc: feishu.secretEnc,
      lastEventAt: feishu.config.lastEventAt ?? null,
      ...(feishu.config.openId ? { openId: feishu.config.openId } : {})
    };
  }
  const ds = s.getDatasource();
  if (ds) {
    state.datasource = ds; // {mode,host,port,database,user,passwordEnc,carId,configured,configuredAt,cars?}
  }
  return state;
}

/** 旧 state 形状 → DB 行（全量同步）。 */
function stateIntoStore(s, state) {
  if (state.username !== undefined || state.passwordHash !== undefined) {
    const cur = s.getAccount();
    s.putAccount({
      username: state.username !== undefined ? state.username : (cur?.username ?? "admin"),
      passwordHash: state.passwordHash !== undefined ? state.passwordHash : (cur?.passwordHash ?? null),
      role: state.role !== undefined ? state.role : (cur?.role ?? "admin")
    });
  }
  if (state.pricing) {
    s.putPricing({ defaultRateCnyPerKwh: state.pricing.defaultRateCnyPerKwh });
    s.clearPricingHistory();
    for (const h of Array.isArray(state.pricing.history) ? state.pricing.history : []) {
      s.addPricingHistory(h);
    }
  }
  if (state.pushRules) s.putPushRules(state.pushRules);
  if (state.feishu) {
    const cur = s.getChannel("feishu");
    const curConfig = cur?.config ?? {};
    s.putChannel("feishu", {
      config: {
        enabled: state.feishu.enabled ?? false,
        appId: state.feishu.appId ?? "",
        lastEventAt: state.feishu.lastEventAt ?? null,
        ...(state.feishu.openId ? { openId: state.feishu.openId } : {})
      },
      // appSecretEnc 传 undefined 时保留旧密文（不丢密钥）；显式 null 走清空。
      secretEnc: state.feishu.appSecretEnc !== undefined ? state.feishu.appSecretEnc : (cur?.secretEnc ?? null)
    });
    // putChannel 的 coalesce 语义：null 不覆盖 —— 显式清空走这里：
    if (state.feishu.appSecretEnc === null) clearChannelSecret(s, "feishu");
  }
  if (state.datasource) s.putDatasource(state.datasource);
}

/** putChannel 的 ON CONFLICT 用 coalesce 保留旧密文；显式置 null 需单独 UPDATE。 */
export function clearChannelSecret(s, channel) {
  s.db.prepare("UPDATE channel_secrets SET secret_enc=NULL WHERE channel=?").run(String(channel));
}

export function loadState() {
  return stateFromStore(getStore());
}

export function saveState(state) {
  const s = getStore();
  stateIntoStore(s, state);
  return state;
}

// 兼容导出：旧 state.json 路径（迁移后文件已退役改名；供脚本/诊断探测用）。
import { dataDir } from "./secret-box.mjs";
import { join } from "node:path";
export function statePath() {
  return join(dataDir(), "state.json");
}

export function setDefaultRate(state, rate, source = "manual") {
  const from = state.pricing.defaultRateCnyPerKwh;
  if (from === rate) return false;
  state.pricing.defaultRateCnyPerKwh = rate;
  state.pricing.history.push({ changedAt: new Date().toISOString(), from, to: rate, source });
  if (state.pricing.history.length > 200) state.pricing.history.splice(0, state.pricing.history.length - 200);
  saveState(state);
  return true;
}

export function setFeishuConfig(state, { enabled, appId, appSecret }) {
  if (typeof enabled === "boolean") state.feishu.enabled = enabled;
  if (appId !== undefined) state.feishu.appId = String(appId ?? "");
  if (appSecret) state.feishu.appSecretEnc = encryptSecret(appSecret);
  saveState(state);
  return state.feishu;
}

export function getFeishuSecret(state) {
  if (!state.feishu.appSecretEnc) return null;
  return decryptSecret(state.feishu.appSecretEnc);
}

export { encryptSecret, decryptSecret };
