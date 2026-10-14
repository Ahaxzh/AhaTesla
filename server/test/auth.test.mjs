// auth.test.mjs — scrypt hash roundtrip + hand-rolled HS256 JWT.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  hashPassword, verifyPassword, generateInitialPassword,
  signJwt, verifyJwt, TOKEN_TTL_S
} from "../src/api/auth.mjs";

test("password hash roundtrips and rejects wrong password", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("wrong", hash), false);
  assert.equal(await verifyPassword("correct horse battery stapl3", hash), false);
});

test("password hash is salted (different hashes for same password)", async () => {
  const a = await hashPassword("same-password");
  const b = await hashPassword("same-password");
  assert.notEqual(a, b);
});

test("verifyPassword tolerates garbage stored values", async () => {
  assert.equal(await verifyPassword("x", null), false);
  assert.equal(await verifyPassword("x", ""), false);
  assert.equal(await verifyPassword("x", "not-a-hash"), false);
  assert.equal(await verifyPassword("x", "bcrypt$foo$bar$baz"), false);
});

test("initial password is readable and reasonably strong", () => {
  const pwd = generateInitialPassword();
  assert.match(pwd, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.equal(pwd.length, 19);
});

test("JWT sign/verify roundtrip", () => {
  const secret = randomBytes(32);
  const token = signJwt({ sub: "admin" }, secret);
  const payload = verifyJwt(token, secret);
  assert.equal(payload.sub, "admin");
  assert.equal(typeof payload.iat, "number");
  assert.equal(payload.exp - payload.iat, TOKEN_TTL_S);
});

test("JWT rejects wrong secret / tampering / expiry / bad alg", () => {
  const secret = randomBytes(32);
  const token = signJwt({ sub: "admin" }, secret);
  assert.equal(verifyJwt(token, randomBytes(32)), null);
  const [h, p, s] = token.split(".");
  assert.equal(verifyJwt(`${h}.${p}.${s.slice(0, -2)}aa`, secret), null);
  // expired
  const old = signJwt({ sub: "admin" }, secret, { ttlS: -10 });
  assert.equal(verifyJwt(old, secret), null);
  // alg confusion: none
  const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  assert.equal(verifyJwt(`${noneHeader}.${p}.`, secret), null);
});

test("JWT expired token rejected via now override", () => {
  const secret = randomBytes(32);
  const token = signJwt({ sub: "admin" }, secret, { ttlS: 60 });
  assert.equal(verifyJwt(token, secret, { now: Date.now() + 120_000 }), null);
  assert.ok(verifyJwt(token, secret, { now: Date.now() }));
});
