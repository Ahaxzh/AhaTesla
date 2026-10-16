// charging routes — list + stats with per-location aggregation.
import { HttpError } from "./http-kit.mjs";
import { listCharging, countCharging, listChargingForStats, getChargingProcessById, getChargesCurve } from "../core/teslamate-queries.mjs";
import { priceChargingSession } from "../core/pricing-ledger.mjs";
import { isoFromTeslaMate, round, finiteNumber } from "../core/util.mjs";

export function createChargingRoutes({ db, state, getStore }) {
  function defaultRate() {
    return state.pricing.defaultRateCnyPerKwh;
  }

  function overridesMap() {
    const store = getStore?.();
    if (!store?.listChargeCostOverrides) return new Map();
    const map = new Map();
    for (const row of store.listChargeCostOverrides()) map.set(Number(row.charging_process_id), Number(row.cost));
    return map;
  }

  // 费用来源 → 三态标记（P4 视图A）：manual（TeslaMate 已录 + 本地补录）/ geofence / default
  function toChargeView(row, overrides) {
    const priced = priceChargingSession(row, defaultRate(), { overrides });
    const energy = finiteNumber(row.charge_energy_added);
    const costSource = priced.source === "manual" || priced.source === "stated"
      ? "manual"
      : priced.source === "geofence" || priced.source === "geofence-tou"
        ? "geofence"
        : priced.source === "default" ? "default" : "unknown";
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
      costSource
    };
  }

  return {
    async list(ctx) {
      const limit = Math.max(1, Math.min(200, Number(ctx.query.limit) || 50));
      const offset = Math.max(0, Number(ctx.query.offset) || 0);
      const month = /^\d{4}-\d{2}$/.test(String(ctx.query.month || "")) ? String(ctx.query.month) : null;
      const overrides = overridesMap();
      const rows = await listCharging(db, { limit, offset, month });
      const total = await countCharging(db, { month });
      return { total, items: rows.map((r) => toChargeView(r, overrides)) };
    },

    // GET /api/charging/:id（契约 B6）：功率曲线 + 桩端效率 + 费用来源 + 补录回显
    async detail(ctx) {
      const id = Number(ctx.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "bad_request", "invalid charging id");
      const row = await getChargingProcessById(db, id);
      if (!row) throw new HttpError(404, "not_found", "charging session not found");
      const overrides = overridesMap();
      const view = toChargeView(row, overrides);

      // 功率曲线（LTTB ≤300 点）：SoC 横轴 + 峰值打点（P4 单次详情）
      let powerCurve = [];
      let maxKw = null;
      let maxKwSoc = null;
      try {
        const charges = await getChargesCurve(db, id);
        const pts = charges
          .map((c) => ({
            soc: finiteNumber(c.battery_level),
            kw: finiteNumber(c.charger_power),
            x: finiteNumber(c.battery_level) ?? 0,
            y: finiteNumber(c.charger_power) ?? 0
          }))
          .filter((p) => p.soc !== null && p.kw !== null);
        const { lttbDownsample } = await import("./trips-routes.mjs");
        powerCurve = lttbDownsample(pts, 300).map((p) => ({ soc: p.soc, kw: p.kw }));
        let best = null;
        for (const p of pts) if (best === null || p.kw > best.kw) best = p;
        if (best) { maxKw = round(best.kw, 1); maxKwSoc = best.soc; }
      } catch { /* charges 表不可用 → 空曲线 */ }

      // 桩端效率（P4）：charge_energy_used（桩端）vs charge_energy_added（电池）。
      // 容错：NULL 或 ≤added 时隐藏损耗模块（PRD §6.3 P4）。
      const meterKwh = finiteNumber(row.charge_energy_used);
      const batteryKwh = finiteNumber(row.charge_energy_added);
      let efficiency = null;
      if (meterKwh !== null && batteryKwh !== null && meterKwh > batteryKwh && meterKwh > 0) {
        efficiency = {
          meterKwh: round(meterKwh, 2),
          batteryKwh: round(batteryKwh, 2),
          ratio: round(batteryKwh / meterKwh, 4),
          lossKwh: round(meterKwh - batteryKwh, 2)
        };
      }

      return {
        ...view,
        powerCurve,
        maxKw,
        maxKwSoc,
        efficiency,
        overrideCost: overrides.has(id) ? overrides.get(id) : null
      };
    },

    async stats(ctx) {
      // v2.2：优先 month=YYYY-MM（自然月，北京时间），与列表口径完全一致；
      // period 仅作兼容（month=30天滚动窗口曾导致"本月20次"与列表8次对不上）
      const period = ctx.query.period === "all" ? "all" : ctx.query.period === "year" ? "year" : "month";
      const month = /^\d{4}-\d{2}$/.test(String(ctx.query.month || "")) ? String(ctx.query.month) : null;
      let sinceIso;
      let untilIso = null;
      if (month) {
        // 北京时间自然月 → UTC 边界（+08:00）
        sinceIso = new Date(`${month}-01T00:00:00+08:00`).toISOString();
        const [y, m] = month.split("-").map(Number);
        untilIso = new Date(Date.UTC(y, m, 1, 0, 0, 0) - 8 * 3600 * 1000).toISOString();
      } else {
        sinceIso = period === "month"
          ? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
          : period === "year"
            ? new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString()
            : null;
      }
      const overrides = overridesMap();
      const rows = await listChargingForStats(db, { sinceIso, untilIso });
      let totalKwh = 0;
      let totalCost = 0;
      let pricedSessions = 0;
      const byLocation = new Map();
      for (const row of rows) {
        const priced = priceChargingSession(row, defaultRate(), { overrides });
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
