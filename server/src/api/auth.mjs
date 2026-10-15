// auth.mjs — scrypt password hashing + hand-rolled HS256 JWT.
// No bcrypt / no jsonwebtoken, per project constraints.
import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHmac } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt);
const SCRYPT_KEYLEN = 64;
export const TOKEN_TTL_S = 24 * 60 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;
export const TOKEN_COOKIE = "ahatesla_token";
export const REFRESH_COOKIE = "ahatesla_refresh";

// Refresh token 版本号（kv: auth:refresh_epoch）。改密/吊销全部会话时 +1，
// 令所有旧 refresh token 失效（无需逐 token 黑名单，单用户实例足够）。
import { getStore } from "../core/state.mjs";
export function refreshEpoch() {
  const store = getStore();
  return Number(store.kvGet("auth:refresh_epoch")) || 0;
}
export function bumpRefreshEpoch() {
  const store = getStore();
  const next = refreshEpoch() + 1;
  store.kvPut("auth:refresh_epoch", String(next));
  return next;
}

// ---- password hashing (scrypt, salted, format: scrypt$N$salt$hash) ----

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(String(password), salt, SCRYPT_KEYLEN, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, nRaw, saltB64, hashB64] = String(stored ?? "").split("$");
    if (scheme !== "scrypt") return false;
    const N = Number(nRaw) || 16384;
    const salt = Buffer.from(saltB64, "base64url");
    const expected = Buffer.from(hashB64, "base64url");
    const derived = await scrypt(String(password), salt, expected.length, { N, r: 8, p: 1 });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function generateInitialPassword() {
  // readable-ish: 4 groups of 4 base32 chars
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let part = "";
    for (let i = 0; i < 4; i++) part += alphabet[bytes[g * 4 + i] % alphabet.length];
    groups.push(part);
  }
  return groups.join("-");
}

// ---- HS256 JWT ----

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}

export function signJwt(payload, secret, { ttlS = TOKEN_TTL_S, now = Date.now() } = {}) {
  const header = { alg: "HS256", typ: "JWT" };
  const body = { ...payload, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttlS };
  const unsigned = `${b64urlJson(header)}.${b64urlJson(body)}`;
  const sig = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${sig}`;
}

export function verifyJwt(token, secret, { now = Date.now() } = {}) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  let header;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;
  const expected = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest();
  let sig;
  try {
    sig = Buffer.from(sigB64, "base64url");
  } catch {
    return null;
  }
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp === "number" && payload.exp * 1000 < now) return null;
  return payload;
}

export function jwtSecret(state) {
  // JWT secret derives from the data-dir secret key file; stable across restarts.
  const { loadSecretKey } = globalThis.__ahatesla_secret_loader?.() || {};
  return loadSecretKey ? loadSecretKey() : null;
}
