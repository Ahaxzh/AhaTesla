// battery-health.test.mjs — 电池健康聚合纯函数(参考 TeslaMate BatteryHealthV2 思路重写)
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBatteryHealth } from "../src/core/battery-health.mjs";

const session = (i, added, sbl, ebl, range, end = `2026-0${(i % 9) + 1}-15 10:00`) => ({
  end_date: end,
  charge_energy_added: added,
  charge_energy_used: added * 1.08,
  start_battery_level: sbl,
  end_battery_level: ebl,
  start_rated_range_km: sbl * 4,
  end_rated_range_km: range,
  start_ideal_range_km: sbl * 4,
  end_ideal_range_km: range
});

test("样本不足(<5)→ insufficient,UI 隐藏", () => {
  const r = computeBatteryHealth([session(1, 40, 20, 100, 400), session(2, 30, 30, 90, 380)]);
  assert.equal(r.insufficient, true);
});

test("健康度 = 近期投影 ÷ 早期投影;容量取 P90;循环 = 总量 ÷ 容量", () => {
  const rows = [];
  // 早期 10 次: 满电 400km 投影 (end 100%, range 400)
  for (let i = 0; i < 10; i++) rows.push(session(i, 45, 10, 100, 400, `2024-0${(i % 9) + 1}-15 10:00`));
  // 近期 10 次: 满电 380km → 健康度 95%
  for (let i = 10; i < 20; i++) rows.push(session(i, 43, 10, 100, 380, `2026-0${(i % 9) + 1}-15 10:00`));
  const r = computeBatteryHealth(rows, { nowMs: Date.parse("2026-10-15T00:00:00Z") });
  assert.equal(r.insufficient, false);
  assert.ok(Math.abs(r.healthPct - 95) < 0.5, `healthPct=${r.healthPct}`);
  assert.equal(r.baselineMaxRangeKm, 400);
  assert.equal(r.currentMaxRangeKm, 380);
  // 容量: 100×45/90 = 50 kWh(每次 Δlevel=90)
  assert.equal(r.capacityKwh, 47.8); // 100×43/90
  // 循环 = (10×45 + 10×43) / 47.8 ≈ 18.4
  assert.ok(Math.abs(r.cycles - 18.4) < 0.6, `cycles=${r.cycles}`);
  // 充电效率 = added/used = 1/1.08 ≈ 92.6%
  assert.ok(Math.abs(r.rechargeEfficiency - 92.6) < 0.1);
  assert.ok(r.trend.length >= 2);
});

test("无效会话被过滤: 小于 10kWh / Δlevel<10 / 低电量结束投影", () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => session(i, 3, 50, 55, 220)),        // 能量太小
    ...Array.from({ length: 6 }, (_, i) => session(i + 10, 45, 95, 99, 396)),  // Δlevel=4
    ...Array.from({ length: 6 }, (_, i) => session(i + 20, 45, 10, 100, 400))  // 有效
  ];
  const r = computeBatteryHealth(rows);
  assert.equal(r.insufficient, false);
  assert.equal(r.baselineMaxRangeKm, 400);
});
