// demo-data.mjs — AHATESLA_DEMO=1 演示模式：无 TeslaMate 库时的确定性种子数据。
//
// 设计（m4d）：
// - `isDemo()`：进程内缓存读 env AHATESLA_DEMO==='1'
// - `buildDemoDataset(anchorMs)`：LCG 固定种子的 90 天历史（相对 anchor 的北京日历），
//   1 辆车 / 工作日通勤×2 + 周末出游 / 夜间家充 + 每月超充 / 3 个 geofence（家·公司·超充）。
//   positions 不生成（轨迹图走空态，刻意：免造百万行）。
// - `createDemoDb()`：实现与 db.mjs 相同的 { query, queryOne, ping, close } 接口，
//   按 SQL 指纹路由到数据集切片 —— 拦截层集中在 db 入口，routes/queries 一行不改。
//   未知 SQL 返回 []（不抛错、不触网），并 stderr 记一次指纹缺失便于排查。
//
// 安全：坐标为上海周边合成值；无任何真实 VIN/GPS 精度。
const TZ = "Asia/Shanghai";

let demoCached;
export function isDemo() {
  if (demoCached === undefined) demoCached = process.env.AHATESLA_DEMO === "1";
  return demoCached;
}

// ---- LCG（确定性伪随机） ------------------------------------------------------
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const round = (v, d = 1) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

// ---- 北京日历工具 -------------------------------------------------------------
function bjParts(ms) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute") };
}
/** 北京时间某日 h:m 对应的 UTC 时刻（北京 = UTC+8，无夏令时） */
function bjTime(y, mo, d, h, mi) {
  return Date.UTC(y, mo - 1, d, h, mi, 0, 0) - 8 * 3600_000;
}
/** 北京「今天 00:00」锚点 */
function bjDayStart(ms) {
  const { y, mo, d } = bjParts(ms);
  return bjTime(y, mo, d, 0, 0);
}

// ---- 数据集 -------------------------------------------------------------------
const GEOFENCES = [
  { id: 1, name: "家", price_per_unit: 0.3, session_fee: null, billing_type: "kwh", lat: 31.226, lng: 121.446 },
  { id: 2, name: "公司", price_per_unit: null, session_fee: null, billing_type: "kwh", lat: 31.298, lng: 121.544 },
  { id: 3, name: "超充站(Demo)", price_per_unit: 1.8, session_fee: 0, billing_type: "kwh", lat: 31.144, lng: 121.502 },
];
const ADDRESSES = [
  { id: 11, display_name: "家(静安区某路)", name: "家", road: "某路 88 号", city: "上海市", neighbourhood: "静安区" },
  { id: 22, display_name: "公司(浦东某大道)", name: "公司", road: "某大道 700 号", city: "上海市", neighbourhood: "浦东新区" },
  { id: 33, display_name: "超充站(浦东)", name: "超充站", road: "某高速入口", city: "上海市", neighbourhood: "浦东新区" },
];
const gfById = new Map(GEOFENCES.map((g) => [g.id, g]));
/** 合成坐标：geofence 附近 ±200m 抖动（seed 驱动，刻意低精度） */
function jitterCoord(rand, base, meters) {
  const d = (rand() - 0.5) * 2 * (meters / 111_000);
  return round(base + d, 6);
}

/**
 * 90 天确定性数据集。anchorMs：以该时刻的北京「今天」为第 90 天（默认 now）。
 */
