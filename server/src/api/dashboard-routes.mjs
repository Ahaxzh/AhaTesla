// dashboard + system routes.
import {
  getCarSnapshot, getDrivingState, getSystemStats, getMonthStats, getWeekStats,
  listCharging, listChargingForStats, resolveCarId
} from "../core/teslamate-queries.mjs";
import { listDrivesSql, monthStartIso } from "../core/teslamate-queries.mjs";
import { computeTripViews } from "./trips-routes.mjs";
import { priceChargingSession } from "../core/pricing-ledger.mjs";
import { isoFromTeslaMate, round, finiteNumber } from "../core/util.mjs";
import { isDemo } from "../core/demo-data.mjs";

export const VERSION = "0.1.0";
export const FUEL_REFERENCE = Object.freeze({
  // 油耗对标参考：92# 油价 × 常见油车 8L/100km。来源口径为内置假设，asOf 为常量。
  fuelPriceCnyPerL: 7.8,
  literPer100km: 8,
  source: "assumed: 92# gasoline × 8L/100km ICE baseline",
  asOf: "2026-01-01T00:00:00Z"
});

export function createDashboardRoutes({ db, state }) {
  async function recentChargesViews(limit) {
    const rows = await listCharging(db, { limit, offset: 0 });
    return rows.map((row) => {
      const priced = priceChargingSession(row, state.pricing.defaultRateCnyPerKwh);
      return {
        id: row.id,
        startAt: isoFromTeslaMate(row.start_at),
        endAt: isoFromTeslaMate(row.end_at),
        locationName: row.geofence_name || row.address_name || "未知地点",
        energyAddedKWh: finiteNumber(row.charge_energy_added),
        costCny: priced.costCny,
        pricePerUnit: priced.pricePerUnit,
        startBattery: row.start_battery_level ?? null,
        endBattery: row.end_battery_level ?? null,
        durationMin: Number(row.duration_min) || 0,
        powerMaxKw: finiteNumber(row.power_max_kw)
      };
    });
  }

  return {
    async dashboard(ctx) {
      // 主绑定 car_id（AC-2.3）：向导选定值优先，未绑定时回退快照第一辆车。
      let boundCarId = null;
      let car = null;
      try { car = await getCarSnapshot(db); } catch { /* teslamate down */ }
      boundCarId = resolveCarId(state, car?.id ?? null);
      if (boundCarId !== car?.id) {
        car = await getCarSnapshot(db, { carId: boundCarId }).catch(() => car);
      }
      const [driving, monthStats, weekStats] = await Promise.all([
        getDrivingState(db, { carId: boundCarId }),
        // 「本月」= 自然月（北京时间月初 00:00），与账本卡口径一致（v2.2 修复：原为 30 天滚动窗口导致里程/电费/省钱数互相对不上）
        getMonthStats(db, monthStartIso()),
        getWeekStats(db, new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString())
      ]);
      const { sql, params } = listDrivesSql({});
      const driveRows = await db.query(sql, [...params, 5, 0]);
      const recentTrips = await computeTripViews(db, driveRows, {
        defaultRate: state.pricing.defaultRateCnyPerKwh,
        history: state.pricing.history
      });
      const recentCharges = await recentChargesViews(5);

      // energy + cost for month/week from drive views over the same windows
      const { sql: monthSql, params: monthParams } = listDrivesSql({
        from: monthStartIso()
      });
      const monthDrives = await db.query(monthSql, [...monthParams, 200, 0]);
      const monthViews = await computeTripViews(db, monthDrives, {
        defaultRate: state.pricing.defaultRateCnyPerKwh,
        history: state.pricing.history
      });
      const monthEnergy = monthViews.reduce((total, view) => total + (view.energyKWh ?? 0), 0);
      const monthCost = monthViews.reduce((total, view) => total + (view.costCny ?? 0), 0);

      const { sql: weekSql, params: weekParams } = listDrivesSql({
        from: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
      });
      const weekDrives = await db.query(weekSql, [...weekParams, 200, 0]);
      const weekViews = await computeTripViews(db, weekDrives, {
        defaultRate: state.pricing.defaultRateCnyPerKwh,
        history: state.pricing.history
      });
      const weekEnergy = weekViews.reduce((total, view) => total + (view.energyKWh ?? 0), 0);
      const weekCost = weekViews.reduce((total, view) => total + (view.costCny ?? 0), 0);

      const monthDistance = finiteNumber(monthStats?.distance_km) ?? 0;
      // GA-17（AC-7.4）：油车基准可配置（state.fuelBaseline），默认 8.0L/100km @ ¥8.20/L（PRD 口径）
      const baseline = {
        literPer100km: 8.0,
        fuelPriceCnyPerL: 8.20,
        ...state.fuelBaseline
      };
      const fuelCost = round(monthDistance / 100 * baseline.fuelPriceCnyPerL * baseline.literPer100km, 2);

      return {
        car: {
          name: car?.name || "Tesla",
          currentBattery: car?.current_battery ?? null,
          rangeKm: finiteNumber(car?.range_km),
          state: driving?.state || "unknown",
          odometerKm: finiteNumber(car?.odometer_km),
          // 充电实时信息（charging state 时有值）
          charging: driving?.state === "charging" ? {
            batteryLevel: finiteNumber(driving?.charging_battery),
            powerKw: finiteNumber(driving?.charging_power)
          } : null
        },
        monthStats: {
          distanceKm: round(monthDistance, 1),
          energyKWh: round(monthEnergy, 2),
          costCny: round(monthCost, 2),
          driveCount: monthStats?.drive_count ?? 0,
          driveHours: round((monthStats?.drive_minutes ?? 0) / 60, 1)
        },
        weekStats: {
          distanceKm: round(finiteNumber(weekStats?.distance_km) ?? 0, 1),
          energyKWh: round(weekEnergy, 2),
          costCny: round(weekCost, 2)
        },
        fuelComparison: {
          fuelCostCny: fuelCost,
          baseline: `对比基准 ${baseline.literPer100km}L/100km @ ¥${baseline.fuelPriceCnyPerL}/L`,
          source: FUEL_REFERENCE.source,
          asOf: FUEL_REFERENCE.asOf
        },
        recentTrips,
        recentCharges
      };
    }
  };
}

