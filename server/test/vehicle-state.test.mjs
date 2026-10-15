// vehicle-state.test.mjs — mapVehicleState 语义映射（states 在线性值 → 产品语义值域）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapVehicleState } from "../src/core/teslamate-queries.mjs";

test("states 在线性原始值归一为产品语义", () => {
  assert.equal(mapVehicleState("online"), "online");
  assert.equal(mapVehicleState("offline"), "offline");
  assert.equal(mapVehicleState("asleep"), "asleep");
});

test("未知原始值与空值归一为 asleep_or_parked", () => {
  assert.equal(mapVehicleState(null), "asleep_or_parked");
  assert.equal(mapVehicleState(undefined), "asleep_or_parked");
  assert.equal(mapVehicleState(""), "asleep_or_parked");
  assert.equal(mapVehicleState("driving"), "asleep_or_parked"); // states 表本无 driving 行；即便出现也不透传
  assert.equal(mapVehicleState("charging"), "asleep_or_parked"); // 充电态只能由 charging_processes 推导
  assert.equal(mapVehicleState("some_future_state"), "asleep_or_parked");
  assert.equal(mapVehicleState("  ONLINE  "), "online"); // 大小写/空白容错
});
