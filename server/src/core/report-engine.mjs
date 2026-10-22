// report-engine.mjs — 周报/月报生成 + 归档 + 定时调度（US-13，GA-11/12）。
//
// 报告 = 不可变快照（report_snapshots 表，§7.4）：生成即固化，推送失败
// 不丢本体（AC-13.3）。生成入口三个：
//   - 定时（每周一 08:00 / 每月 1 日 08:00，实例时区）
//   - POST /api/reports/generate 手动触发（调试）
//   - 测试直接调 buildWeeklyReport/buildMonthlyReport
//
// deliveryMs 埋点：报告生成时刻 → 各渠道送达时刻差，写事件日志（GA-12）。
import { isoFromTeslaMate, round, finiteNumber, wallClockToUtcMs } from "./util.mjs";
import { saveState, getStore } from "./state.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

// tz 感知的墙钟部件（setHours/getFullYear 全是服务器进程时区，Docker 常为 UTC，
// 直接用会把周月边界与 08:00 调度整体平移 8 小时 —— 修复 M5）
function tzParts(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(p.year), mo: Number(p.month), d: Number(p.day),
    dow: weekdays[p.weekday] ?? 0,
    h: Number(p.hour === "24" ? "0" : p.hour), mi: Number(p.minute)
  };
}

function periodRange(now, kind, tz = "Asia/Shanghai") {
  // 周报：上一周（周一 00:00 ~ 周日 24:00）；月报：上一自然月；日报：昨日 0~24 点。
  const zone = safeLocale(tz);
  const p = tzParts(now.getTime(), zone);
  if (kind === "daily") {
    const startMs = wallClockToUtcMs(zone, p.y, p.mo, p.d - 1);
    return { start: new Date(startMs), end: new Date(startMs + DAY_MS), label: fmtLabel(new Date(startMs), "daily", zone) };
  }
  if (kind === "weekly") {
    const daysSinceMonday = (p.dow + 6) % 7;
    const thisMondayMs = wallClockToUtcMs(zone, p.y, p.mo, p.d - daysSinceMonday);
    const startMs = thisMondayMs - 7 * DAY_MS;
    return {
      start: new Date(startMs),
      end: new Date(thisMondayMs),
      label: fmtLabel(new Date(startMs), "weekly", zone)
    };
  }
  const startMs = wallClockToUtcMs(zone, p.y, p.mo - 1, 1);
  return {
    start: new Date(startMs),
    end: new Date(wallClockToUtcMs(zone, p.y, p.mo, 1)),
    label: fmtLabel(new Date(startMs), "monthly", zone)
  };
}

function safeLocale(tz) {
  try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return tz; } catch { return "Asia/Shanghai"; }
}

