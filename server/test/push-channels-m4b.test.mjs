// push-channels-m4b.test.mjs — m4b 三新渠道（企业微信/ntfy/Bark）单元与路由测试。
// mock fetchImpl 断言请求形态（URL/headers/body）、disabled 不发、失败隔离、密钥加密回显别名。
import { test } from "node:test";
import assert from "node:assert/strict";
import { useMemoryStore } from "../src/core/state.mjs";
import {
  createWecomChannel, createNtfyChannel, createBarkChannel,
  createNotifier, saveChannelConfig, loadChannelConfig,
  matrixFromRules, defaultMatrix, PUSH_CHANNELS, PUSH_EVENTS
} from "../src/core/push-channels.mjs";

process.env.AHA_STATE_IN_MEMORY = "1";

function recordFetch(reply, calls = []) {
  return {
    calls,
    impl: async (url, init = {}) => {
      let body = init.body;
      if (typeof body === "string" && body.trimStart().startsWith("{")) {
        try { body = JSON.parse(body); } catch { /* 纯文本 body 保持原样 */ }
      }
      calls.push({ url, method: init.method, headers: init.headers || {}, body, signal: init.signal });
      const r = typeof reply === "function" ? reply(url, init) : reply;
      return {
        ok: r.ok ?? true,
        status: r.status ?? 200,
        json: async () => r.data ?? {}
      };
    }
  };
}

test("企业微信：disabled 不发；配置后 markdown 卡片形态正确；errcode 非 0 失败", async () => {
  useMemoryStore();
  const { impl, calls } = recordFetch({ data: { errcode: 0, errmsg: "ok" } });
  const ch = createWecomChannel({ fetchImpl: impl });

  assert.equal(ch.enabled(), false);
  assert.equal((await ch.send({ title: "t", body: "b" })).sent, false);
  assert.equal(calls.length, 0);

  saveChannelConfig("wecom", { config: { enabled: true, webhookKeyAlias: "6a71b2c3…" }, secret: "webhook-key-1" });
  const ok = await ch.send({ title: "行程结束", body: "42.5 km" });
  assert.equal(ok.sent, true);
  const c = calls.at(-1);
  assert.match(c.url, /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=webhook-key-1$/);
  assert.equal(c.body.msgtype, "markdown");
  assert.match(c.body.markdown.content, /\*\*行程结束\*\*/);
  assert.match(c.body.markdown.content, /42\.5 km/);
  assert.ok(c.signal, "请求应带超时 signal");

  // errcode != 0 → sent false（如 key 失效）
  const bad = createWecomChannel({ fetchImpl: recordFetch({ data: { errcode: 93000, errmsg: "invalid webhook url" } }).impl });
  const r2 = await bad.send({ title: "t", body: "b" });
  assert.equal(r2.sent, false);
  assert.match(r2.reason, /93000/);
});

test("ntfy：Title/Click 头 + topic 编码；自建 serverUrl 生效；非 2xx 失败", async () => {
  useMemoryStore();
  const { impl, calls } = recordFetch({ ok: true, status: 200 });
  const ch = createNtfyChannel({ fetchImpl: impl });

  assert.equal(ch.enabled(), false);
  await ch.send({ title: "t", body: "b" });

  saveChannelConfig("ntfy", { config: { enabled: true, topic: "ahatesla/我的车" } });
  const ok = await ch.send({ title: "昨日用车日报 · 10-17", body: "42.5 km", url: "/reports" });
  assert.equal(ok.sent, true);
  let c = calls.at(-1);
  assert.equal(c.url, "https://ntfy.sh/ahatesla%2F%E6%88%91%E7%9A%84%E8%BD%A6");
  assert.equal(c.headers.Title, "昨日用车日报 · 10-17");
  assert.equal(c.headers.Click, "/reports");
  assert.match(c.body, /42\.5 km/);

  // 自建 server（末尾斜杠应被剥掉）
  saveChannelConfig("ntfy", { config: { enabled: true, topic: "aha", serverUrl: "https://ntfy.example.com/" } });
  await ch.send({ title: "t", body: "b" });
  assert.equal(calls.at(-1).url, "https://ntfy.example.com/aha");

  // 非 2xx
  const bad = createNtfyChannel({ fetchImpl: recordFetch({ ok: false, status: 404 }).impl });
  await saveChannelConfig("ntfy", { config: { enabled: true, topic: "aha" } });
  const r2 = await bad.send({ title: "t", body: "b" });
  assert.equal(r2.sent, false);
  assert.match(r2.reason, /404/);
});

