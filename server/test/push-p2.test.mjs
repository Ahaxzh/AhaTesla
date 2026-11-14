// push-p2.test.mjs — P2 告警事件群回归:断联边沿 / 充电中断派生 / 胎压巡检 / 9×6 矩阵。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutageWatcher, resetHealth, recordProbe } from "../src/core/health.mjs";
import { checkTirePressure, checkBatteryLow } from "../src/core/alerts.mjs";
import { createNotifier, PUSH_EVENTS, defaultMatrix, matrixFromRules } from "../src/core/push-channels.mjs";

// ---- outage watcher 边沿 ----
test("断联 ≥10min 触发一次,10min 内不触发,恢复沿带总时长且仅一次", () => {
  resetHealth();
  const fired = [];
  const w = createOutageWatcher({ thresholdMs: 10 * 60_000, onOutage: (ms) => fired.push(["down", ms]), onRecovered: (ms) => fired.push(["up", ms]) });
  let t = 1_000_000;
  const fail = () => { t += 30_000; w.observe(recordProbe(false, t), t); };
  const ok = () => { t += 30_000; w.observe(recordProbe(true, t), t); };

  for (let i = 0; i < 20; i++) fail(); // outageMs 到 570s(9.5 分钟):不触发
  assert.equal(fired.length, 0, "10 分钟内不应告警");
  fail(); // outageMs = 600s,达到阈值
  assert.equal(fired.length, 1);
  assert.equal(fired[0][0], "down");
  for (let i = 0; i < 5; i++) fail(); // 持续断联不再重复
  assert.equal(fired.length, 1, "断联期间只告警一次");
  ok();
  assert.equal(fired.length, 2);
  assert.equal(fired[1][0], "up");
  assert.ok(fired[1][1] >= 10 * 60_000, "恢复沿带断联总时长");
  ok(); ok();
  assert.equal(fired.length, 2, "恢复后不再重复");

  // 未达阈值就恢复:无任何推送
  const quiet = [];
  const w2 = createOutageWatcher({ thresholdMs: 10 * 60_000, onOutage: (ms) => quiet.push(ms), onRecovered: () => quiet.push(-1) });
  w2.observe({ dbOk: false, outageMs: 5 * 60_000 });
  w2.observe({ dbOk: true, outageMs: 0 });
  assert.equal(quiet.length, 0, "闪断(未达阈值)不推送");
});

// ---- 充电中断派生(dispatch 集成) ----
test("charging_done 且 endedEarly → 派生 chargeInterrupt 告警;≥80 不派生", async () => {
  // 派生逻辑在 index.mjs dispatchPush;此处验证 notifier 侧事件体渲染与矩阵路由。
  // 单探针渠道 + 显式矩阵 → 每次 dispatch 恰好一条 body,索引稳定。
  const bodies = [];
  const probe = { enabled: () => true, status: () => ({}), send: async ({ title, body }) => { bodies.push({ title, body }); return { sent: true }; } };
  const notifier = createNotifier({ state: {}, telegram: probe, feishu: null, webpush: null, wecom: null, ntfy: null, bark: null });
  const matrix = Object.fromEntries(
    ["chargingDone", "chargeInterrupt", "outage", "tirePressure"].map((ev) => [ev, { telegram: true }])
  );

  await notifier.dispatch({ type: "charging_done", energyKwh: 18, costCny: 16.6, endBattery: 72, locationName: "超充站", endedEarly: true, charging_process_id: 492 }, { matrix });
  await notifier.dispatch({ type: "chargeInterrupt", endBattery: 72, energyKwh: 18, locationName: "超充站", charging_process_id: 492 }, { matrix });

  assert.match(bodies[0].title, /充电提前中止/); // charging_done 标题即带 ⚠(P1-d)
  assert.match(bodies[1].title, /充电提前中止/);
  assert.match(bodies[1].body, /止于 72%/);
  assert.match(bodies[1].body, /已充 18 kWh/);
  assert.match(bodies[1].body, /超充站/);
  // outage 族(共用 outage 矩阵行)
  await notifier.dispatch({ type: "outage", outageMs: 12 * 60_000 }, { matrix });
  await notifier.dispatch({ type: "outage_recovered", outageMs: 33 * 60_000 }, { matrix });
  assert.match(bodies[2].body, /断联已 12 分钟/);
  assert.match(bodies[3].body, /断联共 33 分钟/);
  // 胎压
  await notifier.dispatch({ type: "tirePressure", tirePressure: { fl: 2.5, fr: 2.6, rl: 2.6, rr: 2.5 }, minBar: 2.5, suggest: 2.9 }, { matrix });
  assert.match(bodies[4].body, /FL 2\.5 \/ FR 2\.6/);
  assert.match(bodies[4].body, /建议补至 2\.9/);
});