function fmtLabel(start, kind, tz) {
  const fmt = (d, opts) => new Intl.DateTimeFormat("zh-CN", { timeZone: tz, ...opts }).format(d);
  if (kind === "daily") {
    return `${fmt(start, { month: "2-digit", day: "2-digit" })} 日报`;
  }
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
  const { db, state, computeTripViews, listDrivesSql, listChargingForStats, getParkingLoss, carId } = deps;

  // 分页取全窗口行程（修 LIMIT 200 静默截断：高频月的周/月报少算电费）
  const driveRows = [];
  for (let offset = 0; offset < 500_000; offset += 1000) {
    const { sql, params } = listDrivesSql({ from: start.toISOString(), to: end.toISOString(), carId });
    const page = await db.query(sql, [...params, 1000, offset]);
    driveRows.push(...page);
    if (page.length < 1000) break;
  }
  const views = await computeTripViews(db, driveRows, {
    state,
    carId
  });

  const distanceKm = round(views.reduce((s, v) => s + (v.distanceKm ?? 0), 0), 1);
  const energyKwh = round(views.reduce((s, v) => s + (v.energyKWh ?? 0), 0), 2);
  const totalCost = round(views.reduce((s, v) => s + (v.costCny ?? 0), 0), 2);

  // 充电侧（周期内结算的会话；m4e 按车）
  const charging = await listChargingForStats(db, { sinceIso: start.toISOString(), carId });
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

  // ---- v2.2 驾驶洞察维度（全部来自本地库实测） ----
  let insights = null;
  try {
    const driveIds = views.map((v) => v.id).filter(Number.isInteger);
    if (driveIds.length) {
      const r = await db.query(`
        SELECT
          avg(d.outside_temp_avg)::float8 AS avg_temp,
          min(d.outside_temp_avg)::float8 AS min_temp,
          max(d.outside_temp_avg)::float8 AS max_temp,
          max(d.power_max)::float8 AS power_max_kw,
          avg(d.duration_min)::float8 AS avg_duration_min,
          (SELECT avg(v.speed)::float8 FROM (
             SELECT p.speed, p.drive_id FROM positions p
             WHERE p.drive_id = ANY($1::int[]) AND p.speed IS NOT NULL
             ORDER BY p.id DESC LIMIT 20000
           ) v) AS avg_speed,
          (SELECT max(v.speed)::float8 FROM (
             SELECT p.speed FROM positions p
             WHERE p.drive_id = ANY($1::int[]) AND p.speed IS NOT NULL
             ORDER BY p.id DESC LIMIT 20000
           ) v) AS max_speed,
          (SELECT (count(*) FILTER (WHERE v.speed < 5))::float8 / greatest(count(*),1) FROM (
             SELECT p.speed FROM positions p
             WHERE p.drive_id = ANY($1::int[]) AND p.speed IS NOT NULL
             ORDER BY p.id DESC LIMIT 20000
           ) v) AS idle_ratio,
          (SELECT avg(v.tpms)::float8 FROM (
             SELECT p.tpms_pressure_fl::float8 AS tpms FROM positions p
             WHERE p.drive_id = ANY($1::int[]) AND p.tpms_pressure_fl IS NOT NULL
             ORDER BY p.id DESC LIMIT 500
           ) v) AS tire_fl,
          (SELECT avg(v.tpms)::float8 FROM (
             SELECT p.tpms_pressure_rr::float8 AS tpms FROM positions p
             WHERE p.drive_id = ANY($1::int[]) AND p.tpms_pressure_rr IS NOT NULL
             ORDER BY p.id DESC LIMIT 500
           ) v) AS tire_rr,
          (SELECT LEAST(min(v.a), min(v.b), min(v.c), min(v.d))::float8 FROM (
             SELECT p.tpms_pressure_fl::float8 AS a, p.tpms_pressure_fr::float8 AS b,
                    p.tpms_pressure_rl::float8 AS c, p.tpms_pressure_rr::float8 AS d
             FROM positions p
             WHERE p.drive_id = ANY($1::int[]) AND p.tpms_pressure_fl IS NOT NULL
             ORDER BY p.id DESC LIMIT 2000
           ) v) AS tire_min
        FROM drives d WHERE d.id = ANY($1::int[])
      `, [driveIds]);
      const row = r[0] ?? {};
      const avgTemp = finiteNumber(row.avg_temp);
      if (avgTemp != null || row.idle_ratio != null) {
        insights = {
          avgTempC: avgTemp != null ? round(avgTemp, 1) : null,
          tempRangeC: avgTemp != null && finiteNumber(row.min_temp) != null && finiteNumber(row.max_temp) != null
            ? `${round(row.min_temp, 0)}~${round(row.max_temp, 0)}°C`
            : null,
          avgSpeedKmh: finiteNumber(row.avg_speed) != null ? round(row.avg_speed, 0) : null,
          maxSpeedKmh: finiteNumber(row.max_speed) != null ? round(row.max_speed, 0) : null,
          idlePct: finiteNumber(row.idle_ratio) != null ? round(row.idle_ratio * 100, 0) : null,
          powerMaxKw: finiteNumber(row.power_max_kw) != null ? round(row.power_max_kw, 0) : null,
          tireFlBar: finiteNumber(row.tire_fl) != null ? round(row.tire_fl, 1) : null,
          tireRrBar: finiteNumber(row.tire_rr) != null ? round(row.tire_rr, 1) : null,
          tireMinBar: finiteNumber(row.tire_min) != null ? round(row.tire_min, 2) : null,
          kwhPer100km: distanceKm > 2 ? round(energyKwh / distanceKm * 100, 1) : null,
        };
      }
    }
  } catch { /* 洞察维度失败不影响报告本体 */ }

  // ---- 日报专属：上周同日对比 + 本月累计 + 充电摘要（m4c-c1） ----
  let compare = null;
  let chargeSummary = null;
  let plugHint = null;
  if (kind === "daily") {
    compare = await windowStats(deps, new Date(start.getTime() - 7 * DAY_MS), new Date(end.getTime() - 7 * DAY_MS))
      .then((lastWeek) => {
        // 本月累计起点：tz 墙钟月初（服务器本地构造在 UTC 容器里偏 8 小时）
        const sp = tzParts(start.getTime(), tz);
        const monthStart = new Date(wallClockToUtcMs(tz, sp.y, sp.mo, 1));
        return windowStats(deps, monthStart, end).then((month) => {
          const pct = (cur, prev) => (prev > 0 ? round((cur - prev) / prev * 100, 0) : null);
          return {
            lastWeek: { distanceKm: lastWeek.distanceKm, totalCost: lastWeek.totalCost },
            kmDeltaPct: pct(distanceKm, lastWeek.distanceKm),
            costDeltaPct: pct(totalCost, lastWeek.totalCost),
            month: { distanceKm: month.distanceKm, totalCost: month.totalCost },
          };
        });
      }).catch(() => null);
    chargeSummary = summarizeCharging(inWindow);
    // P1-e 今夜插枪提醒：配了 TOU 谷段且昨日无充电 → 提示谷价窗口
    if (!chargeSummary || chargeSummary.count === 0) {
      plugHint = await cheapestTouHint(deps).catch(() => null);
    }
  }

  // ---- 月报专属：年度累计（P1-f YTD） ----
  let ytd = null;
  if (kind === "monthly") {
    try {
      // 年度起点：tz 墙钟 1 月 1 日（同上，避免 UTC 容器偏移）
      const yp = tzParts(start.getTime(), tz);
      const yearStart = new Date(wallClockToUtcMs(tz, yp.y, 1, 1));
      const w = await windowStats(deps, yearStart, end);
      if (w.distanceKm > 0 || w.totalCost > 0) {
        ytd = {
          distanceKm: w.distanceKm,
          totalCost: w.totalCost,
          saved: round(w.distanceKm * perKm - w.totalCost, 2)
        };
      }
    } catch { /* YTD 失败不影响月报本体 */ }
  }

  return {
    kind,
    periodLabel: label,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    carId: Number.isInteger(Number(deps.carId)) ? Number(deps.carId) : null,
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
    insights,
    ...(compare ? { compare } : {}),
    ...(chargeSummary ? { chargeSummary } : {}),
    ...(plugHint ? { plugHint } : {}),
    ...(ytd ? { ytd } : {}),
    baselineNote: `对比基准：${baseline.literPer100km}L/100km @ ¥${baseline.fuelPriceCnyPerL}/L`,
    closing: buildClosing({ distanceKm, totalCost, saved, insights, energyKwh, parkingLoss, kind, ytd })
  };
}

