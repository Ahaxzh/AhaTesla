// demo-data.test.mjs — AHATESLA_DEMO 演示模式（m4d）：
// 确定性（同锚点两次生成全等）、行程分页切片、demo db 指纹路由覆盖关键查询、
// dashboard 月度聚合非零、isDemo 缓存。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDemoDataset, createDemoDb, isDemo } from "../src/core/demo-data.mjs";
import { listDrivesSql, getMonthStats, getGeofences } from "../src/core/teslamate-queries.mjs";
import { monthStartIso } from "../src/core/teslamate-queries.mjs";

const ANCHOR = Date.parse("2026-10-18T04:30:00.000Z"); // 北京 10-18 12:30，周三

test("数据集确定性：同锚点两次生成全等", () => {
  const a = buildDemoDataset(ANCHOR);
  const b = buildDemoDataset(ANCHOR);
  assert.deepEqual(a.drives, b.drives);
  assert.deepEqual(a.charges, b.charges);
  assert.equal(a.maxDriveId, b.maxDriveId);
});

test("90 天历史结构：工作日通勤 + 周末出游 + 充电会话 + geofence 单价", () => {
  const ds = buildDemoDataset(ANCHOR);
  assert.ok(ds.drives.length >= 120, `drives 应覆盖 90 天（实际 ${ds.drives.length}）`);
  assert.ok(ds.charges.length >= 40, `charges 应有家充+超充（实际 ${ds.charges.length}）`);
  assert.ok(ds.drives.every((d) => d.distance_km > 0 && d.duration_min >= 6));
  assert.ok(ds.drives.every((d) => new Date(d.start_at).getTime() < new Date(d.end_at).getTime()));
  // 家有单价 0.3、超充 1.8
  const gf = new Map(ds.geofences.map((g) => [g.name, g]));
  assert.equal(gf.get("家").price_per_unit, 0.3);
  assert.equal(gf.get("超充站(Demo)").price_per_unit, 1.8);
});

test("demo db：行程列表分页切片（listDrivesSql 形状 LIMIT $1 OFFSET $2）", async () => {
  const db = createDemoDb({ dataset: buildDemoDataset(ANCHOR) });
  const { sql, params } = listDrivesSql({});
  assert.deepEqual(params, []);
  const page1 = await db.query(sql, [...params, 20, 0]);
  const page2 = await db.query(sql, [...params, 20, 20]);
  assert.equal(page1.length, 20);
  assert.equal(page2.length, 20);
  const ids1 = new Set(page1.map((r) => r.id));
  for (const r of page2) assert.ok(!ids1.has(r.id), "分页不得重叠");
  // 倒序（最新在前）
  assert.ok(new Date(page1[0].end_at).getTime() >= new Date(page1[19].end_at).getTime());
  // 列表行带 computeTripViews 需要的列
  for (const r of page1) {
    assert.equal(typeof r.efficiency, "number");
    assert.ok(r.ideal_used_km > 0);
    assert.ok(r.start_geofence_id >= 1 && r.end_geofence_id <= 3);
  }
});

test("demo db：窗口过滤（from 字面量生效）+ 总数一致", async () => {
  const db = createDemoDb({ dataset: buildDemoDataset(ANCHOR) });
  const from = new Date(ANCHOR - 7 * 86_400_000).toISOString();
  const { sql } = listDrivesSql({ from });
  const rows = await db.query(sql, [200, 0]);
  assert.ok(rows.length > 0 && rows.length <= 30, `近 7 天行程量级合理（实际 ${rows.length}）`);
  for (const r of rows) assert.ok(new Date(r.end_at).getTime() >= new Date(from).getTime());
  const total = await db.queryOne("SELECT count(*)::int AS total FROM drives d WHERE d.end_date IS NOT NULL", []);
  assert.equal(total.total, buildDemoDataset(ANCHOR).drives.length);
});

test("demo db：月度统计非零（dashboard 口径）+ geofences 形状", async () => {
  const db = createDemoDb({ dataset: buildDemoDataset(ANCHOR) });
  const since = monthStartIso(new Date(ANCHOR));
  const month = await getMonthStats(db, since);
  assert.ok(month.distance_km > 0, "本月里程应非零");
  assert.ok(month.drive_count > 0);
  const gfs = await getGeofences(db);
  assert.equal(gfs.length, 3);
  assert.ok(gfs.every((g) => Number.isFinite(g.lat) && Number.isFinite(g.lng)));
});

test("demo db：充电列表/曲线/详情 + 只读探测 + ping", async () => {
  const ds = buildDemoDataset(ANCHOR);
  const db = createDemoDb({ dataset: ds });
  const list = await db.query(
    `SELECT cp.id, cp.start_date AS start_at, cp.end_date AS end_at, cp.charge_energy_added
     FROM charging_processes cp LEFT JOIN geofences g ON g.id = cp.geofence_id
     WHERE cp.end_date IS NOT NULL ORDER BY cp.end_date DESC LIMIT $1 OFFSET $2`,
    [10, 0]
  );
  assert.equal(list.length, 10);
  const curve = await db.query("SELECT c.date, c.battery_level, c.charger_power FROM charges c WHERE c.charging_process_id = $1 ORDER BY c.date ASC, c.id ASC", [list[0].id]);
  assert.ok(curve.length >= 6, "功率曲线应有采样点");
  assert.ok(curve[0].battery_level < curve[curve.length - 1].battery_level, "SoC 应上升");
  const probe = await db.queryOne("SELECT has_table_privilege(current_user, 'public.drives', 'INSERT,UPDATE,DELETE,TRUNCATE') AS table_write, has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create", []);
  assert.equal(probe.table_write, false, "demo 只读探测应为无写权限");
  await db.ping();
  await db.close();
});

test("demo db：增量轮询空结果（水线先建档、无新行）+ 未知指纹返回 []", async () => {
  const ds = buildDemoDataset(ANCHOR);
  const db = createDemoDb({ dataset: ds });
  const maxDrive = await db.queryOne("SELECT COALESCE(max(d.id), 0)::int AS max_id FROM drives d", []);
  assert.equal(maxDrive.max_id, ds.maxDriveId);
  const inc = await db.query("SELECT d.id FROM drives d WHERE d.id > $1 AND d.end_date IS NOT NULL ORDER BY d.id ASC LIMIT $2", [ds.maxDriveId, 50]);
  assert.deepEqual(inc, []);
  const unknown = await db.query("SELECT * FROM totally_unknown_table WHERE x = 1", []);
  assert.deepEqual(unknown, []);
});

test("isDemo：env 缓存语义（未设置即 false）", async () => {
  // 本进程其他套件未设 AHATESLA_DEMO；动态 import 后缓存已定，仅断言非 demo 默认
  assert.equal(typeof isDemo(), "boolean");
  if (!process.env.AHATESLA_DEMO) assert.equal(isDemo(), false);
});
