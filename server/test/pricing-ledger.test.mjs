// pricing-ledger.test.mjs — 计价批次账本核心断言（充电/行程序列费用分摊）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  priceChargingSession, batchesFromChargingSessions, allocateDriveCosts, driveEnergyKwh
} from "../src/core/pricing-ledger.mjs";

test("规则1: charging_processes.cost 非空直接使用", () => {
  const priced = priceChargingSession({ charge_energy_added: 20, cost: 32.0 }, 1.0);
  assert.equal(priced.costCny, 32.0);
  assert.equal(priced.pricePerUnit, 1.6);
  assert.equal(priced.source, "stated");
});

test("规则2: cost 空但 geofence 有单价 → energy×price + session_fee", () => {
  const priced = priceChargingSession({
    charge_energy_added: 20, cost: null,
    geofence_cost_per_unit: 1.5, geofence_session_fee: 2.0
  }, 1.0);
  assert.equal(priced.costCny, 32.0); // 20×1.5 + 2
  assert.equal(priced.pricePerUnit, 1.5);
  assert.equal(priced.source, "geofence");
});

test("规则3: 都没有 → 默认价", () => {
  const priced = priceChargingSession({ charge_energy_added: 20, cost: null }, 1.2);
  assert.equal(priced.costCny, 24.0);
  assert.equal(priced.pricePerUnit, 1.2);
  assert.equal(priced.source, "default");
});

test("无能量/无价格 → null", () => {
  assert.equal(priceChargingSession({ cost: null }, 1.0).costCny, null);
  assert.equal(priceChargingSession({ charge_energy_added: 10, cost: null }, null).costCny, null);
});

test("cost=0 视为未计价，回落 geofence", () => {
  const priced = priceChargingSession({
    charge_energy_added: 10, cost: 0, geofence_cost_per_unit: 1.4
  }, 1.0);
  assert.equal(priced.source, "geofence");
  assert.equal(priced.costCny, 14.0);
});

test("充电会话转为批次（FIFO 可用能量）", () => {
  const batches = batchesFromChargingSessions([
    { id: 1, start_at: "2026-01-01 00:00", end_at: "2026-01-01 01:00", charge_energy_added: 10, cost: 15 },
    { id: 2, start_at: "2026-01-02 00:00", end_at: "2026-01-02 01:00", charge_energy_added: 20, geofence_cost_per_unit: 1.5 },
    { id: 3, start_at: "2026-01-03 00:00", end_at: "2026-01-03 01:00", charge_energy_added: 5, cost: null } // 无价 → 不成批次
  ]);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].batch_id, "cp-1");
  assert.equal(batches[0].energy_kwh, 10);
  assert.equal(batches[0].unit_price_cny_per_kwh, 1.5);
  assert.equal(batches[1].batch_id, "cp-2");
});

test("行程先耗尽批次再回落默认价（核心分摊语义）", () => {
  const batches = batchesFromChargingSessions([
    { id: 1, end_at: "2026-01-01 12:00", charge_energy_added: 10, cost: 15 } // 10 kWh @1.5
  ]);
  const { allocations, remaining_batches } = allocateDriveCosts({
    drives: [
      { id: 101, start_at: "2026-01-01 18:00", estimated_kwh: 8 },
      { id: 102, start_at: "2026-01-02 09:00", estimated_kwh: 6 }
    ],
    batches,
    defaultRate: 1.0
  });
  // 行程1 全部来自批次
  assert.equal(allocations[0].drive_id, 101);
  assert.equal(allocations[0].batch_kwh, 8);
  assert.equal(allocations[0].default_kwh, 0);
  assert.equal(allocations[0].cost_cny, 12.0); // 8×1.5
  // 行程2 只剩 2 kWh 批次，其余 4 kWh 默认价
  assert.equal(allocations[1].drive_id, 102);
  assert.equal(allocations[1].batch_kwh, 2);
  assert.equal(allocations[1].default_kwh, 4);
  assert.equal(allocations[1].cost_cny, 7.0); // 2×1.5 + 4×1.0
  assert.deepEqual(remaining_batches, [{ batch_id: "cp-1", remaining_kwh: 0 }]);
  // slices 记录来源
  assert.equal(allocations[1].slices[0].source, "batch");
  assert.equal(allocations[1].slices[1].source, "default");
});

test("批次未到期不可用（充电完成前的行程不吃该批次）", () => {
  const batches = batchesFromChargingSessions([
    { id: 1, end_at: "2026-01-05 12:00", charge_energy_added: 10, cost: 15 }
  ]);
  const { allocations } = allocateDriveCosts({
    drives: [{ id: 1, start_at: "2026-01-04 00:00", estimated_kwh: 5 }],
    batches,
    defaultRate: 2.0
  });
  assert.equal(allocations[0].batch_kwh, 0);
  assert.equal(allocations[0].default_kwh, 5);
  assert.equal(allocations[0].cost_cny, 10.0);
});

test("无默认价时剩余电量标记 unpriced，cost=null", () => {
  const { allocations } = allocateDriveCosts({
    drives: [{ id: 1, start_at: "2026-01-01 00:00", estimated_kwh: 5 }],
    batches: [],
    defaultRate: null
  });
  assert.equal(allocations[0].unpriced_kwh, 5);
  assert.equal(allocations[0].cost_cny, null);
  assert.equal(allocations[0].cost_complete, false);
});