/** P1-e：找最便宜的 TOU 谷段提示（geofences + kv pricing:location-tou:<id>），无则 null */
async function cheapestTouHint(deps) {
  const { db } = deps;
  if (!db) return null;
  const geofences = await db.query("SELECT g.id, g.name FROM geofences g ORDER BY g.name ASC").catch(() => []);
  let best = null;
  try {
    const store = getStore();
    for (const g of geofences) {
      const raw = store.kvGet?.(`pricing:location-tou:${g.id}`);
      if (!raw) continue;
      const tou = JSON.parse(raw);
      if (tou?.offPeakStart && finiteNumber(tou.offPeakRate) != null) {
        if (!best || tou.offPeakRate < best.offPeakRate) {
          best = { offPeakStart: tou.offPeakStart, offPeakRate: finiteNumber(tou.offPeakRate) };
        }
      }
    }
  } catch { return null; }
  if (!best) return null;
  return `今晚 ${best.offPeakStart} 后插枪充电享谷价 ¥${Number(best.offPeakRate).toFixed(2)}/kWh`;
}

/** 窗口内行程里程/电费聚合（日报对比段复用账本口径的 computeTripViews；m4e 按车） */
async function windowStats(deps, start, end) {
  const rows = [];
  for (let offset = 0; offset < 500_000; offset += 1000) {
    const { sql, params } = deps.listDrivesSql({ from: start.toISOString(), to: end.toISOString(), carId: deps.carId });
    const page = await deps.db.query(sql, [...params, 1000, offset]);
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const views = await deps.computeTripViews(deps.db, rows, {
    state: deps.state,
    carId: deps.carId
  });
  return {
    distanceKm: round(views.reduce((s, v) => s + (v.distanceKm ?? 0), 0), 1),
    totalCost: round(views.reduce((s, v) => s + (v.costCny ?? 0), 0), 2)
  };
}

/** 日报充电摘要：次数 / kWh / 地点去重 / 末次结束时段（北京时间，"几点到家充"） */
function summarizeCharging(rows) {
  if (!rows.length) return null;
  const kwh = round(rows.reduce((s, r) => s + (finiteNumber(r.charge_energy_added) ?? 0), 0), 1);
  const names = [...new Set(rows.map((r) => r.geofence_name || r.address_name).filter(Boolean))];
  const lastIso = isoFromTeslaMate(rows.at(-1).end_at ?? rows.at(-1).end_date);
  let lastEndTime = null;
  if (lastIso) {
    lastEndTime = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false
    }).format(new Date(lastIso));
  }
  return { count: rows.length, kwh, locations: names.slice(0, 2), lastEndTime };
}

