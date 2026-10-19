// geo-geocode.mjs — 可选的高德逆地理（"未知"点位地名补全）。
//
// 定位：围栏三级标签（围栏内/附近/未知）之后的**可选第④级**，默认关闭。
// 开启后，起终点落在所有围栏 1.5km 外的行程，会把该坐标（WGS84→GCJ02 纠偏后）
// 发往高德 Web 服务逆地理接口换取地名（如"山姆会员商店"），结果按坐标网格
// 缓存在本地 SQLite —— 同一地点只发一次。
//
// 隐私：这是全项目第一个"GPS 坐标出内网"的可选项。PRD §6.5-4 原文"绝不调用
// 外部逆地理 API"修订为：默认关闭；用户显式开启并填入自己的高德 Key 即视为
// 授权该坐标外发（仅"未知"级坐标，且经本地缓存去重）。行程页加载高德瓦片
// 本身已向高德暴露瓦片级粗略位置，此开关不改变瓦片行为。
//
// 坐标系：TeslaMate 存 WGS84；高德 API 只认 GCJ02 —— 必须先纠偏，否则在
// 国境内偏移 ~100-700m，会取到隔壁街的名字。
import { getStore, clearChannelSecret } from "./state.mjs";
import { encryptSecret, decryptSecret } from "./secret-box.mjs";
import { createHash } from "node:crypto";

const CHANNEL_ID = "geocoding";

// ---- WGS84 → GCJ02（国测局加密坐标，Web 端 RouteMap 同款算法） ------------------
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}

function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

/** WGS84 → GCJ02（境外原样返回，高德本身也只有境内数据） */
export function wgs84ToGcj02(wgsLat, wgsLng) {
  const lat = Number(wgsLat);
  const lng = Number(wgsLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || outOfChina(lng, lat)) return { lat, lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

// ---- 配置（渠道表：config 明文 + key 密文，与 AI 渠道同模式） --------------------

function db() {
  return getStore();
}

function readRaw() {
  const row = db().getChannel(CHANNEL_ID);
  return row ? { config: row.config || {}, secretEnc: row.secretEnc ?? null } : { config: {}, secretEnc: null };
}

export function getGeocodingConfig() {
  const { config, secretEnc } = readRaw();
  return {
    enabled: Boolean(config.enabled),
    hasKey: Boolean(secretEnc),
    keyAlias: config.keyAlias ?? null
  };
}

/** 保存配置；amapKey：undefined=不变，""=清除，非空=更新（AES-GCM 密文落库） */
export function saveGeocodingConfig({ enabled, amapKey } = {}) {
  const cur = readRaw();
  const nextConfig = {
    ...cur.config,
    enabled: Boolean(enabled),
    keyAlias: cur.config.keyAlias ?? null
  };
  let secretEnc = cur.secretEnc;
  if (amapKey === "") {
    // putChannel 的 ON CONFLICT 用 coalesce 保留旧密文 → 显式清除需单独 UPDATE
    secretEnc = null;
    nextConfig.keyAlias = null;
  } else if (typeof amapKey === "string" && amapKey.length > 0) {
    secretEnc = encryptSecret(amapKey.trim());
    nextConfig.keyAlias = createHash("sha256").update(amapKey.trim()).digest("hex").slice(0, 4);
  }
  db().putChannel(CHANNEL_ID, { config: nextConfig, secretEnc });
  if (secretEnc === null) {
    try { clearChannelSecret(db(), CHANNEL_ID); } catch { /* 兼容无该行的 store */ }
  }
  return getGeocodingConfig();
}

function amapKey() {
  const { secretEnc } = readRaw();
  return secretEnc ? decryptSecret(secretEnc) : null;
}

// ---- 逆地理（带坐标网格缓存） ----------------------------------------------------

const CACHE_PREFIX = "geo:amap:";
const coordKey = (lat, lng) => `${CACHE_PREFIX}${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;

/**
 * 解析一个 WGS84 坐标的地名（高德逆地理，POI 名优先）。
 * 返回 string 地名，或 null（未启用/无 Key/网络失败/无结果）。
 * 缓存：成功结果与"无结果"都按 ~11m 网格落 kv，永久有效；网络/接口错误不缓存。
 */
export async function resolveAmapLabel(lat, lng, { fetchImpl = globalThis.fetch, store = null } = {}) {
  if (lat == null || lng == null) return null;
  const kv = store ?? db();
  if (!kv?.kvGet) return null;

  const cfg = getGeocodingConfig();
  if (!cfg.enabled || !cfg.hasKey) return null;

  const key = coordKey(lat, lng);
  const cached = kv.kvGet(key);
  if (cached != null) return cached === "" ? null : cached;

  const gcj = wgs84ToGcj02(lat, lng);
  const url = `https://restapi.amap.com/v3/geocode/regeo?location=${gcj.lng.toFixed(6)},${gcj.lat.toFixed(6)}&extensions=all&key=${encodeURIComponent(amapKey() ?? "")}`;
  let name = null;
  let cacheable = false;
  try {
    const resp = await fetchImpl(url, { signal: AbortSignal.timeout(4000) });
    const data = await resp.json().catch(() => null);
    if (data && String(data.status) === "1" && data.regeocode) {
      cacheable = true;
      const poi = Array.isArray(data.regeocode.pois) ? data.regeocode.pois[0] : null;
      const addr = String(data.regeocode.formatted_address ?? "").trim();
      name = (poi?.name && String(poi.name).trim()) || (addr ? addr.split(/[省市]/).pop()?.trim() || addr : null) || null;
    }
  } catch {
    return null; // 网络/超时/接口错误：不缓存，下次再试
  }
  if (cacheable) kv.kvPut?.(key, name ?? "");
  return name;
}

/** 批量去重解析（同一批行程的多个端点并发，同网格只发一次） */
export async function resolveAmapLabels(points, opts = {}) {
  const unique = new Map();
  for (const p of points) {
    if (p?.lat == null || p?.lng == null) continue;
    unique.set(`${Number(p.lat).toFixed(4)},${Number(p.lng).toFixed(4)}`, p);
  }
  const entries = await Promise.all([...unique.values()].map(async (p) => [
    `${Number(p.lat).toFixed(4)},${Number(p.lng).toFixed(4)}`,
    await resolveAmapLabel(p.lat, p.lng, opts)
  ]));
  return new Map(entries);
}