export function buildDemoDataset(anchorMs = Date.now()) {
  const rand = lcg(20261018);
  const todayStart = bjDayStart(anchorMs);
  const nowMs = anchorMs;

  const drives = [];
  const charges = [];
  let driveId = 0;
  let chargeId = 0;
  let odometer = 8420;
  let odometer2 = 1580; // m4e 第二辆车独立里程

  // 季节温度（按月，°C）：冬低夏高 + 随机抖动
  const monthTemp = [4, 6, 10, 15, 20, 25, 32, 32, 27, 20, 13, 6];

  const addDrive = (startMs, endMs, fromGf, toGf, km, carId = 1) => {
    driveId += 1;
    const p = bjParts(startMs);
    const dayTemp = monthTemp[p.mo - 1] + (rand() - 0.5) * 4;
    const tempAvg = round(dayTemp + (p.h < 12 ? -2 : 3), 1);
    const durationMin = Math.max(6, Math.round(km / (28 + rand() * 14) * 60));
    const idealUsed = round(km * (1.06 + rand() * 0.1), 2);
    if (carId === 2) odometer2 = round(odometer2 + km, 1);
    else odometer = round(odometer + km, 1);
    drives.push({
      id: driveId,
      car_id: carId,
      start_at: new Date(startMs).toISOString(),
      end_at: new Date(endMs).toISOString(),
      distance_km: round(km, 2),
      distance: round(km, 2), // heatmap 聚合原生列
      duration_min: durationMin,
      start_address_id: fromGf === 1 ? 11 : fromGf === 2 ? 22 : 33,
      end_address_id: toGf === 1 ? 11 : toGf === 2 ? 22 : 33,
      start_geofence_id: fromGf,
      end_geofence_id: toGf,
      efficiency: carId === 2 ? 0.165 : 0.152, // kWh/km（Y 略高）
      ideal_used_km: idealUsed,
      rated_used_km: round(idealUsed * 0.96, 2),
      outside_temp_avg: tempAvg,
      power_max: round(40 + rand() * 160, 1),
      start_lat: jitterCoord(rand, gfById.get(fromGf).lat, 200),
      start_lng: jitterCoord(rand, gfById.get(fromGf).lng, 200),
      end_lat: jitterCoord(rand, gfById.get(toGf).lat, 200),
      end_lng: jitterCoord(rand, gfById.get(toGf).lng, 200),
      end_odometer: carId === 2 ? odometer2 : odometer,
      position_count: 0,
    });
  };

  const addHomeCharge = (dayStartMs, kwhNeeded, carId = 1) => {
    chargeId += 1;
    const { y, mo, d } = bjParts(dayStartMs);
    const startMs = bjTime(y, mo, d, 23, Math.floor(rand() * 20));
    const kwh = round(Math.max(5, kwhNeeded + rand() * 4), 2);
    const hours = Math.max(1, Math.min(9, kwh / 7));
    const endMs = startMs + hours * 3600_000;
    const startBatt = Math.max(12, Math.round(78 - kwh * 1.4 + rand() * 6));
    charges.push({
      id: chargeId,
      car_id: carId,
      start_at: new Date(startMs).toISOString(),
      end_at: new Date(endMs).toISOString(),
      charge_energy_added: kwh,
      charge_energy_used: round(kwh * 1.08, 2),
      cost: null, // 让账本按 geofence 单价计价
      duration_min: Math.round(hours * 60),
      start_battery_level: startBatt,
      end_battery_level: Math.min(100, startBatt + Math.round(kwh * 1.35)),
      geofence_id: 1,
      address_id: 11,
      geofence_name: "家",
      address_name: ADDRESSES[0].display_name,
      power_max_kw: 7.2,
      charge_sample_count: Math.max(4, Math.round(hours * 4)),
      kind: "home",
    });
  };

  const addSupercharge = (dayStartMs, carId = 1) => {
    chargeId += 1;
    const { y, mo, d } = bjParts(dayStartMs);
    const startMs = bjTime(y, mo, d, 13, 30 + Math.floor(rand() * 90));
    const kwh = round(28 + rand() * 18, 2);
    const minutes = Math.max(18, Math.round(kwh / 1.6));
    const endMs = startMs + minutes * 60_000;
    const startBatt = Math.round(14 + rand() * 18);
    charges.push({
      id: chargeId,
      car_id: carId,
      start_at: new Date(startMs).toISOString(),
      end_at: new Date(endMs).toISOString(),
      charge_energy_added: kwh,
      charge_energy_used: round(kwh * 1.1, 2),
      cost: null,
      duration_min: minutes,
      start_battery_level: startBatt,
      end_battery_level: Math.min(92, startBatt + Math.round(kwh * 1.3)),
      geofence_id: 3,
      address_id: 33,
      geofence_name: "超充站(Demo)",
      address_name: ADDRESSES[2].display_name,
      power_max_kw: round(99 + rand() * 45, 1),
      charge_sample_count: Math.round(minutes / 2),
      kind: "super",
    });
  };

  for (let day = 89; day >= 0; day--) {
    const dayStart = todayStart - day * 86_400_000;
    const { y, mo, d } = bjParts(dayStart);
    // 北京日历星期（dayStart 是北京 00:00 = UTC 前一日 16:00，用 UTC 正午取星期）
    const weekday = new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay();
    const isWeekend = weekday === 0 || weekday === 6;
    let dayKm = 0;

    if (!isWeekend) {
      // 早：家→公司；晚：公司→家（不生成跨「现在」的段）
      const km1 = 26 + rand() * 9;
      const s1 = bjTime(y, mo, d, 8, Math.floor(20 + rand() * 25));
      const e1 = s1 + Math.round(km1 / 30 * 3600_000);
      if (e1 <= nowMs - 3 * 3600_000) {
        addDrive(s1, e1, 1, 2, km1);
        dayKm += km1;
      }
      const km2 = 25 + rand() * 10;
      const s2 = bjTime(y, mo, d, 18, Math.floor(10 + rand() * 40));
      const e2 = s2 + Math.round(km2 / 30 * 3600_000);
      if (e2 <= nowMs - 3 * 3600_000) {
        addDrive(s2, e2, 2, 1, km2);
        dayKm += km2;
      }
    } else if (rand() < 0.4) {
      // 周末出游：去程到超充站，条件允许再返程（含一次超充）
      const km = 45 + rand() * 70;
      const s = bjTime(y, mo, d, 9, Math.floor(30 + rand() * 90));
      const e1 = s + Math.round(km / 55 * 3600_000);
      addDrive(s, e1, 1, 3, km);
      dayKm += km;
      const back = e1 + Math.round(1.2 * 3600_000);
      const e2 = back + Math.round(km / 60 * 3600_000);
      if (e2 <= nowMs - 3 * 3600_000) {
        addDrive(back, e2, 3, 1, km);
        addSupercharge(dayStart);
        dayKm += km;
      }
    }

    if (dayKm > 0 && day >= 1) addHomeCharge(dayStart, dayKm * 0.155);
    if (!isWeekend && day > 25 && rand() < 0.04) addSupercharge(dayStart);

    // m4e 第二辆车（Model Y Demo）：约每 3 天一段接送/购物短途 + 当夜家充
    if (day % 3 === 0 && day >= 1) {
      const kmy = 8 + rand() * 7;
      const sy = bjTime(y, mo, d, 16, Math.floor(rand() * 90));
      const ey = sy + Math.round(kmy / 26 * 3600_000);
      if (ey <= nowMs - 3 * 3600_000) {
        addDrive(sy, ey, 1, 2, kmy, 2);
        addHomeCharge(dayStart, kmy * 0.17, 2);
      }
    }
  }

  // 「今天」近 3 小时一段短途：让 24h 时间轴/仪表盘有活数据
  {
    const s = nowMs - 3.2 * 3600_000;
    addDrive(s, s + 32 * 60_000, 1, 2, 14.2);
  }

  const byEndDesc = [...drives].sort((a, b) => new Date(b.end_at) - new Date(a.end_at));
  const car1Last = byEndDesc.find((d) => d.car_id === 1);
  const car2Last = byEndDesc.find((d) => d.car_id === 2);
  const car1 = {
    id: 1, name: "Model 3 Demo", model: "Model 3", efficiency: 0.152,
    current_battery: 62, range_km: 318,
    odometer_km: odometer,
    position_at: car1Last?.end_at ?? null,
    last_drive_at: car1Last?.end_at ?? null,
  };
  const car2 = {
    id: 2, name: "Model Y Demo", model: "Model Y", efficiency: 0.165,
    current_battery: 58, range_km: 280,
    odometer_km: odometer2,
    position_at: car2Last?.end_at ?? null,
    last_drive_at: car2Last?.end_at ?? null,
  };
  return {
    generatedAt: nowMs,
    car: car1,
    cars: [car1, car2],
    drives,
    drivesByEndDesc: byEndDesc,
    charges,
    geofences: GEOFENCES,
    addresses: ADDRESSES,
    maxDriveId: driveId,
    maxChargeId: chargeId,
  };
}

