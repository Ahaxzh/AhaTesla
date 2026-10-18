// car-scope.test.mjs — m4e 多车:carId 解析链 / /api/cars / settings 新字段 / 推送车标记。
import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/api/http-kit.mjs";
import { carIdFromQuery, carFilterSql, carsPayload } from "../src/api/car-scope.mjs";
import { createNotifier } from "../src/core/push-channels.mjs";

const ctxOf = (query = {}) => ({ query });

test("carIdFromQuery:显式参数 > settings.primaryCarId > 向导绑定 > null", () => {
  const state = { settings: { primaryCarId: 7 }, datasource: { carId: 3 } };
  assert.equal(carIdFromQuery(ctxOf({ carId: "5" }), state), 5); // 显式最优先
  assert.equal(carIdFromQuery(ctxOf({}), state), 7); // settings 主车
  assert.equal(carIdFromQuery(ctxOf({}), { settings: {}, datasource: { carId: 3 } }), 3); // 向导绑定
  assert.equal(carIdFromQuery(ctxOf({}), { settings: {}, datasource: {} }), null); // 都无 → 不过滤
  assert.equal(carIdFromQuery(ctxOf({ carId: "" }), state), 7); // 空串视为缺省
});

test("carIdFromQuery:非法值 400(非整数/负数/垃圾)", () => {
  for (const bad of ["abc", "1.5", "-3", "0"]) {
    assert.throws(() => carIdFromQuery(ctxOf({ carId: bad }), {}), HttpError);
  }
});

test("carFilterSql:内联片段按需生成", () => {
  assert.equal(carFilterSql(null), "");
  assert.equal(carFilterSql(9), " AND d.car_id = 9");
  assert.equal(carFilterSql(9, "cp.car_id"), " AND cp.car_id = 9");
});

test("carsPayload:teslamate 车辆 + 别名 + 主车标记", async () => {
  const db = { query: async () => [{ id: 1, name: "Model 3" }, { id: 2, name: "Model Y" }] };
  const state = { settings: { primaryCarId: 2, carAliases: { "2": "老婆的车" } } };
  const out = await carsPayload(db, state);
  assert.deepEqual(out, [
    { id: 1, name: "Model 3", alias: null, isPrimary: false },
    { id: 2, name: "Model Y", alias: "老婆的车", isPrimary: true },
  ]);
  const single = await carsPayload(db, { settings: {} });
  assert.equal(single.every((c) => !c.isPrimary && c.alias === null), true);
});

test("推送标题:carLabel 后缀(多车标记由 dispatchPush 预挂;单车/无标记零变化)", async () => {
  const titles = [];
  const probe = { enabled: () => true, status: () => ({}), send: async ({ title }) => { titles.push(title); return { sent: true }; } };
  const notifier = createNotifier({ state: {}, feishu: probe, telegram: null, webpush: null });
  const matrix = { tripEnd: { feishu: true }, daily: { feishu: true } };
  await notifier.dispatch({ type: "trip_end", carLabel: "老婆的车", distanceKm: 5 }, { matrix });
  await notifier.dispatch({ type: "trip_end", distanceKm: 5 }, { matrix });
  await notifier.dispatch({ type: "daily", carLabel: "Model Y" }, { matrix });
  assert.match(titles[0], /行程结束 · .+ · 老婆的车$/);
  assert.equal(titles[1].split(" · ").length, 2, "无标记:标题只有 事件·时间戳 两段"); // 无标记:无后缀
  assert.match(titles[2], /昨日用车日报 · .+ · Model Y$/);
});

test("/api/cars 与 settings primaryCarId/carAliases 往返(经 registerRoutes 全链路)", async () => {
  process.env.AHA_STATE_IN_MEMORY = "1";
  const { useMemoryStore } = await import("../src/core/state.mjs");
  useMemoryStore();
  const state = { settings: {}, datasource: {}, pricing: { defaultRateCnyPerKwh: 1, history: [] }, pushRules: {} };
  const carsRows = [{ id: 1, name: "Model 3" }, { id: 2, name: "Model Y" }];
  const db = {
    query: async (sql) => (/FROM cars ORDER BY/.test(sql) ? carsRows : []),
    queryOne: async () => null,
  };
  const app = null; // 路由级直测(鉴权环境省略);注册在 index.mjs 已随 /api/cars 走通
  const { createSettingsRoutes } = await import("../src/api/dashboard-extra-routes.mjs");
  const kv = new Map();
  const settings = createSettingsRoutes({
    state,
    getStore: () => ({ kvPut: (k, v) => kv.set(k, v), kvGet: (k) => kv.get(k) ?? null }),
  });
  const put = async (body) => settings.put({ body, query: {} });

  // 默认回显
  assert.deepEqual((await settings.get({ query: {} })).primaryCarId, null);
  // 设置主车 + 别名
  await put({ primaryCarId: 2, carAliases: { "2": "老婆的车", "1": "我的车" } });
  const cur = await settings.get({ query: {} });
  assert.equal(cur.primaryCarId, 2);
  assert.equal(cur.carAliases["2"], "老婆的车");
  assert.ok(JSON.parse(kv.get("app:settings")).primaryCarId === 2, "kv 持久化包含主车");
  // 清除主车(回退向导绑定)
  await put({ primaryCarId: null });
  assert.equal((await settings.get({ query: {} })).primaryCarId, null);
  // 非法值
  await assert.rejects(() => put({ primaryCarId: "x" }), HttpError);
  await assert.rejects(() => put({ carAliases: { "2": "" } }), HttpError);
  await assert.rejects(() => put({ carAliases: { "abc": "x" } }), HttpError);
});
