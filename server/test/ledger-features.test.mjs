// ledger-features.test.mjs — t_d9fb43bd（GA-13/14/15）：TOU 分时计价、四层回退第①层、
// 驻车损耗、FIFO 闭合不变量（AC-7.2，PM v1.3 验收硬条件）、补录 7 天窗口。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  priceChargingSession,
  batchesFromChargingSessions,
  allocateDriveCosts,
  isOffPeak,
  touSplitSession,
  parkingLossBetween,
  applyParkingLossToBatches,
  PARKING_LOSS_THRESHOLD_KWH
} from "../src/core/pricing-ledger.mjs";
import { openStore } from "../src/core/store.mjs";

// ---- GA-15：四层回退第①层（本地补录优先于一切）------------------------------

test("GA-15: 本地补录（overrides）优先于 stated cost / geofence / default", () => {
  const session = {
    id: 1,
    charge_energy_added: 50,
    cost: 99,                    // 第②层 stated
    geofence_cost_per_unit: 2,   // 第③层
    start_at: "2026-01-01 10:00",
    end_at: "2026-01-01 11:00"
  };
  // 无 overrides → stated 生效
  assert.equal(priceChargingSession(session, 1).source, "stated");
  // 有 overrides → 第①层 manual 生效
  const priced = priceChargingSession(session, 1, { overrides: new Map([[1, 55]]) });
  assert.equal(priced.source, "manual");
  assert.equal(priced.costCny, 55);
  assert.equal(priced.pricePerUnit, 1.1);
});

// ---- GA-13 附带：geofence TOU 分时计价（AC-7.1③）-----------------------------

test("isOffPeak：谷段窗口判断（含跨午夜）", () => {
  const win = { offPeakStart: "23:00", offPeakEnd: "07:00", offPeakRate: 0.3, peakRate: 1.0 };
  assert.equal(isOffPeak(23 * 60, win), true);   // 23:00 谷
  assert.equal(isOffPeak(3 * 60, win), true);    // 03:00 谷
  assert.equal(isOffPeak(6 * 60 + 59, win), true); // 06:59 谷
  assert.equal(isOffPeak(7 * 60, win), false);   // 07:00 峰
  assert.equal(isOffPeak(12 * 60, win), false);  // 正午峰
  assert.equal(isOffPeak(22 * 60 + 59, win), false);
  // 非跨午夜窗口
  const win2 = { offPeakStart: "00:00", offPeakEnd: "08:00", offPeakRate: 0.3, peakRate: 1.0 };
  assert.equal(isOffPeak(7 * 60 + 59, win2), true);
  assert.equal(isOffPeak(8 * 60, win2), false);
});

test("touSplitSession：跨午夜会话按时长比例分摊，费用 = Σ段电量×段价", () => {
  // 窗口按「时区墙钟」解释：tz=UTC 时 22:00→02:00 会话跨 23:00-07:00 谷窗
  // （峰 60min 谷 180min，共 240min）—— 时区参数显式给 UTC 保持纯数学口径。
  const start = Date.UTC(2026, 0, 1, 22, 0);
  const end = Date.UTC(2026, 0, 2, 2, 0);
  const split = touSplitSession({
    startMs: start, endMs: end, energyKwh: 40,
    window: { offPeakStart: "23:00", offPeakEnd: "07:00", offPeakRate: 0.3, peakRate: 1.2 },
    tz: "UTC"
  });
  assert.ok(split);
  assert.equal(split.offPeakKwh, 30); // 180/240 × 40
  assert.equal(split.peakKwh, 10);     // 60/240 × 40
  assert.equal(split.costCny, 30 * 0.3 + 10 * 1.2); // 9 + 12 = 21
  assert.equal(split.source, "geofence-tou");
});

