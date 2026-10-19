// geo-geocode.test.mjs — 可选高德逆地理:坐标纠偏/缓存/开关/标签链接入
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryStore } from "../src/core/state.mjs";
import { openStore } from "../src/core/store.mjs";
import { wgs84ToGcj02, resolveAmapLabel, saveGeocodingConfig, getGeocodingConfig } from "../src/core/geo-geocode.mjs";

beforeEach(() => {
  useMemoryStore();
  openStore({ file: ":memory:" });
});

test("WGS84→GCJ02:厦门山姆点在国境内偏移 ~200-600m,境外原样返回", () => {
  const { lat, lng } = wgs84ToGcj02(24.509, 118.087);
  const dLatM = Math.abs(lat - 24.509) * 111_320;
  const dLngM = Math.abs(lng - 118.087) * 111_320 * Math.cos(24.5 * Math.PI / 180);
  assert.ok(dLatM > 50 && dLatM < 1000, `纬向偏移异常: ${dLatM.toFixed(0)}m`);
  assert.ok(dLngM > 50 && dLngM < 1000, `经向偏移异常: ${dLngM.toFixed(0)}m`);
  const out = wgs84ToGcj02(40.7128, -74.006); // 纽约
  assert.equal(out.lat, 40.7128);
  assert.equal(out.lng, -74.006);
});

test("默认关闭:未启用/无 Key 时解析恒为 null 且零网络调用", async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; throw new Error("should not call"); };
  assert.equal(await resolveAmapLabel(24.5, 118.1, { fetchImpl }), null);
  saveGeocodingConfig({ enabled: true }); // 无 Key
  assert.equal(await resolveAmapLabel(24.5, 118.1, { fetchImpl }), null);
  assert.equal(called, 0);
});

test("开启+Key:POI 名优先,结果与'无结果'都落缓存(第二次零网络)", async () => {
  saveGeocodingConfig({ enabled: true, amapKey: "test-key-1234567890" });
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (String(url).includes("118.0919")) { // 实测纠偏:点1→(118.091979,24.506348),点2→(118.104983,…)
      return { json: async () => ({ status: "1", regeocode: { pois: [{ name: "山姆会员商店(厦门)" }], formatted_address: "福建省厦门市湖里区象屿保税区" } }) };
    }
    return { json: async () => ({ status: "1", regeocode: { pois: [], formatted_address: "" } }) };
  };
  const name = await resolveAmapLabel(24.509, 118.087, { fetchImpl });
  assert.equal(name, "山姆会员商店(厦门)");
  assert.equal(calls, 1);
  // 缓存命中
  assert.equal(await resolveAmapLabel(24.509, 118.08704, { fetchImpl }), "山姆会员商店(厦门)"); // 同 11m 网格(118.0870)
  assert.equal(calls, 1);
  // 无 POI → formatted_address 尾段;无结果 → null 且缓存
  const addr = await resolveAmapLabel(24.60, 118.10, { fetchImpl });
  assert.equal(addr, null);
  assert.equal(calls, 2); // 两个新网格各一次
  assert.equal(await resolveAmapLabel(24.60004, 118.10, { fetchImpl }), null); // 同网格 24.6000
  assert.equal(calls, 2);
});

test("网络错误不缓存,下次重试;接口失败(status!=1)返回 null", async () => {
  saveGeocodingConfig({ enabled: true, amapKey: "test-key-1234567890" });
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("network down"); };
  assert.equal(await resolveAmapLabel(24.3, 118.2, { fetchImpl }), null);
  assert.equal(await resolveAmapLabel(24.3, 118.2, { fetchImpl }), null);
  assert.equal(calls, 2, "错误不应缓存");
  const bad = async () => ({ json: async () => ({ status: "0", info: "INVALID_KEY" }) });
  assert.equal(await resolveAmapLabel(24.31, 118.21, { fetchImpl: bad }), null);
});

test("配置:Key 密文落库只回 hasKey/alias;空串清除", () => {
  const cfg = saveGeocodingConfig({ enabled: true, amapKey: "amap-key-abcdef123456" });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.hasKey, true);
  assert.ok(/^[0-9a-f]{4}$/.test(cfg.keyAlias));
  // 未带 amapKey 的保存不丢 Key
  const keep = saveGeocodingConfig({ enabled: false });
  assert.equal(keep.hasKey, true);
  // 空串清除
  const cleared = saveGeocodingConfig({ enabled: false, amapKey: "" });
  assert.equal(cleared.hasKey, false);
  assert.equal(cleared.keyAlias, null);
});
