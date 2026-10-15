// ledger routes — 月度账本摘要 + 历史重算 + 充电费用补录（AC-7.3/7.5/7.6）。
//
// 数据流：charging_sessions（teslamate 只读）+ charge_cost_overrides（本地 SQLite）
// + pricing（默认价/围栏 TOU）→ pricing-ledger 计价/FIFO → 月度汇总。
// 重算为异步 job（jobId + 进度），补录费用 7 天窗口内触发重算（AC-7.6）。
import { HttpError } from "./http-kit.mjs";
import { finiteNumber, round } from "../core/util.mjs";
import {
  batchesFromChargingSessions,
  allocateDriveCosts,
  driveEnergyKwh,
  parkingLossBetween,
  PARKING_LOSS_THRESHOLD_KWH
} from "../core/pricing-ledger.mjs";
import { listChargingForStats, listDrivesSql, getGeofences } from "../core/teslamate-queries.mjs";

const FUEL_BASELINE_DEFAULT = Object.freeze({
  literPer100km: 8.0,
  fuelPriceCnyPerL: 8.20
});

// 内存 job 表（单实例自托管，进程内即可；job 只报告进度不落盘）。
const recalcJobs = new Map();
let recalcSeq = 0;

export function createLedgerRoutes({ db, state, getStore }) {
  function overridesMap() {
    const store = getStore();
    const map = new Map();
    // store.listChargeCostOverrides 由 store 层提供（全表小，直接载入）
    for (const row of store.listChargeCostOverrides?.() ?? []) {
      map.set(Number(row.cpId), Number(row.cost));
    }
    return map;
  }

  async function touByGeofenceId() {
    // 与 pricing-routes.updateLocation 同源：SQLite kv `pricing:location-tou:<id>`。
    // 围栏 id 列表来自 teslamate 只读查询。
    const store = getStore();
    const map = new Map();
    const geofences = await getGeofences(db);
    for (const geofence of geofences) {
      const raw = store.kvGet(`pricing:location-tou:${geofence.id}`);
      if (raw) {
        try { map.set(Number(geofence.id), JSON.parse(raw)); } catch { /* 忽略坏数据 */ }
      }
    }
    return map;
  }

  async function monthWindow(month) {
    // month: "YYYY-MM" → [startIso, endIso)
    const m = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
    if (!m) throw new HttpError(400, "bad_request", "month must be YYYY-MM");
    const year = Number(m[1]);
    const mon = Number(m[2]);
    if (mon < 1 || mon > 12) throw new HttpError(400, "bad_request", "month must be YYYY-MM");
    const start = new Date(Date.UTC(year, mon - 1, 1));
    const end = new Date(Date.UTC(year, mon, 1));
    return { startIso: start.toISOString(), endIso: end.toISOString() };
  }

  return {
    // POST /api/ledger/summary?month=YYYY-MM（契约 §5，v2 新增）
    async summary(ctx) {
      const month = ctx.query.month || new Date().toISOString().slice(0, 7);
      const { startIso, endIso } = await monthWindow(month);

      const charging = await listChargingForStats(db, { sinceIso: startIso });
      const monthCharging = charging.filter((row) => {
        const end = row.end_at ?? row.end_date;
        return end && end < endIso;
      });
      const batches = batchesFromChargingSessions(monthCharging, {
        overrides: overridesMap(),
        touByGeofenceId: await touByGeofenceId()
      });

      const { sql, params } = listDrivesSql({ from: startIso, to: endIso });
      // listDrivesSql 尾部 LIMIT $1 OFFSET $2 需要补分页参数（月度账本取全量，上限 5000）
      const driveRows = await db.query(sql, [...params, 5000, 0]);
      const drives = driveRows.map((drive) => ({
        id: drive.id,
        start_at: drive.start_at,
        estimated_kwh: driveEnergyKwh(drive),
        distance_km: drive.distance_km
      }));
      const { allocations } = allocateDriveCosts({
        drives,
        batches: batchesFromChargingSessions(charging, {
          overrides: overridesMap(),
          touByGeofenceId: await touByGeofenceId()
        }),
        defaultRate: state.pricing.defaultRateCnyPerKwh,
        defaultRateHistory: state.pricing.history
      });

      let distanceKm = 0;
      let energyKwh = 0;
      let drivingCost = 0;
      for (const drive of drives) {
        distanceKm += finiteNumber(drive.distance_km) ?? 0;
        energyKwh += drive.estimated_kwh ?? 0;
      }
      const allocById = new Map(allocations.map((a) => [String(a.drive_id), a]));
      for (const drive of drives) {
        const alloc = allocById.get(String(drive.id));
        if (alloc?.cost_cny_precise !== null && alloc?.cost_cny_precise !== undefined) {
          drivingCost += alloc.cost_cny_precise;
        }
      }

      // 驻车损耗（AC-7.5）：月内相邻事件表显差累计（>0.5kWh 阈值过滤负损耗）
      let parkingKwh = 0;
      let parkingCost = 0;
      const batchQueue = batchesFromChargingSessions(charging, {
        overrides: overridesMap(),
        touByGeofenceId: await touByGeofenceId()
      }).map((b) => ({
        ...b,
        remaining_kwh: b.energy_kwh,
        unit_price_cny_per_kwh: b.unit_price_cny_per_kwh
      }));
      // 简化口径：用充电会话起止 SOC 差 × 包容量近似，事件序列按时间排序
      const events = monthCharging
        .flatMap((row) => [
          { at: row.start_at ?? row.start_date, soc: row.start_battery_level },
          { at: row.end_at ?? row.end_date, soc: row.end_battery_level }
        ])
        .filter((e) => e.at && e.soc !== null && e.soc !== undefined)
        .sort((a, b) => new Date(a.at) - new Date(b.at));
      for (let i = 1; i < events.length; i++) {
        const loss = parkingLossBetween(events[i - 1].soc, events[i].soc, PARKING_LOSS_THRESHOLD_KWH);
        if (!loss) continue;
        parkingKwh += loss.kwh;
        // 以月初最早可用批次单价近似损耗成本（费用口径由 FIFO 扣减主导，此处汇总）
        const price = batchQueue.find((b) => b.remaining_kwh > 0)?.unit_price_cny_per_kwh;
        if (price !== null && price !== undefined) parkingCost += loss.kwh * price;
      }

      const baseline = state.fuelBaseline ?? FUEL_BASELINE_DEFAULT;
      const fuelCost = round(distanceKm / 100 * baseline.literPer100km * baseline.fuelPriceCnyPerL, 2);
      const totalCost = round(drivingCost + parkingCost, 2);

      return {
        month,
        distanceKm: round(distanceKm, 1),
        energyKwh: round(energyKwh, 2),
        totalCost,
        costPerKm: distanceKm > 0 ? round(totalCost / distanceKm, 4) : null,
        fuelComparison: {
          fuelCost,
          saving: round(fuelCost - totalCost, 2),
          baseline: `对比基准 ${baseline.literPer100km}L/100km @ ¥${baseline.fuelPriceCnyPerL}/L`
        },
        parkingLoss: {
          kwh: round(parkingKwh, 2),
          cost: round(parkingCost, 2)
        },
        breakdown: {
          drivingCost: round(drivingCost, 2),
          parkingCost: round(parkingCost, 2)
        }
      };
    },

    // POST /api/ledger/recalculate（AC-7.3）：异步 job，进度可查
    async startRecalculate(ctx) {
      const from = ctx.body?.from || null;
      const to = ctx.body?.to || null;
      const all = ctx.body?.all === true;
      if (!all && !from && !to) throw new HttpError(400, "bad_request", "provide from/to or all:true");
      const jobId = `recalc-${Date.now()}-${++recalcSeq}`;
      const job = { jobId, status: "running", progress: 0, startedAt: new Date().toISOString() };
      recalcJobs.set(jobId, job);
      // 单实例内存异步：立即返回 jobId，后台推进进度
      ;(async () => {
        try {
          const charging = await listChargingForStats(db, {});
          const overrides = overridesMap();
          const tou = await touByGeofenceId();
          const batches = batchesFromChargingSessions(charging, { overrides, touByGeofenceId: tou });
          // 重算本质：批次池与分摊全部由函数式计算，写入 SQLite fifo_batches/消耗表
          const store = getStore();
          for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            store.putFifoBatch?.({
              batchId: batch.batch_id,
              sourceRef: `charging_process:${batch.charging_process_id}`,
              availableAtMs: batch.available_at_ms,
              energyKwh: batch.energy_kwh,
              remainingKwh: batch.energy_kwh,
              unitPrice: batch.unit_price_cny_per_kwh,
              metaJson: JSON.stringify({ source: batch.source, amount: batch.amount_cny })
            });
            job.progress = Math.round(((i + 1) / batches.length) * 100);
          }
          job.status = "done";
          job.progress = 100;
        } catch (error) {
          job.status = "error";
          job.error = error.message;
        }
      })();
      return { jobId };
    },

    // GET /api/ledger/recalculate/:jobId
    async recalculateStatus(ctx) {
      const job = recalcJobs.get(String(ctx.params.jobId));
      if (!job) throw new HttpError(404, "not_found", "job not found");
      return { jobId: job.jobId, status: job.status, progress: job.progress };
    },

    // PUT /api/charging/:id/cost（AC-7.6 补录）：7 天窗口校验 + 触发重算
    async putChargeCost(ctx) {
      const cpId = Number(ctx.params.id);
      if (!Number.isInteger(cpId) || cpId <= 0) throw new HttpError(400, "bad_request", "invalid charging id");
      const amount = finiteNumber(ctx.body?.amount);
      if (amount === null || amount < 0 || amount > 10000) {
        throw new HttpError(400, "bad_request", "amount must be a number in [0, 10000]");
      }
      // 7 天修正窗口：充电会话结束时间距今 ≤7 天才允许补录
      const rows = await db.query(
        "SELECT cp.end_date AS end_at FROM charging_processes cp WHERE cp.id = $1",
        [cpId]
      );
      const row = rows[0];
      if (!row) throw new HttpError(404, "not_found", "charging session not found");
      const endMs = row.end_at ? new Date(row.end_at + (row.end_at.endsWith("Z") ? "" : "Z")).getTime() : null;
      if (endMs !== null && Date.now() - endMs > 7 * 24 * 3600 * 1000) {
        throw new HttpError(422, "window_expired", "charge older than 7 days cannot be amended (AC-7.6)");
      }
      const store = getStore();
      store.putChargeCostOverride({ cpId, cost: amount, note: ctx.body?.note ?? null });
      // 触发受影响重算（异步，不阻塞响应；不重复推送）
      const jobId = `recalc-${Date.now()}-${++recalcSeq}`;
      const job = { jobId, status: "running", progress: 0, startedAt: new Date().toISOString(), triggeredBy: `charge-cost-override:${cpId}` };
      recalcJobs.set(jobId, job);
      ;(async () => {
        try {
          const charging = await listChargingForStats(db, {});
          const batches = batchesFromChargingSessions(charging, {
            overrides: overridesMap(),
            touByGeofenceId: await touByGeofenceId()
          });
          const store2 = getStore();
          for (let i = 0; i < batches.length; i++) {
            store2.putFifoBatch?.({
              batchId: batches[i].batch_id,
              sourceRef: `charging_process:${batches[i].charging_process_id}`,
              availableAtMs: batches[i].available_at_ms,
              energyKwh: batches[i].energy_kwh,
              remainingKwh: batches[i].energy_kwh,
              unitPrice: batches[i].unit_price_cny_per_kwh,
              metaJson: JSON.stringify({ source: batches[i].source, amount: batches[i].amount_cny })
            });
            job.progress = Math.round(((i + 1) / batches.length) * 100);
          }
          job.status = "done";
          job.progress = 100;
        } catch (error) {
          job.status = "error";
          job.error = error.message;
        }
      })();
      return { ok: true, recalculated: true, jobId };
    }
  };
}