test("touSplitSession：默认 Asia/Shanghai —— 整夜谷电充电不得按峰价计（时区修复回归）", () => {
  // 北京 23:00 → 次日 07:00（= UTC 15:00 → 23:00）整段在谷窗内。
  // 修复前用 getUTCHours() 比对窗口，整夜被错判为峰电（8 小时平移）。
  const start = Date.UTC(2026, 0, 1, 15, 0);
  const end = Date.UTC(2026, 0, 1, 23, 0); // 北京次日 07:00
  const split = touSplitSession({
    startMs: start, endMs: end, energyKwh: 56,
    window: { offPeakStart: "23:00", offPeakEnd: "07:00", offPeakRate: 0.3, peakRate: 1.2 }
  });
  assert.ok(split);
  assert.equal(split.offPeakKwh, 56); // 全谷
  assert.equal(split.peakKwh, 0);
  assert.equal(split.costCny, 56 * 0.3);
});

test("priceFromGeofence TOU 优先于固定单价（同围栏配置了 tou 窗口）", () => {
  const session = {
    id: 7, geofence_id: 5,
    charge_energy_added: 40,
    geofence_cost_per_unit: 2, // 固定价存在但 tou 优先
    start_at: "2026-01-01T22:00:00Z", end_at: "2026-01-02T02:00:00Z"
  };
  const tou = new Map([[5, { offPeakStart: "23:00", offPeakEnd: "07:00", offPeakRate: 0.3, peakRate: 1.2 }]]);
  const priced = priceChargingSession(session, 1, { touByGeofenceId: tou, tz: "UTC" });
  assert.equal(priced.source, "geofence-tou");
  assert.equal(priced.costCny, 21);
});

// ---- GA-13：驻车损耗（AC-7.5）----------------------------------------------

test("parkingLossBetween：>0.5kWh 计损，≤0.5 与负损耗（温漂回升）过滤", () => {
  assert.deepEqual(parkingLossBetween(60, 55), { kwh: 5 });      // 5kWh 损耗
  assert.equal(parkingLossBetween(60, 59.8), null);              // 0.2 ≤ 阈值
  assert.equal(parkingLossBetween(60, 60), null);                // 零
  assert.equal(parkingLossBetween(55, 55.3), null);              // 回升 0.3（温漂）过滤
  assert.equal(parkingLossBetween(55, 60), null);                // 回升 5kWh 也是负损耗 → 过滤
  assert.equal(parkingLossBetween(null, 50), null);              // 缺读数不可计算
});

test("applyParkingLossToBatches：损耗从最老批次冲抵，超出余量部分报 unabsorbed", () => {
  const queue = [
    { batch_id: "cp-1", available_at_ms: 1000, remaining_kwh: 3, unit_price_cny_per_kwh: 1 },
    { batch_id: "cp-2", available_at_ms: 2000, remaining_kwh: 5, unit_price_cny_per_kwh: 2 }
  ];
  // 损耗 4kWh @ at=3000：cp-1 扣 3 + cp-2 扣 1
  const r1 = applyParkingLossToBatches(queue, 4, 3000);
  assert.equal(r1.absorbedKwh, 4);
  assert.equal(r1.unabsorbedKwh, 0);
  assert.equal(queue[0].remaining_kwh, 0);
  assert.equal(queue[1].remaining_kwh, 4);
  assert.equal(r1.slices.length, 2);
  assert.equal(r1.slices[0].cost_cny, 3);   // 3kWh × ¥1
  assert.equal(r1.slices[1].cost_cny, 2);   // 1kWh × ¥2

  // 损耗超过全部余量：cp-2 只剩 4 → 吸收 4，unabsorbed 1
  const r2 = applyParkingLossToBatches(queue, 5, 3000);
  assert.equal(r2.absorbedKwh, 4);
  assert.equal(r2.unabsorbedKwh, 1);

  // 批次尚未 available（at 早于 available_at）不参与冲抵
  const q3 = [{ batch_id: "cp-3", available_at_ms: 5000, remaining_kwh: 9, unit_price_cny_per_kwh: 1 }];
  const r3 = applyParkingLossToBatches(q3, 2, 1000);
  assert.equal(r3.absorbedKwh, 0);
  assert.equal(r3.unabsorbedKwh, 2);
});

