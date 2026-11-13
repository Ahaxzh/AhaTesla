// charging routes — list + stats with per-location aggregation.
import { HttpError } from "./http-kit.mjs";
import { listCharging, countCharging, listChargingForStats, getChargingProcessById, getChargesCurve } from "../core/teslamate-queries.mjs";
import { carIdFromQuery } from "./car-scope.mjs";
import { priceChargingSession } from "../core/pricing-ledger.mjs";
import { pricingOptionsFor, overridesMapFromStore, instanceTimezone } from "../core/pricing-options.mjs";
import { isoFromTeslaMate, round, finiteNumber, wallClockToUtcMs } from "../core/util.mjs";

export function createChargingRoutes({ db, state, getStore }) {
  function defaultRate() {
    return state.pricing.defaultRateCnyPerKwh;
  }

  // month "YYYY-MM" 且月份合法（"2026-99" 之类的旧路径会一路炸成 500）
  function validMonth(value) {
    const m = /^(\d{4})-(\d{2})$/.test(String(value || "")) ? String(value) : null;
    if (!m) return null;
    const mon = Number(m.slice(5));
    return mon >= 1 && mon <= 12 ? m : null;
  }

  // from/to 日期区间（v0.3 与行程页统一交互）：非法值 400，空值 null
  function validIso(value, field) {
    if (value === undefined || value === null || value === "") return null;
    if (Number.isNaN(new Date(value).getTime())) throw new HttpError(400, "bad_request", `invalid ${field} timestamp`);
    return new Date(value).toISOString();
  }

  // 统一计价选项（补录/TOU/tz）—— 修复旧 overridesMap 读错列名（cpId）导致
  // 补录从未在充电页生效的问题，并让 TOU 分时同样作用于充电列表/统计。
  async function pricingOptions() {
    return pricingOptionsFor(db, state);
  }

  // 费用来源 → 三态标记（P4 视图A）：manual（TeslaMate 已录 + 本地补录）/ geofence / default
  function toChargeView(row, options) {
    const priced = priceChargingSession(row, defaultRate(), options);
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
      const month = validMonth(ctx.query.month);
      const from = validIso(ctx.query.from, "from");
      const to = validIso(ctx.query.to, "to");
      const carId = carIdFromQuery(ctx, state); // m4e
      const options = await pricingOptions();
      const rows = await listCharging(db, { limit, offset, month, from, to, carId, tz: instanceTimezone(state) });
      const total = await countCharging(db, { month, from, to, carId, tz: instanceTimezone(state) });
      return { total, items: rows.map((r) => toChargeView(r, options)) };
    },

    // GET /api/charging/:id（契约 B6）：功率曲线 + 桩端效率 + 费用来源 + 补录回显
    async detail(ctx) {
      const id = Number(ctx.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "bad_request", "invalid charging id");
      const row = await getChargingProcessById(db, id);
      if (!row) throw new HttpError(404, "not_found", "charging session not found");
      const options = await pricingOptions();
      const view = toChargeView(row, options);

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
        overrideCost: options.overrides?.has(id) ? options.overrides.get(id) : null
      };
    },

    async stats(ctx) {
      // v2.2：优先 month=YYYY-MM（自然月，北京时间），与列表口径完全一致；
      // period 仅作兼容（month=30天滚动窗口曾导致"本月20次"与列表8次对不上）
      const period = ctx.query.period === "all" ? "all" : ctx.query.period === "year" ? "year" : "month";
      const month = validMonth(ctx.query.month);
      // v0.3：日期区间优先于 month/period（与列表筛选一致）
      const rangeFrom = validIso(ctx.query.from, "from");
      const rangeTo = validIso(ctx.query.to, "to");
      let sinceIso;
      let untilIso = null;
      if (rangeFrom || rangeTo) {
        sinceIso = rangeFrom;
        untilIso = rangeTo;
      } else if (month) {
        // 实例时区自然月 → UTC 边界（tz 感知，非硬编码 +08:00）
        const tz = instanceTimezone(state);
        const [y, m] = month.split("-").map(Number);
        sinceIso = new Date(wallClockToUtcMs(tz, y, m, 1)).toISOString();
        untilIso = new Date(wallClockToUtcMs(tz, m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1)).toISOString();
      } else {
        sinceIso = period === "month"
          ? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
          : period === "year"
            ? new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString()
            : null;
      }
      const options = await pricingOptions();
      const rows = await listChargingForStats(db, { sinceIso, untilIso, carId: carIdFromQuery(ctx, state) });
      // DC/AC 判定(Grafana charging-costs 同思路): 任一采样 fast_charger_present → DC;
      // 名称含 supercharger/超充 → 超充,其余 DC → 其他快充
      const fastIds = new Set();
      try {
        const fast = await db.query(`
          SELECT DISTINCT c.charging_process_id AS id
          FROM charges c
          WHERE c.fast_charger_present IS TRUE
        `);
        for (const r of fast) fastIds.add(Number(r.id));
      } catch { /* charges 表不可达 → 全按 AC */ }
      const isSuperName = (row) => /supercharger|超充|super charger/i.test(String(row.geofence_name || "") + String(row.address_name || ""));

      let totalKwh = 0;
      let totalCost = 0;
      let pricedSessions = 0;
      let freeKwh = 0;
      const byType = { ac: { kwh: 0, cost: 0, count: 0 }, super: { kwh: 0, cost: 0, count: 0 }, dc: { kwh: 0, cost: 0, count: 0 } };
      const byMonth = new Map();
      const byLocation = new Map();
      for (const row of rows) {
        const priced = priceChargingSession(row, defaultRate(), options);
        const energy = finiteNumber(row.charge_energy_added) ?? 0;
        totalKwh += energy;
        if (priced.costCny !== null) {
          totalCost += priced.costCny;
          pricedSessions += 1;
        } else if (priced.source === "unknown" && row.cost != null && Number(row.cost) === 0) {
          freeKwh += energy; // 明确 cost=0(免费桩/家充无计量),而非"无法计价"
        }
        const type = fastIds.has(Number(row.id)) ? (isSuperName(row) ? "super" : "dc") : "ac";
        byType[type].kwh += energy;
        byType[type].count += 1;
        if (priced.costCny !== null) byType[type].cost += priced.costCny;
        const endIso = isoFromTeslaMate(row.end_date ?? row.end_at);
        if (endIso) {
          const month = endIso.slice(0, 7);
          const mb = byMonth.get(month) || { month, kwh: 0, cost: 0 };
          mb.kwh += energy;
          if (priced.costCny !== null) mb.cost += priced.costCny;
          byMonth.set(month, mb);
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
        byLocation: locations,
        // Grafana charging-costs-stats 提炼:充电成本三分 + 免费充电 + 月度趋势
        byType: {
          ac: { kwh: round(byType.ac.kwh, 1), cost: round(byType.ac.cost, 2), count: byType.ac.count },
          super: { kwh: round(byType.super.kwh, 1), cost: round(byType.super.cost, 2), count: byType.super.count },
          dc: { kwh: round(byType.dc.kwh, 1), cost: round(byType.dc.cost, 2), count: byType.dc.count }
        },
        freeKwh: round(freeKwh, 1),
        monthly: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-12)
          .map((m) => ({ month: m.month, kwh: round(m.kwh, 1), cost: round(m.cost, 2) }))
      };
    }
  };
}
