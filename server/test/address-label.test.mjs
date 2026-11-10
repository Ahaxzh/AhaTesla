import { test } from "node:test";
import assert from "node:assert/strict";
import { compressAddressParts, shortAddressLabel, shortRouteLabel } from "../src/core/address-label.mjs";

const A_FULL = "莲前街道, 前埔村, 思明区, 厦门市, 福建省, 360008, 中国";
const B_FULL = "后溪镇, 集美区, 厦门市, 福建省, 361021, 中国";

test("compressAddressParts：丢国家/邮编/省，保留具体段", () => {
  assert.deepEqual(compressAddressParts(A_FULL), ["莲前街道", "前埔村", "思明区", "厦门市"]);
  assert.deepEqual(compressAddressParts(B_FULL), ["后溪镇", "集美区", "厦门市"]);
});

test("shortRouteLabel：同城去重 + 每端 2 级（用户实测样例）", () => {
  assert.equal(shortRouteLabel(A_FULL, B_FULL), "莲前街道 前埔村 → 后溪镇 集美区");
});

test("shortRouteLabel：两端相同 → 往返", () => {
  assert.equal(shortRouteLabel(A_FULL, A_FULL), "莲前街道 前埔村（往返）"); // 同城去重后 2 级
});

test("shortRouteLabel：跨市保留城市段", () => {
  const a = "思明区, 厦门市, 福建省, 361000, 中国";
  const b = "鼓楼区, 福州市, 福建省, 350000, 中国";
  assert.equal(shortRouteLabel(a, b), "思明区 厦门市 → 鼓楼区 福州市");
});

test("shortAddressLabel：POI 首段保留，最多 3 级", () => {
  const poi = "厦门市图书馆集美新城馆, 杏林湾路, 官任, 杏林街道, 集美区, 厦门市, 福建省, 361021, 中国";
  assert.equal(shortAddressLabel(poi), "厦门市图书馆集美新城馆 杏林湾路 官任");
});

test("海外地址（无中国段）同样压缩邮编", () => {
  assert.deepEqual(compressAddressParts("Mission District, San Francisco, CA 94110, USA"), [
    "Mission District",
    "San Francisco",
    "CA 94110", // 非纯数字段（含州缩写）保守保留
    "USA",
  ]);
});

test("短串（geofence 名等）原样返回", () => {
  assert.equal(shortRouteLabel("家里", "公司"), "家里 → 公司");
  assert.equal(shortRouteLabel("家里", "家里"), "家里（往返）");
  assert.equal(shortAddressLabel(null), null);
  assert.equal(shortRouteLabel("未知", "未知"), "未知（往返）"); // routeKey 层对 未知/未知 有特判
});

test("shortRouteLabel：同区行程 → 区段也去重（用户实测 trips/3350）", () => {
  assert.equal(
    shortRouteLabel("后溪镇, 集美区, 厦门市, 福建省, 361021, 中国", "杏林街道, 集美区, 厦门市, 福建省, 361021, 中国"),
    "后溪镇 → 杏林街道",
  );
});
