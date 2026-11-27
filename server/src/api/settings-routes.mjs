// settings-routes.mjs — /api/settings（GA-36 实例设置：货币/单位/时区/油车基准/多车）。
// 自 dashboard-extra-routes.mjs 迁出（一处一域：dashboard 模块不再夹带设置域）。
import { HttpError } from "./http-kit.mjs";
import { finiteNumber } from "../core/util.mjs";
import { getGeocodingConfig, saveGeocodingConfig } from "../core/geo-geocode.mjs";

export function createSettingsRoutes({ state, getStore }) {
  const DEFAULTS = {
    currency: { symbol: "¥", code: "CNY" },
    distanceUnit: "km",
    timezone: "Asia/Shanghai",
    fuelBaseline: { literPer100km: 8.0, fuelPriceCnyPerL: 8.20 }
  };

  function current() {
    return {
      currency: state.settings?.currency ?? DEFAULTS.currency,
      distanceUnit: state.settings?.distanceUnit ?? DEFAULTS.distanceUnit,
      timezone: state.settings?.timezone ?? DEFAULTS.timezone,
      fuelBaseline: { ...DEFAULTS.fuelBaseline, ...(state.fuelBaseline || {}) },
      // m4e 多车:主车设定 + 车别名(carId → 别名,推送/界面显示用)
      primaryCarId: state.settings?.primaryCarId ?? null,
      carAliases: state.settings?.carAliases ?? {}
    };
  }

  return {
    async get(ctx) {
      return { ...current(), geocoding: getGeocodingConfig() };
    },
    async put(ctx) {
      const body = ctx.body || {};
      // geocoding（可选高德逆地理）单走渠道表（key 密文），不进 settings kv
      if (body.geocoding !== undefined) {
        const g = body.geocoding || {};
        if (typeof g !== "object") throw new HttpError(400, "bad_request", "geocoding must be object");
        if (g.amapKey !== undefined && g.amapKey !== null && typeof g.amapKey !== "string") {
          throw new HttpError(400, "bad_request", "geocoding.amapKey must be string");
        }
        if (g.amapKey) {
          const key = g.amapKey.trim();
          if (key.length < 8 || key.length > 64) throw new HttpError(400, "bad_request", "amapKey length must be 8-64");
        }
        saveGeocodingConfig({ enabled: Boolean(g.enabled), amapKey: g.amapKey });
      }
      const s = { ...(state.settings || {}) };
      if (body.currency !== undefined) {
        const symbols = ["¥", "$", "€", "£"];
        if (typeof body.currency !== "object" || !symbols.includes(body.currency.symbol)) {
          throw new HttpError(400, "bad_request", "currency.symbol must be one of ¥/$/€/£");
        }
        s.currency = { symbol: body.currency.symbol, code: body.currency.code || "CNY" };
      }
      if (body.distanceUnit !== undefined) {
        if (body.distanceUnit !== "km" && body.distanceUnit !== "mi") {
          throw new HttpError(400, "bad_request", "distanceUnit must be km or mi");
        }
        s.distanceUnit = body.distanceUnit;
      }
      if (body.timezone !== undefined) {
        try { new Intl.DateTimeFormat("en-CA", { timeZone: body.timezone }); } catch {
          throw new HttpError(400, "bad_request", "invalid timezone");
        }
        s.timezone = body.timezone;
      }
      // m4e 多车:主车与别名。primaryCarId=null 表示清除(回退向导绑定);
      // carAliases 整体替换,键为 carId 字符串,值 ≤32 字符,≤32 键。
      if (body.primaryCarId !== undefined) {
        if (body.primaryCarId === null) s.primaryCarId = null;
        else {
          const n = Number(body.primaryCarId);
          if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "bad_request", "primaryCarId must be a positive integer or null");
          s.primaryCarId = n;
        }
      }
      if (body.carAliases !== undefined) {
        if (body.carAliases === null || typeof body.carAliases !== "object" || Array.isArray(body.carAliases)) {
          throw new HttpError(400, "bad_request", "carAliases must be an object");
        }
        const entries = Object.entries(body.carAliases);
        if (entries.length > 32) throw new HttpError(400, "bad_request", "too many carAliases entries (max 32)");
        const out = {};
        for (const [k, v] of entries) {
          if (!/^\d+$/.test(String(k))) throw new HttpError(400, "bad_request", "carAliases keys must be numeric car ids");
          if (typeof v !== "string" || !v.trim() || v.length > 32) throw new HttpError(400, "bad_request", "carAliases values must be 1-32 chars");
          out[String(k)] = v.trim();
        }
        s.carAliases = out;
      }
      state.settings = s;
      if (body.fuelBaseline !== undefined) {
        const fb = body.fuelBaseline;
        const liter = finiteNumber(fb?.literPer100km);
        const price = finiteNumber(fb?.fuelPriceCnyPerL);
        if (liter === null || liter <= 0 || liter > 30) throw new HttpError(400, "bad_request", "fuelBaseline.literPer100km must be in (0,30]");
        if (price === null || price <= 0 || price > 50) throw new HttpError(400, "bad_request", "fuelBaseline.fuelPriceCnyPerL must be in (0,50]");
        state.fuelBaseline = { literPer100km: liter, fuelPriceCnyPerL: price };
      }
      const store = getStore();
      store.kvPut("app:settings", JSON.stringify({
        currency: s.currency, distanceUnit: s.distanceUnit, timezone: s.timezone,
        ...(s.primaryCarId != null ? { primaryCarId: s.primaryCarId } : {}),
        ...(s.carAliases ? { carAliases: s.carAliases } : {})
      }));
      if (state.fuelBaseline) store.kvPut("app:fuelBaseline", JSON.stringify(state.fuelBaseline));
      return { ok: true, settings: current() };
    }
  };
}
