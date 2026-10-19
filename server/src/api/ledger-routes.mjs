// ledger routes — 月度账本摘要 + 历史重算 + 充电费用补录（AC-7.3/7.5/7.6）。
//
// 数据流：charging_sessions（teslamate 只读）+ charge_cost_overrides（本地 SQLite）
// + pricing（默认价/围栏 TOU）→ fifo-ledger 全量回放 → 月度汇总。
// 重算为异步 job（jobId + 进度），补录费用 7 天窗口内触发重算（AC-7.6）。
import { HttpError } from "./http-kit.mjs";
import { finiteNumber, round, timeMs, monthWindowIso } from "../core/util.mjs";
import { instanceTimezone } from "../core/pricing-options.mjs";
import { getFifoLedger, bumpPricingVersion } from "../core/fifo-ledger.mjs";
import { driveEnergyKwh } from "../core/pricing-ledger.mjs";
import { listDrivesLightSql } from "../core/teslamate-queries.mjs";
import { carIdFromQuery } from "./car-scope.mjs";

const FUEL_BASELINE_DEFAULT = Object.freeze({
  literPer100km: 8.0,
  fuelPriceCnyPerL: 8.20
});

// 内存 job 表（单实例自托管，进程内即可；job 只报告进度不落盘）。
// 完成 10 分钟后自动清除，避免重复调用下无限增长。
const recalcJobs = new Map();
let recalcSeq = 0;
function registerJob(extra = {}) {
  const jobId = `recalc-${Date.now()}-${++recalcSeq}`;
  const job = { jobId, status: "running", progress: 0, startedAt: new Date().toISOString(), ...extra };
  recalcJobs.set(jobId, job);
  setTimeout(() => recalcJobs.delete(jobId), 10 * 60_000).unref?.();
  return job;
}

export function createLedgerRoutes({ db, state, getStore }) {
  async function monthWindow(month) {
    // month: "YYYY-MM" → [startIso, endIso)。实例时区自然月（北京时间月初，
    // 修复原 Date.UTC 月初导致的 8 小时窗口漂移），与 dashboard/charging 口径一致。
    const tz = instanceTimezone(state);
    const win = monthWindowIso(month, tz);
    if (!win) throw new HttpError(400, "bad_request", "month must be YYYY-MM");
    return win;
  }

  // 重算主体（AC-7.3）：跑一次全量回放并把批次与「剩余余额」真实落库
  // （旧实现调用不存在的 putFifoBatch —— 可选链静默吞掉，从未写进任何东西）。
  async function runRecalc(job) {
    const ledger = await getFifoLedger(db, state, null); // 全车回放
    const store = getStore();
    const remainingByBatch = new Map(ledger.remaining.map((r) => [String(r.batch_id), r.remaining_kwh]));
    const nameByCp = new Map(ledger.chargingRows.map((row) => [Number(row.id), row.geofence_name || row.address_name || null]));
    let i = 0;
    for (const batch of ledger.batches) {
      store.upsertFifoBatch?.({
        batchId: batch.batch_id,
        carId: batch.car_id ?? null,
        sourceRef: `charging_process:${batch.charging_process_id}`,
        availableAtMs: batch.available_at_ms,
        energyKwh: batch.energy_kwh,
        remainingKwh: remainingByBatch.get(String(batch.batch_id)) ?? batch.energy_kwh,
        unitPrice: batch.unit_price_cny_per_kwh,
        meta: {
          source: batch.source,
          amount: batch.amount_cny ?? null,
          label: nameByCp.get(Number(batch.charging_process_id)) ?? null
        }
      });
      i += 1;
      job.progress = Math.round((i / Math.max(1, ledger.batches.length)) * 100);
    }
    job.status = "done";
    job.progress = 100;
  }

  return {
    // POST /api/ledger/summary?month=YYYY-MM（契约 §5，v2 新增；m4e: ?carId= 按车出账）
    async summary(ctx) {
      const month = ctx.query.month || new Date().toISOString().slice(0, 7);
      const { startIso, endIso } = await monthWindow(month);
      const carId = carIdFromQuery(ctx, state); // m4e

      // 全量回放账本（H1 修复）：批次池已被全部历史行程/损耗扣减，
      // 月度数字与 trips 详情/推送小结出自同一次回放，全站一致。
      const ledger = await getFifoLedger(db, state, carId);

      // 轻量列分页取全月行程（大库上带坐标 LATERAL 的全量查会超时）
      const driveRows = [];
      for (let offset = 0; offset < 500_000; offset += 1000) {
        const { sql, params } = listDrivesLightSql({ from: startIso, to: endIso, carId });
        const page = await db.query(sql, [...params, 1000, offset]);
        driveRows.push(...page);
        if (page.length < 1000) break;
      }

      let distanceKm = 0;
      let energyKwh = 0;
      let drivingCost = 0;
      for (const drive of driveRows) {
        distanceKm += finiteNumber(drive.distance_km) ?? 0;
        const alloc = ledger.byDriveId.get(String(drive.id));
        energyKwh += alloc?.energy_kwh ?? driveEnergyKwh(drive) ?? 0;
        if (alloc?.cost_cny_precise != null) drivingCost += alloc.cost_cny_precise;
      }

      // 驻车损耗（AC-7.5）：回放中已与行程交织扣减的驻车事件，按窗口过滤汇总。
      // 修复旧实现两类错误：① 把 SOC 百分比当 kWh（数值放大 ~60 倍）；
      // ② 事件序列只有充电，把两次充电之间的行车耗电整段误记成驻车损耗（双计）。
      const startMs = timeMs(startIso);
      const endMs = timeMs(endIso);
      let parkingKwh = 0;
      let parkingCost = 0;
      for (const parking of ledger.parking) {
        if (parking.at_ms == null || parking.at_ms < startMs || parking.at_ms >= endMs) continue;
        parkingKwh += parking.kwh ?? 0;
        parkingCost += parking.cost_cny ?? 0;
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
      const job = registerJob({ window: { from, to, all } });
      // 账本本身是函数式全量计算：重算 = 强制失效缓存后回放一次并落库剩余批次。
      bumpPricingVersion();
      ;(async () => {
        try {
          await runRecalc(job);
        } catch (error) {
          job.status = "error";
          job.error = String(error?.message ?? error).slice(0, 200);
        }
      })();
      return { jobId: job.jobId };
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
      const note = ctx.body?.note != null ? String(ctx.body.note).slice(0, 200) : null;
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
      store.putChargeCostOverride({ cpId, cost: amount, note });
      bumpPricingVersion(); // 立即失效全站回放缓存（行程卡片/仪表盘/推送同步换新价）
      const job = registerJob({ triggeredBy: `charge-cost-override:${cpId}` });
      ;(async () => {
        try {
          await runRecalc(job);
        } catch (error) {
          job.status = "error";
          job.error = String(error?.message ?? error).slice(0, 200);
        }
      })();
      return { ok: true, recalculated: true, jobId: job.jobId };
    }
  };
}