test("AC-7.5 阈值常量 = 0.5 kWh（PRD 口径）", () => {
  assert.equal(PARKING_LOSS_THRESHOLD_KWH, 0.5);
});

// ---- AC-7.2 闭合不变量（PM v1.3 验收硬条件）----------------------------------

test("AC-7.2 闭合不变量：批次全部耗尽时分摊电费总和 ≡ 实付总额（含 10% 充损）", () => {
  // PM 例子：买 50 度花 ¥50、进电瓶 45 度 → 批次 45kWh @ ¥1.111/kWh
  const sessions = [{
    id: 1, charge_energy_added: 45, cost: 50,
    start_at: "2026-01-01 10:00", end_at: "2026-01-01 11:00"
  }];
  const batches = batchesFromChargingSessions(sessions);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].energy_kwh, 45);
  assert.ok(Math.abs(batches[0].unit_price_cny_per_kwh - 50 / 45) < 0.0005); // ≈1.111

  // 行程正好耗尽 45 度 → 分摊总和 = ¥50（实付）
  const drives = Array.from({ length: 3 }, (_, i) => ({
    id: i + 1, start_at: `2026-01-0${i + 2} 08:00`, estimated_kwh: 15
  }));
  const { allocations } = allocateDriveCosts({ drives, batches, defaultRate: 9 });
  assert.equal(allocations.every((a) => a.cost_complete), true);
  const sumPrecise = allocations.reduce((acc, a) => acc + a.cost_cny_precise, 0);
  // 精确轨 10dp 内仍含逐批次 6dp 单价舍入 → 允许分位级容差（¥0.01）
  assert.ok(Math.abs(sumPrecise - 50) < 0.01, `closure drift ${sumPrecise - 50}`);
});

test("AC-7.2 闭合不变量：多批次混价全耗尽，总和 ≡ 实付总和", () => {
  const sessions = [
    { id: 1, charge_energy_added: 30, cost: 20, start_at: "2026-01-01 10:00", end_at: "2026-01-01 11:00" },
    { id: 2, charge_energy_added: 40, cost: 44, start_at: "2026-01-02 10:00", end_at: "2026-01-02 11:30" }
  ];
  const batches = batchesFromChargingSessions(sessions);
  const drives = [
    { id: 1, start_at: "2026-01-03 08:00", estimated_kwh: 50 },
    { id: 2, start_at: "2026-01-04 08:00", estimated_kwh: 20 }
  ];
  const { allocations } = allocateDriveCosts({ drives, batches, defaultRate: 9 });
  const sum = allocations.reduce((acc, a) => acc + a.cost_cny_precise, 0);
  assert.ok(Math.abs(sum - 64) < 0.01, `closure drift ${sum - 64}`); // 20+44
});

// ---- GA-14：补录覆盖 store 层往返（API 层窗口语义由 mock 路由测试覆盖）--------

test("GA-14: charge_cost_overrides SQLite 往返 + 批次入池采用补录价（第①层）", () => {
  const store = openStore({ file: ":memory:" });
  store.putChargeCostOverride({ cpId: 42, cost: 66.6, note: "国网发票" });
  const got = store.getChargeCostOverride(42);
  assert.equal(got.cpId, 42);
  assert.equal(got.cost, 66.6);
  assert.equal(got.currency, "CNY");
  assert.equal(got.note, "国网发票");
  const all = store.listChargeCostOverrides();
  assert.equal(all.length, 1);
  assert.equal(all[0].cost, 66.6);

  // 补录价进入 FIFO：stated cost 100 存在但被 overrides 66.6 压制
  const session = { id: 42, charge_energy_added: 60, cost: 100, start_at: "2026-01-01 10:00", end_at: "2026-01-01 11:00" };
  const batches = batchesFromChargingSessions([session], { overrides: new Map([[42, 66.6]]) });
  assert.equal(batches[0].amount_cny, 66.6);
  assert.ok(Math.abs(batches[0].unit_price_cny_per_kwh - 66.6 / 60) < 0.0005);
});