test("默认价历史按变更时间生效（规则：变更只影响之后）", () => {
  const history = [
    { changedAt: "2026-01-01T00:00:00Z", from: 1.0, to: 1.2 },
    { changedAt: "2026-02-01T00:00:00Z", from: 1.2, to: 1.5 }
  ];
  const { allocations } = allocateDriveCosts({
    drives: [
      { id: 1, start_at: "2026-01-15T00:00:00Z", estimated_kwh: 10 },
      { id: 2, start_at: "2026-02-15T00:00:00Z", estimated_kwh: 10 }
    ],
    batches: [],
    defaultRate: 1.5,
    defaultRateHistory: history
  });
  assert.equal(allocations[0].cost_cny, 12.0); // 10 × 1.2
  assert.equal(allocations[1].cost_cny, 15.0); // 10 × 1.5
});

test("多批次顺序消耗（FIFO）", () => {
  const batches = batchesFromChargingSessions([
    { id: 1, end_at: "2026-01-01 12:00", charge_energy_added: 5, cost: 5 },   // @1.0
    { id: 2, end_at: "2026-01-02 12:00", charge_energy_added: 5, cost: 10 }  // @2.0
  ]);
  const { allocations } = allocateDriveCosts({
    drives: [{ id: 1, start_at: "2026-01-03 00:00", estimated_kwh: 7 }],
    batches,
    defaultRate: 3.0
  });
  const a = allocations[0];
  assert.equal(a.batch_kwh, 7);
  assert.equal(a.slices.length, 2); // 5@1.0 + 2@2.0
  assert.equal(a.cost_cny, 5 + 4);
  assert.equal(a.default_kwh, 0);
});

test("行程按时间排序计算，即使输入乱序", () => {
  const batches = batchesFromChargingSessions([
    { id: 1, end_at: "2026-01-01 12:00", charge_energy_added: 4, cost: 4 } // @1.0
  ]);
  const { allocations } = allocateDriveCosts({
    drives: [
      { id: "late", start_at: "2026-01-05 00:00", estimated_kwh: 4 },
      { id: "early", start_at: "2026-01-02 00:00", estimated_kwh: 4 }
    ],
    batches,
    defaultRate: 2.0
  });
  assert.equal(allocations[0].drive_id, "early");
  assert.equal(allocations[0].cost_cny, 4.0); // batch @1.0
  assert.equal(allocations[1].drive_id, "late");
  assert.equal(allocations[1].cost_cny, 8.0); // default @2.0
});

test("driveEnergyKwh: 理想里程×效率，rated 兜底", () => {
  assert.equal(driveEnergyKwh({ efficiency: 0.1274, ideal_used_km: 100, rated_used_km: 110 }), 12.74);
  assert.equal(driveEnergyKwh({ efficiency: 0.1274, ideal_used_km: null, rated_used_km: 100 }), 12.74);
  assert.equal(driveEnergyKwh({ efficiency: 150, ideal_used_km: 100 }), 15); // legacy Wh/km
  assert.equal(driveEnergyKwh({ efficiency: null, ideal_used_km: 100 }), null);
});

test("缺能量/缺时间的行程标记 allocation_reliable=false", () => {
  const { allocations } = allocateDriveCosts({
    drives: [
      { id: 1, start_at: "2026-01-01 00:00", estimated_kwh: null },
      { id: 2, estimated_kwh: 5 }
    ],
    batches: [],
    defaultRate: 1.0
  });
  assert.equal(allocations.every((a) => a.allocation_reliable === false), true);
  assert.equal(allocations.every((a) => a.cost_cny === null), true);
});

// ---- 账本闭合不变量与精度双轨（契约 v2 §8.2 / PRD §7.3） ----------------------

test("账本闭合：批次全耗尽时分摊电费总和 ≡ 实付总额（含充损折算单价）", () => {
  // 一次充电：电池净吸收 10 kWh，实付 30 元 → 折算单价 3.0 元/kWh（含充损）。
  const batches = batchesFromChargingSessions([
    { id: 1, end_at: "2026-01-01 12:00", charge_energy_added: 10, cost: 30 }
  ]);
  assert.equal(batches[0].unit_price_cny_per_kwh, 3.0);
  assert.equal(batches[0].amount_cny, 30);

  const { allocations, remaining_batches } = allocateDriveCosts({
    drives: [
      { id: 101, start_at: "2026-01-02 08:00", estimated_kwh: 6 },
      { id: 102, start_at: "2026-01-02 18:00", estimated_kwh: 4 }
    ],
    batches,
    defaultRate: 9.9 // 批次足额，默认价不得参与
  });

  const total = allocations.reduce((sum, a) => sum + a.cost_cny, 0);
  assert.equal(roundTo(total, 2), 30);           // 分摊总和 ≡ 实付总额
  assert.equal(allocations.every((a) => a.default_kwh === 0), true);
  assert.equal(allocations.every((a) => a.cost_complete === true), true);
  assert.deepEqual(remaining_batches, [{ batch_id: "cp-1", remaining_kwh: 0 }]);
});

test("精度双轨：cost_cny 展示 2 位，cost_cny_precise 保留内部高精度", () => {
  const { allocations } = allocateDriveCosts({
    drives: [{ id: 1, start_at: "2026-01-01 00:00", estimated_kwh: 1 }],
    batches: [],
    defaultRate: 0.123456789
  });
  assert.equal(allocations[0].cost_cny, 0.12);
  assert.equal(allocations[0].cost_cny_precise, 0.123456789);
});

test("未定价行程的 cost_cny 与 cost_cny_precise 同为 null", () => {
  const { allocations } = allocateDriveCosts({
    drives: [{ id: 1, start_at: "2026-01-01 00:00", estimated_kwh: 5 }],
    batches: [],
    defaultRate: null
  });
  assert.equal(allocations[0].cost_cny, null);
  assert.equal(allocations[0].cost_cny_precise, null);
  assert.equal(allocations[0].unpriced_kwh, 5);
});

// 本地四舍五入辅助（避免引入额外依赖）
function roundTo(value, digits) {
  return Number(Number(value).toFixed(digits));
}