/** v2.2 结语：核心数字 + 洞察要点（温度/胎压/拥堵/能耗）；月报附年度累计（P1-f） */
function buildClosing({ distanceKm, totalCost, saved, insights, energyKwh, parkingLoss, kind, ytd }) {
  if (!(distanceKm > 0)) return "本期无行程记录";
  const lines = [
    `本期行驶 ${distanceKm} km · 电费 ¥${totalCost.toFixed(2)} · 较油车${saved >= 0 ? "省" : "多花"} ¥${Math.abs(saved).toFixed(2)}（每公里 ¥${(totalCost / Math.max(distanceKm, 0.1)).toFixed(2)}）`
  ];
  if (kind === "monthly" && ytd) {
    lines.push(`📈 年度至今 ${ytd.distanceKm} km · 电费 ¥${ytd.totalCost.toFixed(2)} · 较油车${ytd.saved >= 0 ? "省" : "多花"} ¥${Math.abs(ytd.saved).toFixed(2)}`);
  }
  if (insights) {
    const bits = [];
    if (insights.kwhPer100km != null) bits.push(`平均能耗 ${insights.kwhPer100km} kWh/100km`);
    if (insights.avgTempC != null) bits.push(`气温 ${insights.tempRangeC ?? `${insights.avgTempC}°C`}`);
    if (insights.idlePct != null && insights.idlePct >= 10) bits.push(`怠速占比 ${insights.idlePct}%${insights.idlePct >= 25 ? "（拥堵较多）" : ""}`);
    if (insights.tireFlBar != null && insights.tireRrBar != null) {
      const diff = Math.abs(insights.tireFlBar - insights.tireRrBar);
      bits.push(`胎压 ${insights.tireFlBar}/${insights.tireRrBar} bar${diff >= 0.3 ? "（前后差异偏大，建议检查）" : ""}`);
    }
    if (bits.length) lines.push(bits.join(" · "));
  }
  if (parkingLoss && parkingLoss.kwh > 0.5) {
    lines.push(`驻车/哨兵损耗 ${parkingLoss.kwh.toFixed(1)} kWh（¥${(parkingLoss.cost ?? 0).toFixed(2)}）`);
  }
  return lines.join("\n");
}

// ---- 定时调度 ----------------------------------------------------------------

/** 计算下一次触发时刻（日报每日 08:00 / 周报每周一 08:00 / 月报每月 1 日 08:00，实例时区）。 */
export function nextReportRun(kind, now = new Date(), tz = "Asia/Shanghai") {
  const zone = safeLocale(tz);
  const p = tzParts(now.getTime(), zone);
  const atToday = () => new Date(wallClockToUtcMs(zone, p.y, p.mo, p.d, 8, 0) + 5_000);
  if (kind === "daily") {
    const at = atToday();
    if (at.getTime() <= now.getTime()) {
      return new Date(wallClockToUtcMs(zone, p.y, p.mo, p.d + 1, 8, 0) + 5_000);
    }
    return at;
  }
  if (kind === "weekly") {
    const daysToMonday = (8 - p.dow) % 7; // 下一个周一（dow: 0=Sun…6=Sat）
    const at = daysToMonday === 0 && p.h >= 8
      ? new Date(wallClockToUtcMs(zone, p.y, p.mo, p.d + 7, 8, 0) + 5_000)
      : new Date(wallClockToUtcMs(zone, p.y, p.mo, p.d + daysToMonday, 8, 0) + 5_000);
    return at;
  }
  let at = new Date(wallClockToUtcMs(zone, p.y, p.mo + 1, 1, 8, 0) + 5_000);
  if (at.getTime() <= now.getTime()) {
    at = new Date(wallClockToUtcMs(zone, p.y, p.mo + 2, 1, 8, 0) + 5_000);
  }
  return at;
}

