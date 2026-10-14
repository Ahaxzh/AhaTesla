// charging routes — list + stats with per-location aggregation.
import { HttpError } from "./http-kit.mjs";
import { listCharging, countCharging, listChargingForStats } from "../core/teslamate-queries.mjs";
import { priceChargingSession } from "../core/pricing-ledger.mjs";
import { isoFromTeslaMate, round, finiteNumber } from "../core/util.mjs";

export function createChargingRoutes({ db, state }) {
  function defaultRate() {
    return state.pricing.defaultRateCnyPerKwh;
  }

  function toChargeView(row) {
    const priced = priceChargingSession(row, defaultRate());
    const energy = finiteNumber(row.charge_energy_added);
    return {
      id: row.id,
      startAt: isoFromTeslaMate(row.start_at),
      endAt: isoFromTeslaMate(row.end_at),
      locationName: row.geofence_name || row.address_name || "未知地点",
      energyAddedKWh: energy,
      costCny: priced.costCny,
      pricePerUnit: priced.pricePerUnit,
      startBattery: row.start_battery_level ?? null,
      endBattery: row.end_battery_level ?? null,
      durationMin: Number(row.duration_min) || 0,
      powerMaxKw: finiteNumber(row.power_max_kw),
      priceSource: priced.source
    };
  }

  return {
    async list(ctx) {
      const limit = Math.max(1, Math.min(200, Number(ctx.query.limit) || 50));
      const offset = Math.max(0, Number(ctx.query.offset) || 0);
      const rows = await listCharging(db, { limit, offset });
      const total = await countCharging(db);
      return { total, items: rows.map(toChargeView) };
    },

    async stats(ctx) {
      const period = ctx.query.period === "all" ? "all" : "month";
      const sinceIso = period === "month"
        ? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
        : null;
      const rows = await listChargingForStats(db, { sinceIso });
      let totalKwh = 0;
      let totalCost = 0;
      let pricedSessions = 0;
      const byLocation = new Map();
      for (const row of rows) {
        const priced = priceChargingSession(row, defaultRate());
        const energy = finiteNumber(row.charge_energy_added) ?? 0;
        totalKwh += energy;
        if (priced.costCny !== null) {
          totalCost += priced.costCny;
          pricedSessions += 1;
        }
        const name = row.geofence_name || row.address_name || "未知地点";
        const bucket = byLocation.get(name) || { name, count: 0, kwh: 0, cost: 0, pricedCount: 0 };
        bucket.count += 1;
        bucket.kwh += energy;
        if (priced.costCny !== null) {
          bucket.cost += priced.costCny;
          bucket.pricedCount += 1;
        }
        byLocation.set(name, bucket);
      }
      const locations = [...byLocation.values()].map((bucket) => ({
        name: bucket.name,
        count: bucket.count,
        kwh: round(bucket.kwh, 2),
        cost: round(bucket.cost, 2),
        pricePerUnit: bucket.kwh > 0 && bucket.pricedCount > 0 ? round(bucket.cost / bucket.kwh, 4) : null
      })).sort((a, b) => b.cost - a.cost);
      return {
        period,
        sessionCount: rows.length,
        totalKWh: round(totalKwh, 2),
        totalCostCny: round(totalCost, 2),
        avgPricePerKWh: totalKwh > 0 && pricedSessions > 0 ? round(totalCost / totalKwh, 4) : null,
        byLocation: locations
      };
    }
  };
}