// ---- SQL 指纹路由 -------------------------------------------------------------
const isoLit = (sql, marker) => {
  // expr() 产 (('...'::timestamptz ...)，列表 SQL 再包一层 → 允许多层括号
  const re = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\(+'([\\d-]{10}T[^']+)'", "m");
  const m = re.exec(sql);
  return m ? new Date(m[1]).getTime() : null;
};
const inRange = (iso, fromMs, toMs) => {
  const t = new Date(iso).getTime();
  if (fromMs != null && t < fromMs) return false;
  if (toMs != null && t > toMs) return false;
  return true;
};

/** 充电功率/SoC 曲线采样（charges 表形态） */
function chargesCurve(session) {
  const s = new Date(session.start_at).getTime();
  const e = new Date(session.end_at).getTime();
  const n = Math.max(6, Math.min(30, Math.round(session.duration_min / 4)));
  const rows = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const p = session.kind === "super" ? 120 * (1 - f * 0.75) : 7.2 - f * 0.8;
    const batt = session.start_battery_level + (session.end_battery_level - session.start_battery_level) * f;
    rows.push({
      date: new Date(s + (e - s) * f).toISOString(),
      battery_level: round(batt, 0),
      charger_power: round(p, 1),
    });
  }
  return rows;
}

/**
 * demo db：与 createDb 同形接口。query(sql, params) 按 SQL 指纹返回种子数据切片；
 * 未知指纹返回 [] 并记一次警告（不触网、不抛错）。
 */
