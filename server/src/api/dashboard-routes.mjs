// dashboard + system routes.
import {
  getCarSnapshot, getDrivingState, getSystemStats, getMonthStats, getWeekStats,
  listCharging, listChargingForStats, resolveCarId
} from "../core/teslamate-queries.mjs";
import { listDrivesSql, listDrivesLightSql, monthStartIso } from "../core/teslamate-queries.mjs";
import { computeTripViews } from "./trips-routes.mjs";
import { priceChargingSession } from "../core/pricing-ledger.mjs";
import { instanceTimezone } from "../core/pricing-options.mjs";
import { isoFromTeslaMate, round, finiteNumber } from "../core/util.mjs";
import { isDemo } from "../core/demo-data.mjs";
import { VERSION } from "../version.mjs";
import { carIdFromQuery, carsPayload } from "./car-scope.mjs";


export const FUEL_REFERENCE = Object.freeze({
  // 油耗对标参考：92# 油价 × 常见油车 8L/100km。来源口径为内置假设，asOf 为常量。
  fuelPriceCnyPerL: 7.8,
  literPer100km: 8,
  source: "assumed: 92# gasoline × 8L/100km ICE baseline",
  asOf: "2026-01-01T00:00:00Z"
});

/** 窗口内行程分页取全（修 LIMIT 200 静默截断月度电费的问题）。
 *  月/周聚合只要里程/能耗/成本，走轻量查询（无坐标 LATERAL，大库不超时）。 */
async function fetchAllDrivesInWindow(db, { from, to = null, carId = null }, pageSize = 1000) {
  const rows = [];
  for (let offset = 0; offset < 500_000; offset += pageSize) {
    const { sql, params } = listDrivesLightSql({ from, to, carId });
    const page = await db.query(sql, [...params, pageSize, offset]);
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

export function createDashboardRoutes({ db, state }) {
  async function recentChargesViews(limit, carId = null) {
    const rows = await listCharging(db, { limit, offset: 0, carId });
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
    // GET /api/cars(m4e):车辆清单 + 别名 + 主车标记;demo 模式走 demo 数据
    async cars(ctx) {
      return await carsPayload(db, state); // 契约:裸数组(前端 CarContext 按数组消费,包一层会炸 list.find)
    },

    async dashboard(ctx) {
      // 主绑定 car_id（AC-2.3 + m4e）：?carId= > settings.primaryCarId > 向导绑定 >
      // 快照第一辆车。未绑定且无参数时保持旧回退(快照第一辆)。
      // 快照/状态/月周统计/最近行程/最近充电并发拉取 —— 冷库下 positions 大索引
      // 首读是秒级磁盘 I/O，串行 await 会把首屏拖到 8s+（实测修复）。
      const requestedCarId = carIdFromQuery(ctx, state);
      const prefetchCarId = requestedCarId ?? resolveCarId(state, null);
      const [car0, driving0, monthStats, weekStats, driveRows, recentCharges] = await Promise.all([
        getCarSnapshot(db).catch(() => null),
        getDrivingState(db, { carId: prefetchCarId }).catch(() => null),
        getMonthStats(db, monthStartIso(new Date(), instanceTimezone(state)), prefetchCarId).catch(() => null),
        getWeekStats(db, new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(), prefetchCarId).catch(() => null),
        (async () => {
          const { sql, params } = listDrivesSql({ carId: prefetchCarId });
          return db.query(sql, [...params, 5, 0]).catch(() => []);
        })(),
        recentChargesViews(5, prefetchCarId).catch(() => [])
      ]);
      // 解析链以快照首车收口：与并发预估不一致时按最终车补拉（未绑定的多车库）
      const boundCarId = requestedCarId ?? resolveCarId(state, car0?.id ?? null);
      let car = car0;
      let driving = driving0;
      if (boundCarId !== prefetchCarId) {
        [car, driving] = await Promise.all([
          getCarSnapshot(db, { carId: boundCarId }).catch(() => car0),
          getDrivingState(db, { carId: boundCarId }).catch(() => driving0)
        ]);
      }
      const recentTrips = await computeTripViews(db, driveRows, {
        state,
        carId: boundCarId
      });

      // energy + cost for month/week from drive views over the same windows
      // （分页取全量：LIMIT 200 会在高频用车月静默截断月度电费）
      const monthDrives = await fetchAllDrivesInWindow(db, {
        from: monthStartIso(new Date(), instanceTimezone(state)), carId: boundCarId
      });
      const monthViews = await computeTripViews(db, monthDrives, {
        state,
        carId: boundCarId
      });
      const monthEnergy = monthViews.reduce((total, view) => total + (view.energyKWh ?? 0), 0);
      const monthCost = monthViews.reduce((total, view) => total + (view.costCny ?? 0), 0);

      const weekDrives = await fetchAllDrivesInWindow(db, {
        from: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(), carId: boundCarId
      });
      const weekViews = await computeTripViews(db, weekDrives, {
        state,
        carId: boundCarId
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
