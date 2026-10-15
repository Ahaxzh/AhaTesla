// report-engine.mjs — 周报/月报生成 + 归档 + 定时调度（US-13，GA-11/12）。
//
// 报告 = 不可变快照（report_snapshots 表，§7.4）：生成即固化，推送失败
// 不丢本体（AC-13.3）。生成入口三个：
//   - 定时（每周一 08:00 / 每月 1 日 08:00，实例时区）
//   - POST /api/reports/generate 手动触发（调试）
//   - 测试直接调 buildWeeklyReport/buildMonthlyReport
//
// deliveryMs 埋点：报告生成时刻 → 各渠道送达时刻差，写事件日志（GA-12）。
import { isoFromTeslaMate, round, finiteNumber } from "./util.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function periodRange(now, kind, tz = "Asia/Shanghai") {
  // 周报：上一周（周一 00:00 ~ 周日 24:00）；月报：上一自然月。
  const locale = safeLocale(tz);
  if (kind === "weekly") {
    const day = now.getDay() === 0 ? 7 : now.getDay(); // 周一=1…周日=7
    const thisMonday = new Date(now); 
    thisMonday.setHours(0, 0, 0, 0);
    thisMonday.setDate(thisMonday.getDate() - (day - 1));
    return {
      start: new Date(thisMonday.getTime() - 7 * DAY_MS),
      end: thisMonday,
      label: fmtLabel(new Date(thisMonday.getTime() - 7 * DAY_MS), "weekly", locale)
    };
  }
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    start: new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth() - 1, 1),
    end: firstOfMonth,
    label: fmtLabel(new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth() - 1, 1), "monthly", locale)
  };
}

function safeLocale(tz) {
  try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return tz; } catch { return "Asia/Shanghai"; }
}

function fmtLabel(start, kind, tz) {
  const fmt = (d, opts) => new Intl.DateTimeFormat("zh-CN", { timeZone: tz, ...opts }).format(d);
  if (kind === "weekly") {
    const y = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric" }).format(start);
    const w = isoWeek(start);
    return `${y}-W${String(w).padStart(2, "0")}：${fmt(start, { month: "2-digit", day: "numeric" })} ~ ${fmt(new Date(start.getTime() + 6 * DAY_MS), { month: "2-digit", day: "numeric" })}`;
  }
  return `${fmt(start, { year: "numeric", month: "long" })}月报`;
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
}

// ---- 数据聚合（依赖注入 db + queries，测试可 fake） ---------------------------

/**
 * 构建周期报告快照。
 * deps: {db, computeTripViews, listDrivesSql, listChargingForStats, state}
 */
export async function buildReport({ kind, now = new Date(), tz = "Asia/Shanghai", deps }) {
  const { start, end, label } = periodRange(now, kind, tz);
  const { db, state, computeTripViews, listDrivesSql, listChargingForStats, getParkingLoss } = deps;

  const { sql, params } = listDrivesSql({ from: start.toISOString(), to: end.toISOString() });
  const driveRows = await db.query(sql, [...params, 200, 0]);
  const views = await computeTripViews(db, driveRows, {
    defaultRate: state.pricing.defaultRateCnyPerKwh,
    history: state.pricing.history
  });

  const distanceKm = round(views.reduce((s, v) => s + (v.distanceKm ?? 0), 0), 1);
  const energyKwh = round(views.reduce((s, v) => s + (v.energyKWh ?? 0), 0), 2);
  const totalCost = round(views.reduce((s, v) => s + (v.costCny ?? 0), 0), 2);

  // 充电侧（周期内结算的会话）
  const charging = await listChargingForStats(db, { sinceIso: start.toISOString() });
  const inWindow = charging.filter((row) => {
    const endAt = row.end_at ?? row.end_date;
    return endAt && isoFromTeslaMate(endAt) && new Date(isoFromTeslaMate(endAt)) < end;
  });
  const chargeKwh = round(inWindow.reduce((s, r) => s + (finiteNumber(r.charge_energy_added) ?? 0), 0), 2);

  // 油车对比（AC-7.4，可配置基准）
  const baseline = { literPer100km: 8.0, fuelPriceCnyPerL: 8.20, ...(state.fuelBaseline || {}) };
  const perKm = baseline.literPer100km / 100 * baseline.fuelPriceCnyPerL;
  const fuelCost = round(distanceKm * perKm, 2);
  const saved = round(fuelCost - totalCost, 2);

  // 主跑路线 TOP3（Q4 决策：routeKey 聚合）
  const routeCount = new Map();
  for (const v of views) {
    if (!v.routeKey) continue;
    routeCount.set(v.routeKey, (routeCount.get(v.routeKey) || 0) + 1);
  }
  const topRoutes = [...routeCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([route, count]) => ({ route, count }));

  // 驻车损耗（可选注入）
  let parkingLoss = null;
  if (getParkingLoss) {
    try { parkingLoss = await getParkingLoss(start.toISOString(), end.toISOString()); } catch { parkingLoss = null; }
  }

  return {
    kind,
    periodLabel: label,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    carName: deps.carName || null,
    kpi: {
      distanceKm,
      energyKwh,
      chargeKwh,
      totalCost,
      driveCount: views.length,
      costPerKm: distanceKm > 0 ? round(totalCost / distanceKm, 3) : null,
      fuelCost,
      saved,
      savedPct: fuelCost > 0 ? round((saved / fuelCost) * 100, 1) : null,
      ...(parkingLoss ? { parkingLoss } : {})
    },
    topRoutes,
    baselineNote: `对比基准：${baseline.literPer100km}L/100km @ ¥${baseline.fuelPriceCnyPerL}/L`,
    closing: distanceKm > 0
      ? `本期每公里成本 ¥${(totalCost / Math.max(distanceKm, 0.1)).toFixed(2)}，较燃油车${saved >= 0 ? "节省" : "多花"} ¥${Math.abs(saved).toFixed(2)}`
      : "本期无行程记录"
  };
}