/** 日报 → 推送事件（扁平字段，push-channels.eventBody 消费；dateLabel = 昨日 M-DD，实例时区） */
function dailyEvent(report, quietTrips = [], tz = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(report.periodStart));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return {
    type: "daily",
    dateLabel: `${p.month}-${p.day}`,
    carId: report.carId ?? null,
    carName: report.carName ?? null,
    summary: report.closing,
    kpi: report.kpi,
    compare: report.compare ?? null,
    chargeSummary: report.chargeSummary ?? null,
    insights: report.insights ?? null,
    topRoute: report.topRoutes?.[0]?.route ?? null,
    plugHint: report.plugHint ?? null,
    quietTrips
  };
}

/** 报告调度器：到点生成 + 归档 + 经 notifier 投递。 */
export function startReportScheduler({
  store, buildDeps, notifier, eventLog, state,
  tz = "Asia/Shanghai", setTimeoutImpl = setTimeout, logger = () => {}
}) {
  let stopped = false;
  const timers = [];

  // opts.force：绕过当日去重（手动补发）。opts.manual：不消费昨夜 backlog
  // （那是定时早报的职责），也不做纯为其服务的状态持久化。
  async function runKind(kind, opts = {}) {
    const { force = false, manual = false } = opts;
    const t0 = Date.now();
    try {
      const report = await buildReport({ kind, now: new Date(), tz, deps: buildDeps() });

      // ---- 日报（m4c-c1）：不落归档表；昨日无行程且无充电 → 静默跳过；跨重启按日期去重 ----
      if (kind === "daily") {
        if (!(report.kpi.driveCount > 0 || report.kpi.chargeKwh > 0)) {
          eventLog?.log("report.daily.skipped", { periodLabel: report.periodLabel });
          logger(`report daily ${report.periodLabel} empty, skip`);
          return null;
        }
        const dayKey = report.periodStart.slice(0, 10);
        // M1 修复：去重键走 SQLite kv —— saveState 的白名单会静默丢弃
        // state.dailyLastRun，重启后同日日报会重发一遍。
        const lastRun = store.kvGet?.("report:dailyLastRun");
        if (!force && lastRun === dayKey) {
          logger(`report daily ${dayKey} already sent, skip`);
          return null;
        }
        store.kvPut?.("report:dailyLastRun", dayKey);
        // P1-a 静音消费：backlog 里的昨夜行程并入早报「昨夜」段，投递后清空
        // （手动补发 manual 不碰 backlog —— 留给明早定时早报消费）
        const quietTrips = manual ? [] : (Array.isArray(state.pushRules?.quietBacklog) ? state.pushRules.quietBacklog.slice() : []);
        if (!manual) {
          try { saveState(state); } catch { /* 状态持久化失败不阻断推送 */ }
        }
        const dispatchResult = await notifier.dispatch(
          dailyEvent(report, quietTrips, tz),
          { matrix: matrixForReport(state) }
        );
        if (!manual && quietTrips.length) {
          state.pushRules.quietBacklog = [];
          try { saveState(state); } catch { /* 同上 */ }
          eventLog?.log("report.daily.quiet_merged", { count: quietTrips.length });
        }
        const deliveryMs = Date.now() - t0;
        eventLog?.log("report.daily", {
          periodLabel: report.periodLabel, deliveryMs, results: dispatchResult.results,
          ...(force ? { forced: true } : {})
        });
        return { id: null, report, deliveryMs, results: dispatchResult.results };
      }

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
        { matrix: matrixForReport(state) }
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

  /** 报告投递矩阵：直接返回矩阵本体（dispatch 的 {matrix} 选项消费）。
   *  回归警示：此处若再包一层 {matrix:…}，dispatch 解构后得到双层嵌套，
   *  matrixFromRules 找不到任何事件行 → 全事件回落默认矩阵（日报=仅飞书），
   *  2026-10-15~22「日报从未送达」事故即源于此（行程推送不传 matrix 故幸免）。 */
  function matrixForReport(state) {
    return state.pushRules?.matrix ?? undefined;
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

  schedule("daily");
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