// ---- 胎压巡检判定 ----
function tireDb({ latest, p90 }) {
  return {
    query: async (sql) => (sql.includes("ORDER BY p.id DESC\n      LIMIT 1") ? [latest] : []),
    queryOne: async () => (p90 != null ? { p90 } : null)
  };
}

test("checkTirePressure:越限返回四轮+建议值(P90);正常返回 null;异常静默 null", async () => {
  const r = await checkTirePressure(tireDb({ latest: { fl: 2.5, fr: 2.6, rl: 2.55, rr: 2.5 }, p90: 2.95 }));
  assert.equal(r.min, 2.5);
  assert.equal(r.suggest, 3.0, "P90 2.95 四舍五入 3.0");
  assert.equal(await checkTirePressure(tireDb({ latest: { fl: 3.0, fr: 3.0, rl: 3.0, rr: 3.0 }, p90: 3.0 })), null, "正常不告警");
  assert.equal(await checkTirePressure(tireDb({ latest: null, p90: null })), null, "无数据不告警");
  const brokenDb = { query: async () => { throw new Error("db down"); }, queryOne: async () => null };
  assert.equal(await checkTirePressure(brokenDb), null, "查询异常静默");
});

// ---- 低电量巡检判定（v2.5） ----
function batteryDb({ latest, charging }) {
  return {
    query: async (sql) => (/FROM positions p/.test(sql) && /battery_level/.test(sql) ? (latest ? [latest] : []) : []),
    queryOne: async (sql) => (/FROM charging_processes/.test(sql) && /end_date IS NULL/.test(sql) ? (charging ? { charging: 1 } : null) : null)
  };
}

test("checkBatteryLow:低于阈值且未充电 → 告警;充电中/正常/无数据 → null", async () => {
  const r = await checkBatteryLow(batteryDb({ latest: { car_id: 1, battery_level: 17 }, charging: false }));
  assert.deepEqual(r, { carId: 1, batteryLevel: 17, thresholdPct: 20 });
  assert.equal(await checkBatteryLow(batteryDb({ latest: { car_id: 1, battery_level: 17 }, charging: true })), null, "充电中不告警(电量回升)");
  assert.equal(await checkBatteryLow(batteryDb({ latest: { car_id: 1, battery_level: 55 }, charging: false })), null, "电量正常不告警");
  assert.equal(await checkBatteryLow(batteryDb({ latest: null, charging: false })), null, "无读数不告警");
  const brokenDb = { query: async () => { throw new Error("db down"); }, queryOne: async () => null };
  assert.equal(await checkBatteryLow(brokenDb), null, "查询异常静默");
  // 推送正文:电量 + 阈值 + 补电提示
  const { createNotifier } = await import("../src/core/push-channels.mjs");
  const bodies = [];
  const ntfy = { send: async (e) => { bodies.push(e); return { ok: true }; } };
  const notifier = createNotifier({ state: { pushRules: {} }, ntfy });
  await notifier.dispatch({ type: "batteryLow", batteryLevel: 17, thresholdPct: 20 }, { matrix: { batteryLow: { webpush: false, telegram: false, feishu: false, wecom: false, ntfy: true, bark: false } } });
  assert.match(bodies[0].title, /电量偏低/);
  assert.match(bodies[0].body, /17%/);
  assert.match(bodies[0].body, /20%/);
  assert.match(bodies[0].body, /补电/);
});

// ---- 11×6 矩阵（v2.5 +batteryLow 告警 +annual 年报） ----
test("矩阵 11 事件 × 6 渠道;告警四事件默认 webpush/telegram/feishu 开;outage_recovered 复用 outage 行", () => {
  assert.equal(PUSH_EVENTS.length, 11);
  const m = defaultMatrix();
  for (const ev of ["outage", "chargeInterrupt", "tirePressure", "batteryLow"]) {
    assert.deepEqual(
      [m[ev].webpush, m[ev].telegram, m[ev].feishu],
      [true, true, true],
      `${ev} 告警默认即时渠道全开`
    );
    assert.equal(m[ev].wecom, false);
  }
  assert.equal(m.tripEnd.feishu, true, "内容事件默认不变");
  assert.equal(m.annual.feishu, true, "年报与周/月报同默认（仅飞书）");
  // 归一:存量矩阵(无新键)补齐后告警行保持默认开
  const legacy = { matrix: { tripEnd: { feishu: true } } };
  const normalized = matrixFromRules(legacy);
  assert.equal(normalized.outage.telegram, true, "存量用户升级后告警默认开");
  assert.equal(normalized.batteryLow.telegram, true, "v2.5 新告警对存量用户也默认开");
  assert.equal(normalized.annual.feishu, true, "v2.5 新年报默认仅飞书");
  assert.equal(normalized.tripEnd.webpush, false, "内容事件存量语义不变");
});