test("Bark：deviceKey 路径 + JSON body group；默认/自建 server；code!=200 失败", async () => {
  useMemoryStore();
  const { impl, calls } = recordFetch({ ok: true, status: 200, data: { code: 200, message: "success" } });
  const ch = createBarkChannel({ fetchImpl: impl });

  assert.equal(ch.enabled(), false);

  saveChannelConfig("bark", { config: { enabled: true, deviceKeyAlias: "abcd12…" }, secret: "device-key-9" });
  const ok = await ch.send({ title: "充电完成", body: "41.2 kWh" });
  assert.equal(ok.sent, true);
  const c = calls.at(-1);
  assert.equal(c.url, "https://api.day.app/device-key-9");
  assert.equal(c.body.title, "充电完成");
  assert.equal(c.body.body, "41.2 kWh");
  assert.equal(c.body.group, "AhaTesla");
  assert.ok(c.signal);

  // 自建 server
  saveChannelConfig("bark", { config: { enabled: true, serverUrl: "https://bark.example.com" } }); // deviceKey 保留旧密文
  await ch.send({ title: "t", body: "b" });
  assert.equal(calls.at(-1).url, "https://bark.example.com/device-key-9");

  // code != 200
  const bad = createBarkChannel({ fetchImpl: recordFetch({ ok: true, status: 200, data: { code: 400, message: "bad key" } }).impl });
  const r2 = await bad.send({ title: "t", body: "b" });
  assert.equal(r2.sent, false);
});

test("三渠道 fetch 异常（网络/超时）静默失败不抛", async () => {
  useMemoryStore();
  const boom = async () => { throw new Error("aborted"); };
  for (const [factory, id, cfg] of [
    [createWecomChannel, "wecom", { enabled: true, webhookKeyAlias: "x" }],
    [createNtfyChannel, "ntfy", { enabled: true, topic: "t" }],
    [createBarkChannel, "bark", { enabled: true, deviceKeyAlias: "x" }]
  ]) {
    saveChannelConfig(id, { config: cfg, ...(id !== "ntfy" ? { secret: "s" } : {}) });
    const ch = factory({ fetchImpl: boom });
    const r = await ch.send({ title: "t", body: "b" });
    assert.equal(r.sent, false, `${id} 网络异常应 sent=false`);
    assert.equal(r.reason, "network_error");
  }
});

test("dispatch：企微失败不阻塞 ntfy 投递（失败隔离，AC-12.2）", async () => {
  useMemoryStore();
  const badWecom = createWecomChannel({ fetchImpl: async () => { throw new Error("dns fail"); } });
  const goodNtfy = createNtfyChannel({ fetchImpl: recordFetch({ ok: true, status: 200 }).impl });
  const state = { pushRules: { matrix: { tripEnd: { wecom: true, ntfy: true } } } };
  const notifier = createNotifier({ state, wecom: badWecom, ntfy: goodNtfy, webpush: null });
  saveChannelConfig("wecom", { config: { enabled: true, webhookKeyAlias: "x" }, secret: "k" });
  saveChannelConfig("ntfy", { config: { enabled: true, topic: "aha" } });
  const { results } = await notifier.dispatch({ type: "trip_end", distanceKm: 10 });
  assert.equal(results.wecom.sent, false);
  assert.equal(results.ntfy.sent, true);
});

test("矩阵 9×6：内容事件新渠道全关、告警事件即时渠道全开；PUT 归一化布尔；常量一致(P2)", () => {
  useMemoryStore();
  assert.equal(PUSH_CHANNELS.length, 6);
  assert.equal(PUSH_EVENTS.length, 9);
  const ALARMS = new Set(["outage", "chargeInterrupt", "tirePressure"]);
  const dm = defaultMatrix();
  for (const ev of PUSH_EVENTS) {
    assert.deepEqual(Object.keys(dm[ev]).sort(), [...PUSH_CHANNELS].sort(), `${ev} 行应含六渠道`);
    assert.equal(dm[ev].feishu, true, "全事件飞书默认开");
    assert.equal(dm[ev].wecom, false, "m4b 语义：wecom 默认关");
    if (ALARMS.has(ev)) {
      assert.equal(dm[ev].webpush, true, `${ev} 告警默认即时渠道开`);
      assert.equal(dm[ev].telegram, true);
    }
  }
  // 缺失渠道补 false，多余键剥离（matrixFromRules 只保留六渠道）
  const rt = matrixFromRules({ matrix: { daily: { wecom: true, ntfy: 1, hack: true } } });
  assert.equal(rt.daily.wecom, true);
  assert.equal(rt.daily.ntfy, false, "非布尔归一为 false");
  assert.equal("hack" in rt.daily, false, "未知渠道键剔除");
});

test("配置 CRUD：webhookKey/deviceKey 密文落库回显别名，明文不回传", async () => {
  useMemoryStore();
  saveChannelConfig("wecom", { config: { enabled: true, webhookKeyAlias: "aaaabbbb…" }, secret: "real-webhook-key" });
  const wecom = createWecomChannel({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ errcode: 0 }) }) });
  const st = await wecom.status();
  assert.equal(st.enabled, true);
  assert.equal(st.webhookKeyAlias, "aaaabbbb…");
  assert.equal(JSON.stringify(st).includes("real-webhook-key"), false, "status 不得回传明文 key");
  // 密钥省略不清除；空串清除
  saveChannelConfig("wecom", { config: { enabled: true } });
  assert.equal(loadChannelConfig("wecom").secret, "real-webhook-key");
  saveChannelConfig("wecom", { secret: "" });
  assert.equal(loadChannelConfig("wecom").secret, null);
});