export function createSystemRoutes({ db, mqtt, eventLog, startedAt = () => Date.now() }) {
  return {
    async status(ctx) {
      let dbOk = false;
      let stats = null;
      let latencyMs = null;
      let readonlyVerified = null;
      try {
        const t0 = Date.now();
        await db.ping();
        latencyMs = Date.now() - t0;
        dbOk = true;
        stats = await getSystemStats(db);
        // 只读校验（GA-31）：元数据探测（同 /setup 四级校验第3步逻辑）
        try {
          const probe = await db.queryOne(`
            SELECT has_table_privilege(current_user, 'public.drives', 'INSERT,UPDATE,DELETE,TRUNCATE') AS table_write,
                   has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create
          `);
          readonlyVerified = !(probe?.table_write === true || probe?.schema_create === true);
        } catch { readonlyVerified = null; }
      } catch { /* teslamate down */ }
      const teslamate = {
        dbOk,
        latencyMs,
        readonlyVerified,
        lastDriveAt: isoFromTeslaMate(stats?.last_drive_at),
        driveCount: stats?.drive_count ?? null
      };
      // AC-5.1 / §7.1：MQTT 为可选增强，仅在已配置时返回 mqtt 块；
      // 未配置时状态页不显示 MQTT 项（字段整体缺省，而非 false）。
      if (mqtt?.isConfigured?.()) {
        teslamate.mqtt = { ok: mqtt.isConnected?.() ?? false };
      }
      return {
        teslamate,
        ...(isDemo() ? { demo: true } : {}), // m4d：演示模式标记（前端可显示 Demo 徽标）
        uptime: Math.round((Date.now() - (typeof startedAt === "function" ? startedAt() : startedAt)) / 1000),
        version: VERSION
      };
    },

    async events(ctx) {
      const limit = Math.max(1, Math.min(500, Number(ctx.query.limit) || 100));
      return { items: eventLog.list({ limit }) };
    }
  };
}
