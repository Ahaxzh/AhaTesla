// dashboard-extra-routes.mjs — P2 模块2/4（24h 时间轴 + 用车热力图），
// /api/settings（GA-36），/api/system/health-lite（GA-32 匿名探活）。
import { healthState } from "../core/health.mjs";
import { HttpError } from "./http-kit.mjs";
import { finiteNumber, round, isoFromTeslaMate } from "../core/util.mjs";
import { carIdFromQuery, carFilterSql } from "./car-scope.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

// states 原始值 → 产品语义（§6.3 P2）：online=哨兵/在线驻车，offline≠睡眠。
// asleep=睡眠；driving/charging 由查询侧 CASE 推导后传入。
function normalizeState(raw) {
  const v = String(raw ?? "").toLowerCase();
  if (v === "driving" || v === "charging" || v === "asleep" || v === "offline") return v;
  if (v === "online") return "online"; // 哨兵/在线驻车
  return "online";
}

export function createDashboardExtraRoutes({ db, state, healthRef }) {
  const tz = () => state.settings?.timezone || "Asia/Shanghai";

  /** 最近 24h 状态区间：drives（行驶）+ charging_processes（充电）+ states 填充。 */
  async function timeline(ctx) {
    const since = new Date(Date.now() - DAY_MS).toISOString();
    const carId = carIdFromQuery(ctx, state); // m4e
    // 1) 行驶段
    const drives = await db.query(`
      SELECT d.start_date AS start_at, d.end_date AS end_at
      FROM drives d
      WHERE d.end_date IS NOT NULL AND d.end_date >= (${sinceTs(since)})${carFilterSql(carId)}
      ORDER BY d.start_date ASC
    `).catch(() => []);
    // 2) 充电段
    const charges = await db.query(`
      SELECT cp.start_date AS start_at, cp.end_date AS end_at
      FROM charging_processes cp
      WHERE cp.end_date IS NOT NULL AND cp.end_date >= (${sinceTs(since)})${carFilterSql(carId, "cp.car_id")}
      ORDER BY cp.start_date ASC
    `).catch(() => []);
    // 3) states 线性状态段
    const stateRows = await db.query(`
      SELECT s.start_date AS start_at, s.end_date AS end_at, s.state
      FROM states s
      WHERE s.start_date >= (${sinceTs(new Date(Date.now() - 2 * DAY_MS).toISOString())})${carFilterSql(carId, "s.car_id")}
      ORDER BY s.start_date ASC
    `).catch(() => []);

    const windowStart = Date.now() - DAY_MS;
    const windowEnd = Date.now();
    const segs = [];

    const pushSeg = (fromMs, toMs, st) => {
      if (fromMs === null || toMs === null || toMs <= fromMs) return;
      const a = Math.max(fromMs, windowStart);
      const b = Math.min(toMs, windowEnd);
      if (b <= a) return;
      segs.push({ fromMs: a, toMs: b, state: st });
    };

    for (const r of drives) pushSeg(msOf(r.start_at), msOf(r.end_at), "driving");
    for (const r of charges) pushSeg(msOf(r.start_at), msOf(r.end_at), "charging");
    for (const r of stateRows) pushSeg(msOf(r.start_at), msOf(r.end_at ?? null) ?? windowEnd, normalizeState(r.state));

    // 合并为互斥区间：driving > charging > asleep > online > offline
    const PRIORITY = { driving: 5, charging: 4, asleep: 3, offline: 2, online: 1 };
    const buckets = new Map(); // minuteOfDay → 最高优先级 state
    const startMin = Math.floor(windowStart / 60_000);
    const endMin = Math.floor(windowEnd / 60_000);
    for (const seg of segs) {
      const from = Math.max(Math.floor(seg.fromMs / 60_000), startMin);
      const to = Math.min(Math.ceil(seg.toMs / 60_000), endMin);
      for (let m = from; m < to; m++) {
        const cur = buckets.get(m);
        if (!cur || PRIORITY[seg.state] > PRIORITY[cur]) buckets.set(m, seg.state);
      }
    }
    // 连续相同状态合并为段；空隙 = offline（数据缺失）
    const segments = [];
    const summary = { drivingH: 0, chargingH: 0, asleepH: 0, onlineH: 0, offlineH: 0 };
    let curState = null;
    let segStart = null;
    for (let m = startMin; m <= endMin; m++) {
      const st = buckets.get(m) || "offline";
      if (st !== curState) {
        if (curState !== null) {
          segments.push({ from: new Date(segStart * 60_000).toISOString(), to: new Date(m * 60_000).toISOString(), state: curState });
          summary[`${curState}H`] = round(summary[`${curState}H`] + (m - segStart) / 60, 2);
        }
        curState = st;
        segStart = m;
      }
    }
    if (curState !== null && segStart < endMin) {
      segments.push({ from: new Date(segStart * 60_000).toISOString(), to: new Date(endMin * 60_000).toISOString(), state: curState });
      summary[`${curState}H`] = round(summary[`${curState}H`] + (endMin - segStart) / 60, 2);
    }
    return { windowHours: 24, segments: segments.slice(0, 200), summary };
  }

  /** 最近 90 天按本地日期聚合里程（热力图）。 */
  async function heatmap(ctx) {
    const days = Math.max(7, Math.min(400, Number(ctx.query.days) || 90));
    const since = new Date(Date.now() - days * DAY_MS).toISOString();
    const carId = carIdFromQuery(ctx, state); // m4e
    const rows = await db.query(`
      SELECT d.end_date AS end_at, d.distance
      FROM drives d
      WHERE d.end_date IS NOT NULL AND d.end_date >= (${sinceTs(since)})${carFilterSql(carId)}
      ORDER BY d.end_date ASC
    `).catch(() => []);
    // 本地日期聚合（实例时区）
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit" });
    const byDay = new Map();
    for (const r of rows) {
      const at = msOf(r.end_at);
      if (at === null) continue;
      const date = fmt.format(new Date(at));
      byDay.set(date, round((byDay.get(date) || 0) + (finiteNumber(r.distance) ?? 0), 1));
    }
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY_MS);
      const date = fmt.format(d);
      out.push({ date, distanceKm: byDay.get(date) ?? 0 });
    }
    return { days, maxKm: Math.max(0, ...out.map((x) => x.distanceKm)), daysData: out };
  }

  return { timeline, heatmap };
}

