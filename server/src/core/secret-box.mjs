// AES-256-GCM secret encryption for locally stored third-party secrets
// (feishu appSecret). Key is generated once at server/data/secret.key.
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 数据目录默认 server/data；可用 AHA_DATA_DIR 覆盖（e2e 以临时目录拉起隔离实例，
// 不污染常驻实例的 state.json / secret.key）。
const DATA_DIR = process.env.AHA_DATA_DIR
  ? resolve(process.env.AHA_DATA_DIR)
  : join(__dirname, "..", "..", "data");

let cachedKey = null;

export function dataDir() {
  return DATA_DIR;
}

export function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

export function loadSecretKey() {
  if (cachedKey) return cachedKey;
  ensureDataDir();
  const keyPath = join(DATA_DIR, "secret.key");
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath);
    if (raw.length === 32) {
      cachedKey = raw;
      return cachedKey;
    }
  }
  cachedKey = randomBytes(32);
  writeFileSync(keyPath, cachedKey, { mode: 0o600 });
  return cachedKey;
}

export function encryptSecret(plaintext) {
  const key = loadSecretKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${enc.toString("base64url")}`;
}

export function decryptSecret(packed) {
  try {
    const [version, ivB64, tagB64, dataB64] = String(packed ?? "").split(":");
    if (version !== "v1") return null;
    const decipher = createDecipheriv("aes-256-gcm", loadSecretKey(), Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}
