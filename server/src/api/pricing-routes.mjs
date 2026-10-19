// pricing routes — default rate (local state) + geofence mirror + 围栏分时电价（TOU）。
import { HttpError } from "./http-kit.mjs";
import { getGeofences } from "../core/teslamate-queries.mjs";
import { setDefaultRate } from "../core/state.mjs";
import { bumpPricingVersion } from "../core/fifo-ledger.mjs";
import { finiteNumber } from "../core/util.mjs";

const TOU_KEY = (id) => `pricing:location-tou:${id}`;

const HM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
function validTou(tou) {
  if (!tou || typeof tou !== "object") return false;
  return HM_RE.test(String(tou.offPeakStart)) && HM_RE.test(String(tou.offPeakEnd))
    && finiteNumber(tou.offPeakRate) !== null && finiteNumber(tou.peakRate) !== null
    && finiteNumber(tou.offPeakRate) >= 0 && finiteNumber(tou.peakRate) >= 0;
}

export function createPricingRoutes({ db, state, setDefaultRateFn = setDefaultRate, getStore }) {
  function touFor(id) {
    const store = getStore?.();
    const raw = store?.kvGet?.(TOU_KEY(id));
    if (!raw) return null; // 无记录或空串（fixed 模式清除）
    try { return JSON.parse(raw); } catch { return null; }
  }

  return {
    async list(ctx) {
      const geofences = await getGeofences(db);
      return {
        defaultRateCnyPerKwh: state.pricing.defaultRateCnyPerKwh,
        locations: geofences.map((geofence) => {
          const tou = touFor(geofence.id);
          return {
            id: geofence.id,
            name: geofence.name,
            pricePerUnit: finiteNumber(geofence.price_per_unit),
            sessionFee: finiteNumber(geofence.session_fee),
            billingType: geofence.billing_type || "per_kwh",
            ...(tou ? { priceMode: "tou", tou } : { priceMode: "fixed" })
          };
        })
      };
    },

    // PUT /api/pricing/locations/:id（契约 §5 v2）：围栏固定价 ↔ 分时价双模切换。
    // body: {priceMode:"fixed", pricePerUnit?} | {priceMode:"tou", tou:{offPeakStart,offPeakEnd,offPeakRate,peakRate}}
    async updateLocation(ctx) {
      const id = Number(ctx.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "bad_request", "invalid location id");
      const body = ctx.body ?? {};
      const store = getStore?.();
      if (!store?.kvPut) throw new HttpError(500, "internal", "store unavailable");

      if (body.priceMode === "tou") {
        if (!validTou(body.tou)) {
          throw new HttpError(400, "bad_request", "tou requires {offPeakStart:'HH:MM', offPeakEnd:'HH:MM', offPeakRate>=0, peakRate>=0}");
        }
        store.kvPut(TOU_KEY(id), JSON.stringify(body.tou));
      } else if (body.priceMode === "fixed") {
        const rate = finiteNumber(body.pricePerUnit);
        if (rate !== null && (rate < 0 || rate > 20)) throw new HttpError(400, "bad_request", "pricePerUnit must be in [0, 20]");
        // 删除本地 TOU → 回落 teslamate geofence 固定价
        store.kvPut(TOU_KEY(id), "");
        // 空串表示清除；list 侧对空串返回 null
      } else {
        throw new HttpError(400, "bad_request", "priceMode must be 'fixed' or 'tou'");
      }
      bumpPricingVersion(); // 计价规则变化 → 全站回放缓存立即失效
      const tou = touFor(id);
      return { ok: true, id, priceMode: body.priceMode, ...(tou ? { tou } : {}) };
    },

    async setDefault(ctx) {
      const rate = finiteNumber(ctx.body?.rate);
      if (rate === null || rate < 0 || rate > 20) {
        throw new HttpError(400, "bad_request", "rate must be a number in [0, 20] (CNY/kWh)");
      }
      setDefaultRateFn(state, rate, "api");
      bumpPricingVersion();
      return { ok: true, defaultRateCnyPerKwh: state.pricing.defaultRateCnyPerKwh };
    },

    async history(ctx) {
      return (state.pricing.history || []).slice().reverse();
    }
  };
}