// ---- 定时调度 ----------------------------------------------------------------

/** 计算下一次触发时刻（每周一 08:00 / 每月 1 日 08:00，实例时区）。 */
export function nextReportRun(kind, now = new Date(), tz = "Asia/Shanghai") {
  tz = safeLocale(tz);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const h = Number(parts.hour === "24" ? "0" : parts.hour);
  // 简化：目标日判定基于本地日期。周报 → 下一个周一；月报 → 下月 1 日。
  if (kind === "weekly") {
    const day = now.getDay() === 0 ? 7 : now.getDay();
    let daysAhead = (8 - day) % 7; // 下一个周一
    if (daysAhead === 0 && h >= 8) daysAhead = 7;
    const at = new Date(now.getTime() + daysAhead * DAY_MS);
    at.setHours(8, 0, 5, 0);
    return at;
  }
  const at = new Date(now.getFullYear(), now.getMonth() + 1, 1, 8, 0, 5, 0);
  if (at <= now) at.setMonth(at.getMonth() + 1);
  return at;
}

/** 报告调度器：到点生成 + 归档 + 经 notifier 投递。 */
export function startReportScheduler({
  store, buildDeps, notifier, eventLog, state,
  tz = "Asia/Shanghai", setTimeoutImpl = setTimeout, logger = () => {}
}) {
  let stopped = false;
  const timers = [];

  async function runKind(kind) {
    const t0 = Date.now();
    try {
      const report = await buildReport({ kind, now: new Date(), tz, deps: buildDeps() });
      const id = store.addReportSnapshot({
        kind,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        payload: report
      });
      // 防同周期重复：以 periodStart 为准查重（手动 + 定时都过这里）
      const all = store.listReportSnapshots(kind, 50);
      const dup = all.filter((r) => r.periodStart === report.periodStart);
      if (dup.length > 1) {
        // 已有同期报告 → 跳过推送与重复归档（删除刚插入的）
        store.db?.prepare?.("DELETE FROM report_snapshots WHERE id=?")?.run?.(id);
        logger(`report ${kind} ${report.periodLabel} already archived, skip`);
        return null;
      }
      const dispatchResult = await notifier.dispatch(
        { type: kind, summary: report.closing },
        { matrix: matrixForReport(state, kind) }
      );
      const deliveryMs = Date.now() - t0;
      eventLog?.log(`report.${kind}`, {
        id, periodLabel: report.periodLabel,
        deliveryMs, results: dispatchResult.results
      });
      return { id, report, deliveryMs };
    } catch (error) {
      eventLog?.log(`report.${kind}.error`, { message: String(error?.message).slice(0, 200) });
      return null;
    }
  }

  function matrixForReport(state, kind) {
    const key = kind === "weekly" ? "weekly" : "monthly";
    // weekly→weekly / monthly→monthly 直接复用矩阵
    const notifier = state.pushRules;
    return notifier?.matrix ? { matrix: notifier.matrix } : undefined;
  }

  function schedule(kind) {
    if (stopped) return;
    const next = nextReportRun(kind, new Date(), tz);
    const delay = Math.max(1000, next.getTime() - Date.now());
    const t = setTimeoutImpl(() => {
      runKind(kind).finally(() => schedule(kind));
    }, delay);
    t.unref?.();
    timers.push(t);
  }

  schedule("weekly");
  schedule("monthly");
  return {
    runKind,
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
    }
  };
}
