// Local state persistence: server/data/state.json
// Holds default electricity rate (+ history), push rules, feishu channel config,
// username/password hash. Secrets are stored AES-256-GCM encrypted.
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { encryptSecret, decryptSecret, dataDir, ensureDataDir } from "./secret-box.mjs";

export const DEFAULT_STATE = {
  version: 1,
  username: "admin",
  passwordHash: null, // scrypt hash; generated on first boot
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

export function statePath() {
  return join(dataDir(), "state.json");
}

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

export function loadState() {
  ensureDataDir();
  const path = statePath();
  if (!existsSync(path)) return structuredClone(DEFAULT_STATE);
  try {
    return deepMerge(structuredClone(DEFAULT_STATE), JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* best effort */ }
    return structuredClone(DEFAULT_STATE);
  }
}

let writeScheduled = false;
export function saveState(state) {
  ensureDataDir();
  const path = statePath();
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  return state;
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