export function createDemoDb({ dataset = buildDemoDataset() } = {}) {
  const warned = new Set();
  const miss = (sql) => {
    const key = sql.slice(0, 60);
    if (!warned.has(key)) {
      warned.add(key);
      process.stderr.write(`[demo] unmatched SQL fingerprint → [] : ${sql.replace(/\s+/g, " ").slice(0, 120)}\n`);
    }
    return [];
  };

  async function query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    // m4e：多数查询首位参数是可选 carId（null=不过滤）
    const carIdParam = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

    // --- geofences / addresses / cars ---
    if (s.includes("FROM geofences")) return dataset.geofences.map((g) => ({ ...g }));
    if (s.includes("FROM addresses")) return dataset.addresses.map((a) => ({ ...a }));
    if (s.includes("FROM cars c ORDER BY")) {
      // getCars（m4e 车切换器）
      return dataset.cars.map((c) => ({ id: c.id, name: c.name }));
    }
    if (s.includes("FROM cars c")) {
      // getCarSnapshot：带 $1 时按车返回，否则主车
      const want = carIdParam(params[0]);
      const car = dataset.cars.find((c) => c.id === want) ?? dataset.car;
      return [{ ...car }];
    }

    // --- 状态 / 系统统计 ---
    if (s.includes("WHEN ch.id IS NOT NULL")) {
      return [{ state: "asleep", charging_process_id: null, charging_battery: null, charging_power: null }];
    }
    if (s.includes("has_table_privilege")) {
      return [{ table_write: false, schema_create: false }]; // demo 永远「无写权限」
    }
    if (s.includes("COALESCE(sum(d.distance), 0) AS distance_km") && s.includes("drive_minutes")) {
      const since = isoLit(sql, "d.end_date >=");
      const rows = dataset.drives.filter((d) => (since == null || new Date(d.end_at).getTime() >= since) && (carIdParam(params[0]) == null || d.car_id === carIdParam(params[0])));
      return [{
        distance_km: round(rows.reduce((a, d) => a + d.distance_km, 0), 2),
        drive_count: rows.length,
        drive_minutes: rows.reduce((a, d) => a + d.duration_min, 0),
      }];
    }
    if (s.includes("COALESCE(sum(d.distance), 0) AS distance_km")) {
      const since = isoLit(sql, "d.end_date >=");
      const rows = dataset.drives.filter((d) => (since == null || new Date(d.end_at).getTime() >= since) && (carIdParam(params[0]) == null || d.car_id === carIdParam(params[0])));
      return [{ distance_km: round(rows.reduce((a, d) => a + d.distance_km, 0), 2) }];
    }
    if (s.includes("drive_count")) {
      const want = carIdParam(params[0]);
      const rows = want == null ? dataset.drives : dataset.drives.filter((d) => d.car_id === want);
      const car = want == null ? dataset.car : dataset.cars.find((c) => c.id === want);
      return [{ drive_count: rows.length, last_drive_at: car?.last_drive_at ?? null }];
    }

    // --- 行程列表（listDrivesSql：WITH matched + params [carId, limit, offset]） ---
    if (s.includes("WITH matched AS")) {
      const fromMs = isoLit(sql, "d.end_date >=");
      const toMs = isoLit(sql, "d.end_date <=");
      const want = carIdParam(params[0]);
      const rows = dataset.drivesByEndDesc.filter((d) => inRange(d.end_at, fromMs, toMs) && (want == null || d.car_id === want));
      const limit = Number(params[1]) || 50;
      const offset = Number(params[2]) || 0;
      return rows.slice(offset, offset + limit).map((d) => ({ ...d }));
    }
    // FIFO 回放轻量分页（listDrivesLightSql：特征列 ideal_used_km + JOIN cars，ASC；
    // 排除富化查询 —— 它也含 ideal_used_km，由下方 id = ANY 处理器负责）
    if (s.includes("ideal_used_km") && s.includes("FROM drives d") && !s.includes("id = ANY")) {
      const fromMs = isoLit(sql, "d.end_date >=");
      const toMs = isoLit(sql, "d.end_date <=");
      const want = carIdParam(params[0]);
      const rows = dataset.drivesByEndDesc
        .filter((d) => inRange(d.end_at, fromMs, toMs) && (want == null || d.car_id === want))
        .sort((a, b) => new Date(a.end_at) - new Date(b.end_at));
      const limit = Number(params[1]) || 1000;
      const offset = Number(params[2]) || 0;
      return rows.slice(offset, offset + limit).map((d) => ({ ...d }));
    }
    // 回放水位（max id + max end_date；demo 给真实值 → 回放缓存可用）
    if (s.includes("max(end_date)") && s.includes("FROM drives")) {
      const rows = [...dataset.drives].sort((a, b) => a.id - b.id);
      const last = rows[rows.length - 1];
      return [{ max_id: last?.id ?? 0, max_end: last?.end_at ?? null }];
    }
    if (s.includes("max(end_date)") && s.includes("FROM charging_processes")) {
      const rows = [...dataset.charges].sort((a, b) => a.id - b.id);
      const last = rows[rows.length - 1];
      return [{ max_id: last?.id ?? 0, max_end: last?.end_at ?? null }];
    }
    // getActiveDrives（按车活跃行程；demo 全部已结算 → 空）
    if (s.includes("d.end_date IS NULL") && s.includes("d.car_id")) {
      return [];
    }
    // carsListCached（index.mjs 车辆标记缓存：SELECT id, name FROM cars ORDER BY id ASC）
    if (s.includes("FROM cars ORDER BY id ASC")) {
      return dataset.cars.map((c) => ({ id: c.id, name: c.name }));
    }
    // 回放效率表（fifo-ledger：SELECT id, efficiency FROM cars）
    if (s.includes("SELECT id, efficiency FROM cars")) {
      return dataset.cars.map((c) => ({ id: c.id, efficiency: c.efficiency }));
    }
    if (s.includes("count(*)::int AS total FROM drives")) {
      const fromMs = isoLit(sql, "d.end_date >=");
      const toMs = isoLit(sql, "d.end_date <=");
      return [{ total: dataset.drivesByEndDesc.filter((d) => inRange(d.end_at, fromMs, toMs)).length }];
    }

    // --- 行程详情 / 洞察聚合 ---
    if (s.includes("outside_temp_avg AS outside_temp_avg_c")) {
      const id = Number(params[0]);
      return dataset.drives
        .filter((d) => d.id === id)
        .map((d) => ({ ...d, outside_temp_avg_c: d.outside_temp_avg, start_position_id: null, end_position_id: null }));
    }
    if (s.includes("avg(d.outside_temp_avg)")) {
      // 周月报/日报洞察聚合（positions 子查询在 demo 无数据 → null，模板自然降级）
      const ids = Array.isArray(params[0]) ? params[0] : [];
      const rows = dataset.drives.filter((d) => ids.includes(d.id));
      if (!rows.length) return [];
      const temps = rows.map((d) => d.outside_temp_avg);
      return [{
        avg_temp: round(temps.reduce((a, b) => a + b, 0) / temps.length, 1),
        min_temp: round(Math.min(...temps), 1),
        max_temp: round(Math.max(...temps), 1),
        power_max_kw: round(Math.max(...rows.map((d) => d.power_max)), 1),
        avg_duration_min: round(rows.reduce((a, d) => a + d.duration_min, 0) / rows.length, 1),
        avg_speed: null, max_speed: null, idle_ratio: null, tire_fl: null, tire_rr: null, tire_min: null,
      }];
    }
    if (s.includes("max(p.speed) AS max_speed")) {
      const d = dataset.drives.find((x) => x.id === Number(params[0]));
      const avgSpeed = d && d.duration_min > 0 ? d.distance_km / (d.duration_min / 60) : null;
      return [{ max_speed: d ? Math.max(Math.round(avgSpeed * 1.35), 32) : null, avg_temp: d?.outside_temp_avg ?? null }];
    }
    if (s.includes("FROM positions")) {
      return []; // demo 无轨迹点（轨迹图空态，刻意）
    }

    // --- 充电列表/详情/曲线/统计（先于时间轴分支：列表 SQL 同样含 start_at/end_at 别名） ---
    const monthMatch = /\('(\d{4}-\d{2})-01'/.exec(s);
    const month = monthMatch ? monthMatch[1] : null;
    const chargeInMonth = (c) => !month || c.start_at.slice(0, 7) === month;
    if (s.includes("FROM charging_processes cp LEFT JOIN geofences") && s.includes("LIMIT")) {
      const want = carIdParam(params[2]); // m4e：params [limit, offset, carId]
      const rows = [...dataset.charges]
        .filter((c) => chargeInMonth(c) && (want == null || c.car_id === want))
        .sort((a, b) => new Date(b.end_at) - new Date(a.end_at));
      const limit = Number(params[0]) || 50;
      const offset = Number(params[1]) || 0;
      return rows.slice(offset, offset + limit).map((c) => ({
        ...c,
        geofence_cost_per_unit: gfById.get(c.geofence_id)?.price_per_unit ?? null,
        geofence_session_fee: gfById.get(c.geofence_id)?.session_fee ?? null,
      }));
    }
    if (s.includes("count(*)::int AS total FROM charging_processes")) {
      const want = carIdParam(params[0]);
      return [{ total: dataset.charges.filter((c) => chargeInMonth(c) && (want == null || c.car_id === want)).length }];
    }

    // --- 时间轴 / 热力图 ---
    if (s.includes("d.start_date AS start_at, d.end_date AS end_at")) {
      const since = isoLit(sql, "d.end_date >=") ?? 0;
      return dataset.drives
        .filter((d) => new Date(d.end_at).getTime() >= since)
        .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))
        .map((d) => ({ start_at: d.start_at, end_at: d.end_at }));
    }
    if (s.includes("d.end_date AS end_at, d.distance")) {
      const since = isoLit(sql, "d.end_date >=") ?? 0;
      return dataset.drives
        .filter((d) => new Date(d.end_at).getTime() >= since)
        .sort((a, b) => new Date(a.end_at) - new Date(b.end_at))
        .map((d) => ({ end_at: d.end_at, distance: d.distance }));
    }
    if (s.includes("cp.start_date AS start_at, cp.end_date AS end_at")) {
      const since = isoLit(sql, "cp.end_date >=") ?? 0;
      return dataset.charges
        .filter((c) => new Date(c.end_at).getTime() >= since)
        .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))
        .map((c) => ({ start_at: c.start_at, end_at: c.end_at }));
    }
    if (s.includes("FROM states s")) {
      // 线性状态：一段进行中的 asleep（路由层用 drives/charges 段叠加裁剪）
      return [{ start_at: new Date(Date.now() - 48 * 3600_000).toISOString(), end_at: null, state: "asleep" }];
    }
    if (s.includes("charge_energy_used") && s.includes("WHERE cp.id = $1")) {
      const row = dataset.charges.find((c) => c.id === Number(params[0]));
      return row ? [{ ...row }] : [];
    }
    if (s.includes("FROM charges c WHERE c.charging_process_id")) {
      const row = dataset.charges.find((c) => c.id === Number(params[0]));
      return row ? chargesCurve(row) : [];
    }
    if (s.includes("cp.end_date ASC")) {
      // listChargingForStats（since/until 字面量可选；m4e $1=carId）
      const since = isoLit(sql, "cp.end_date >=");
      const until = isoLit(sql, "cp.end_date <");
      const want = carIdParam(params[0]);
      return dataset.charges
        .filter((c) => inRange(c.end_at, since, until) && (want == null || c.car_id === want))
        .sort((a, b) => new Date(a.end_at) - new Date(b.end_at))
        .map((c) => ({
          ...c,
          geofence_cost_per_unit: gfById.get(c.geofence_id)?.price_per_unit ?? null,
          geofence_session_fee: gfById.get(c.geofence_id)?.session_fee ?? null,
        }));
    }
    if (s.includes("ORDER BY cp.id DESC LIMIT 1")) {
      const last = dataset.charges[dataset.charges.length - 1];
      return last
        ? [{ id: last.id, start_at: last.start_at, end_at: last.end_at, charge_energy_added: last.charge_energy_added, cost: last.cost, geofence_id: last.geofence_id }]
        : [];
    }
    if (s.includes("SELECT cp.end_date AS end_at FROM charging_processes cp WHERE cp.id = $1")) {
      const row = dataset.charges.find((c) => c.id === Number(params[0]));
      return row ? [{ end_at: row.end_at }] : [];
    }

    // --- 增量轮询 / 水线（demo 数据静态：无新行、无进行中会话） ---
    if (s.includes("COALESCE(max(d.id), 0)::int")) return [{ max_id: dataset.maxDriveId }];
    if (s.includes("COALESCE(max(cp.id), 0)::int")) return [{ max_id: dataset.maxChargeId }];
    if (s.includes("d.id > $1") || s.includes("cp.id > $1")) return [];
    if (s.includes("d.end_date IS NULL")) return [];

    return miss(sql);
  }

  return {
    pool: null,
    query,
    async queryOne(sql, params = []) {
      const rows = await query(sql, params);
      return rows[0] ?? null;
    },
    async ping() {
      return true;
    },
    async close() {
      /* demo 无连接 */
    },
  };
}