export function createSettingsRoutes({ state, getStore }) {
  const DEFAULTS = {
    currency: { symbol: "¥", code: "CNY" },
    distanceUnit: "km",
    timezone: "Asia/Shanghai",
    fuelBaseline: { literPer100km: 8.0, fuelPriceCnyPerL: 8.20 }
  };

  function current() {
    return {
      currency: state.settings?.currency ?? DEFAULTS.currency,
      distanceUnit: state.settings?.distanceUnit ?? DEFAULTS.distanceUnit,
      timezone: state.settings?.timezone ?? DEFAULTS.timezone,
      fuelBaseline: { ...DEFAULTS.fuelBaseline, ...(state.fuelBaseline || {}) },
      // m4e 多车:主车设定 + 车别名(carId → 别名,推送/界面显示用)
      primaryCarId: state.settings?.primaryCarId ?? null,
      carAliases: state.settings?.carAliases ?? {}
    };
  }

  return {
    async get(ctx) {
      return current();
    },
    async put(ctx) {
      const body = ctx.body || {};
      const s = { ...(state.settings || {}) };
      if (body.currency !== undefined) {
        const symbols = ["¥", "$", "€", "£"];
        if (typeof body.currency !== "object" || !symbols.includes(body.currency.symbol)) {
          throw new HttpError(400, "bad_request", "currency.symbol must be one of ¥/$/€/£");
        }
        s.currency = { symbol: body.currency.symbol, code: body.currency.code || "CNY" };
      }
      if (body.distanceUnit !== undefined) {
        if (body.distanceUnit !== "km" && body.distanceUnit !== "mi") {
          throw new HttpError(400, "bad_request", "distanceUnit must be km or mi");
        }
        s.distanceUnit = body.distanceUnit;
      }
      if (body.timezone !== undefined) {
        try { new Intl.DateTimeFormat("en-CA", { timeZone: body.timezone }); } catch {
          throw new HttpError(400, "bad_request", "invalid timezone");
        }
        s.timezone = body.timezone;
      }
      // m4e 多车:主车与别名。primaryCarId=null 表示清除(回退向导绑定);
      // carAliases 整体替换,键为 carId 字符串,值 ≤32 字符,≤32 键。
      if (body.primaryCarId !== undefined) {
        if (body.primaryCarId === null) s.primaryCarId = null;
        else {
          const n = Number(body.primaryCarId);
          if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "bad_request", "primaryCarId must be a positive integer or null");
          s.primaryCarId = n;
        }
      }
      if (body.carAliases !== undefined) {
        if (body.carAliases === null || typeof body.carAliases !== "object" || Array.isArray(body.carAliases)) {
          throw new HttpError(400, "bad_request", "carAliases must be an object");
        }
        const entries = Object.entries(body.carAliases);
        if (entries.length > 32) throw new HttpError(400, "bad_request", "too many carAliases entries (max 32)");
        const out = {};
        for (const [k, v] of entries) {
          if (!/^\d+$/.test(String(k))) throw new HttpError(400, "bad_request", "carAliases keys must be numeric car ids");
          if (typeof v !== "string" || !v.trim() || v.length > 32) throw new HttpError(400, "bad_request", "carAliases values must be 1-32 chars");
          out[String(k)] = v.trim();
        }
        s.carAliases = out;
      }
      state.settings = s;
      if (body.fuelBaseline !== undefined) {
        const fb = body.fuelBaseline;
        const liter = finiteNumber(fb?.literPer100km);
        const price = finiteNumber(fb?.fuelPriceCnyPerL);
        if (liter === null || liter <= 0 || liter > 30) throw new HttpError(400, "bad_request", "fuelBaseline.literPer100km must be in (0,30]");
        if (price === null || price <= 0 || price > 50) throw new HttpError(400, "bad_request", "fuelBaseline.fuelPriceCnyPerL must be in (0,50]");
        state.fuelBaseline = { literPer100km: liter, fuelPriceCnyPerL: price };
      }
      const store = getStore();
      store.kvPut("app:settings", JSON.stringify({
        currency: s.currency, distanceUnit: s.distanceUnit, timezone: s.timezone,
        ...(s.primaryCarId != null ? { primaryCarId: s.primaryCarId } : {}),
        ...(s.carAliases ? { carAliases: s.carAliases } : {})
      }));
      if (state.fuelBaseline) store.kvPut("app:fuelBaseline", JSON.stringify(state.fuelBaseline));
      return { ok: true, settings: current() };
    }
  };
}

export function createHealthLiteRoutes({ healthRef }) {
  return {
    async healthLite(ctx) {
      // 匿名：仅返回 dbOk + 横幅级别，无任何车辆/账号信息
      const h = healthState();
      return { dbOk: h.dbOk, bannerLevel: h.bannerLevel, outageMs: h.outageMs };
    }
  };
}

// ---- helpers ------------------------------------------------------------------
function sinceTs(iso) {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) throw new HttpError(400, "bad_request", "invalid timestamp");
  return `('${new Date(ms).toISOString()}'::timestamptz AT TIME ZONE 'UTC')`;
}
function msOf(v) {
  if (v === null || v === undefined || v === "") return null;
  const raw = String(v);
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const t = new Date(normalized).getTime();
  return Number.isFinite(t) ? t : null;
}
