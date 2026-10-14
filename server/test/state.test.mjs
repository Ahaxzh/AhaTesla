// secret-box + state persistence tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret, loadSecretKey } from "../src/core/secret-box.mjs";
import { loadState, saveState, setDefaultRate, setFeishuConfig, getFeishuSecret, DEFAULT_STATE } from "../src/core/state.mjs";

test("secret box roundtrip", () => {
  const enc = encryptSecret("my-feishu-secret");
  assert.notEqual(enc, "my-feishu-secret");
  assert.match(enc, /^v1:/);
  assert.equal(decryptSecret(enc), "my-feishu-secret");
});

test("secret box rejects tampered ciphertext", () => {
  const enc = encryptSecret("my-feishu-secret");
  const parts = enc.split(":");
  const data = Buffer.from(parts[3], "base64url");
  data[0] ^= 0xff;
  parts[3] = data.toString("base64url");
  assert.equal(decryptSecret(parts.join(":")), null);
});

test("state roundtrip with defaults merged", () => {
  const state = loadState();
  assert.equal(state.username, "admin");
  assert.equal(typeof state.pricing.defaultRateCnyPerKwh, "number");
  state.pricing.defaultRateCnyPerKwh = 1.2;
  state.passwordHash = "scrypt$x$y$z";
  saveState(state);
  const reloaded = loadState();
  assert.equal(reloaded.pricing.defaultRateCnyPerKwh, 1.2);
  assert.equal(reloaded.passwordHash, "scrypt$x$y$z");
  // restore
  const fresh = structuredClone(DEFAULT_STATE);
  saveState(fresh);
});

test("setDefaultRate records history", () => {
  const state = loadState();
  const before = state.pricing.defaultRateCnyPerKwh;
  const changed = setDefaultRate(state, 1.5, "test");
  assert.equal(changed, true);
  assert.equal(state.pricing.defaultRateCnyPerKwh, 1.5);
  assert.equal(state.pricing.history.length, 1);
  assert.equal(state.pricing.history[0].from, before);
  assert.equal(state.pricing.history[0].to, 1.5);
  assert.equal(state.pricing.history[0].source, "test");
  // no-op change
  assert.equal(setDefaultRate(state, 1.5), false);
  // restore
  saveState(structuredClone(DEFAULT_STATE));
});

test("feishu secret stored encrypted, never plaintext", () => {
  const state = loadState();
  setFeishuConfig(state, { enabled: true, appId: "cli_x", appSecret: "super-secret-value" });
  assert.match(state.feishu.appSecretEnc, /^v1:/);
  assert.ok(!JSON.stringify(state).includes("super-secret-value"));
  assert.equal(getFeishuSecret(state), "super-secret-value");
  saveState(structuredClone(DEFAULT_STATE));
});
