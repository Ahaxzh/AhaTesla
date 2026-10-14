// pricing routes — default rate (local state) + geofence mirror (read-only).
import { HttpError } from "./http-kit.mjs";
import { getGeofences } from "../core/teslamate-queries.mjs";
import { setDefaultRate } from "../core/state.mjs";
import { finiteNumber } from "../core/util.mjs";

export function createPricingRoutes({ db, state, setDefaultRateFn = setDefaultRate }) {
  return {
    async list(ctx) {
      const geofences = await getGeofences(db);
      return {
        defaultRateCnyPerKwh: state.pricing.defaultRateCnyPerKwh,
        locations: geofences.map((geofence) => ({
          id: geofence.id,
          name: geofence.name,
          pricePerUnit: finiteNumber(geofence.price_per_unit),
          sessionFee: finiteNumber(geofence.session_fee),
          billingType: geofence.billing_type || "per_kwh"
        }))
      };
    },

    async setDefault(ctx) {
      const rate = finiteNumber(ctx.body?.rate);
      if (rate === null || rate < 0 || rate > 20) {
        throw new HttpError(400, "bad_request", "rate must be a number in [0, 20] (CNY/kWh)");
      }
      setDefaultRateFn(state, rate, "api");
      return { ok: true, defaultRateCnyPerKwh: state.pricing.defaultRateCnyPerKwh };
    },

    async history(ctx) {
      return (state.pricing.history || []).slice().reverse();
    }
  };
}
