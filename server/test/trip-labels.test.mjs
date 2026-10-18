// trip-labels.test.mjs — 行程小结地点解析与僵尸活动行防御的回归测试。
// 背景（2026-10-18 实例事故）：库中 431 条 end_date IS NULL 历史僵尸行，
// getActiveDrive 按"最新未关闭"直取 2025 年老行 → 闲置结算被永久压制，
// 行程小结迟到 25.5h；且地点解析 550m 一刀切 + 裸"起点/终点"兜底体验差。
import { test } from "node:test";
import assert from "node:assert/strict";
import { getActiveDrive } from "../src/core/teslamate-queries.mjs";
import { enrichTripEndEvent } from "../src/core/event-enrichment.mjs";
import { createNotifier } from "../src/core/push-channels.mjs";

const HOME = { lat: 24.606347, lng: 118.040564, radius: 192 }; // 用户真实 HOME 围栏参数

function fakeDb(handlers = []) {
  const calls = [];
  const match = (sql, args) => {
    const h = handlers.find((h) => h.when(sql));
    if (!h) throw new Error(`no fake handler for SQL: ${sql.slice(0, 60)}`);
    return h.then(args, sql);
  };
  return {
    calls,
    query: async (sql, args) => match(sql, args),
    queryOne: async (sql, args) => match(sql, args)?.[0] ?? null,
  };
}

test("getActiveDrive：僵尸行防御 — 12h 新鲜度窗口参数随行下发", async () => {
  let seen = null;
  const db = {
    queryOne: async (sql, args) => {
      seen = { sql, args };
      return { id: 42, start_at: "2026-10-18 02:00:00" };
    },
  };
  const active = await getActiveDrive(db);
  assert.ok(seen.sql.includes(">= $1::timestamp"), "SQL 必须带新鲜度过滤");
  const cutoff = new Date(seen.args[0] + "Z").getTime();
  const ago = Date.now() - cutoff;
  assert.ok(ago > 11.9 * 3600_000 && ago < 12.1 * 3600_000, `cutoff 应为 ~12h 前,实际 ${(ago / 3600_000).toFixed(2)}h`);
  assert.equal(active.id, 42);
});

function enrichmentDb({ rows, geofences, addresses = [] }) {
  return fakeDb([
    // 富化主查询(按 drive id 聚合)
    { when: (s) => s.includes("WHERE d.id = ANY"), then: () => rows },
    { when: (s) => s.includes("FROM geofences"), then: () => geofences },
    { when: (s) => s.includes("FROM addresses a\n    WHERE a.id = ANY"), then: () => addresses },
    { when: (s) => s.includes("ORDER BY (a.latitude - $1)"), then: () => (nearestAddrRows.length ? nearestAddrRows : []) },
  ]);
}
let nearestAddrRows = [];

const driveRow = (over = {}) => ({
  id: 3259, distance_km: 2.96, duration_min: 12, temp_avg: 30, power_max_kw: 40,
  start_address_id: null, end_address_id: null, start_geofence_id: null, end_geofence_id: 1,
  start_lat: 24.6090, start_lng: 118.0440, // ~400m 外的"图书馆"(无围栏)
  end_lat: HOME.lat, end_lng: HOME.lng,
  avg_speed: 23, max_speed: 48, idle_ratio: 0.05, min_temp: 30,
  fl: 3.0, fr: 3.0, rl: 3.1, rr: 3.1,
  ...over,
});

test("地点解析:围栏半径内命中 / 半径外不误标 / 地址表兜底 / 无解析返回 null", async () => {
  const gf = [{ id: 1, name: "HOME", lat: HOME.lat, lng: HOME.lng, radius: HOME.radius }];

  // 1) 端点在 HOME 半径内 → HOME
  nearestAddrRows = [];
  let ev = await enrichTripEndEvent(enrichmentDb({ rows: [driveRow()], geofences: gf }), { segment_ids: [3259], energyKwh: 0.5 });
  assert.equal(ev.endLabel, "HOME");

  // 2) 起点 ~400m(超过 192m 半径)且无地址围栏 → 不再误标 HOME,地址表兜底前为 null
  nearestAddrRows = [];
  assert.equal(ev.startLabel, null);

  // 3) 地址表有就近记录(250m 内语义) → 兜底命中
  nearestAddrRows = [{ display_name: "思明区图书馆", name: "思明区图书馆", road: null, city: null }];
  ev = await enrichTripEndEvent(enrichmentDb({ rows: [driveRow()], geofences: gf }), { segment_ids: [3259], energyKwh: 0.5 });
  assert.equal(ev.startLabel, "思明区图书馆");
  nearestAddrRows = [];
});

test("推送正文:路线行三态 — 双侧/单侧/无,消灭裸「起点/终点」", async () => {
  const bodies = [];
  const probe = { enabled: () => true, status: () => ({}), send: async ({ body }) => { bodies.push(body); return { sent: true }; } };
  const notifier = createNotifier({ state: {}, feishu: probe, telegram: null, webpush: null });
  const matrix = { tripEnd: { feishu: true } };

  await notifier.dispatch({ type: "trip_end", startLabel: "HOME", endLabel: "图书馆", distanceKm: 3 }, { matrix });
  await notifier.dispatch({ type: "trip_end", startLabel: null, endLabel: "HOME", distanceKm: 3 }, { matrix });
  await notifier.dispatch({ type: "trip_end", startLabel: null, endLabel: null, distanceKm: 3 }, { matrix });

  assert.match(bodies[0], /🚗 HOME → 图书馆/);
  assert.match(bodies[1], /🚗 → HOME/);      // 单侧:只显已解析侧
  assert.doesNotMatch(bodies[2], /🚗/);       // 双无:整行省略
  assert.doesNotMatch(bodies.join(""), /起点|终点/); // 任何情况下不再出现裸兜底词
});

test("毒状态自愈:快照无活动时清残留 active_started_at,闲置结算恢复", async () => {
  const { TripMonitor } = await import("../src/core/trip-monitor.mjs");
  const events = [];
  // 模拟真实事故现场:被僵尸行喂出的幽灵 driving 态(parked 在 3 小时前)
  const monitor = new TripMonitor({
    state: {
      initialized: true, last_drive_id: 3259,
      session: {
        phase: "driving", segment_ids: [3259], started_at: "2026-10-18T01:06:27Z",
        active_started_at: "2025-05-12T10:02:23Z", last_event_at: "2026-10-18T09:52:12Z",
        parked_at: "2026-10-18T01:18:42Z", finalization_reason: null, finalize_at: null,
      },
    },
    onEvent: (e) => events.push(e),
    clock: () => "2026-10-18T04:30:00Z", // parked 后 3h12m
  });
  monitor.reconcile({ active: null, completed: [] }); // 修复后的快照:active=null
  assert.equal(events.filter((e) => e.type === "trip_end").length, 1, "闲置超时应触发结算");
  assert.equal(events[0].segment_ids[0], 3259);
  assert.equal(monitor.state.session, null, "结算后 session 清空");
});

test("飞书渠道具备统一 send 接口(m4b 回归防护)", async () => {
  const { createFeishuChannel } = await import("../src/core/feishu.mjs");
  const ch = createFeishuChannel({ feishu: {} }); // 未配置
  assert.equal(typeof ch.send, "function", "dispatch 直接调 channel.send,m4b 曾漏配导致全线 feishu 静默失败");
  const r = await ch.send({ title: "t", body: "b" });
  assert.equal(r.sent, false);
  assert.equal(r.reason, "disabled");
});
