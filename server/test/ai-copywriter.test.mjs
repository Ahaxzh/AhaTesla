// ai-copywriter（m4c-c3 BYO 模型）单元 + 路由测试。
import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/core/store.mjs";
import { createAiCopywriter } from "../src/core/ai-copywriter.mjs";
import { createAiRoutes } from "../src/api/ai-routes.mjs";
import { createNotifier, matrixFromRules } from "../src/core/push-channels.mjs";
import { loadSecretKey } from "../src/core/secret-box.mjs";

process.env.AHA_STATE_IN_MEMORY = "1";

function fakeCtx({ body = {} } = {}) {
  return { body, cookies: {}, headers: {}, req: { headers: {} }, setCookie() {}, res: { setHeader() {} } };
}

/** OpenAI 兼容假 fetch：可编排响应 / 模拟超时（永不 resolve，signal abort 时 reject） */
function fakeFetch({ status = 200, content = "低温天气能耗略高，属正常范围，续航无忧。", stall = false } = {}) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (stall) {
      return new Promise((_, reject) => {
        opts.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ choices: [{ message: { content } }] })
    };
  };
  impl.calls = calls;
  return impl;
}

function makeAi({ fetchImpl } = {}) {
  const store = openStore({ file: ":memory:" });
  const logs = [];
  const ai = createAiCopywriter({
    store,
    eventLog: { log: (type, detail) => logs.push({ type, detail }) },
    fetchImpl: fetchImpl ?? fakeFetch()
  });
  return { ai, store, logs };
}

function enabledAi({ fetchImpl } = {}) {
  const ctx = makeAi({ fetchImpl });
  ctx.ai.saveConfig({ enabled: true, baseUrl: "https://api.example.com/v1", model: "gpt-4o-mini", apiKey: "sk-test-1234567890" });
  return ctx;
}

test("AI 配置 CRUD：key 省略保持 / 空串清除 / GET 不回明文", () => {
  loadSecretKey();
  const { ai } = enabledAi();
  const cfg = ai.getConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.baseUrl, "https://api.example.com/v1");
  assert.equal(cfg.model, "gpt-4o-mini");
  assert.equal(cfg.hasKey, true);
  assert.match(cfg.keyAlias, /^[0-9a-f]{4}$/);
  // GET 输出绝不含明文 key 或密文
  assert.ok(!JSON.stringify(cfg).includes("sk-test"));
  assert.ok(!JSON.stringify(cfg).includes("v1:"));

  // 省略 apiKey = 保持不变
  ai.saveConfig({ enabled: false, baseUrl: "https://b.example.com", model: "m2" });
  const kept = ai.getConfig();
  assert.equal(kept.hasKey, true);
  assert.equal(kept.keyAlias, cfg.keyAlias);
  assert.equal(kept.enabled, false);

  // 空串 = 清除
  ai.saveConfig({ enabled: true, baseUrl: "https://b.example.com", model: "m2", apiKey: "" });
  const cleared = ai.getConfig();
  assert.equal(cleared.hasKey, false);
  assert.equal(cleared.keyAlias, null);
});

test("enhanceInsight：成功返回单行文案（换行压平 + 截断）", async () => {
  const fetchImpl = fakeFetch({ content: "第一行\n第二行超长".repeat(30) });
  const { ai } = enabledAi({ fetchImpl });
  const out = await ai.enhanceInsight("daily", { kpi: { distanceKm: 42.5 } });
  assert.ok(out);
  assert.ok(!out.includes("\n"));
  assert.ok(out.length <= 120);
  // 请求形态：baseUrl 归一补 /chat/completions + Bearer + system prompt
  const call = fetchImpl.calls[0];
  assert.equal(call.url, "https://api.example.com/v1/chat/completions");
  assert.equal(call.opts.headers.authorization, "Bearer sk-test-1234567890");
  const body = JSON.parse(call.opts.body);
  assert.equal(body.model, "gpt-4o-mini");
  assert.ok(body.messages[0].role === "system");
});

test("enhanceInsight：超时静默回退 null + warn（不含 key/prompt）", async () => {
  const { ai, logs } = enabledAi({ fetchImpl: fakeFetch({ stall: true }) });
  const t0 = Date.now();
  const out = await ai.enhanceInsight("weekly", { summary: "本期 300km" });
  assert.equal(out, null);
  assert.ok(Date.now() - t0 >= 7_500, "8s 超时生效");
  const warn = logs.find((l) => l.type === "ai.insight_fallback");
  assert.ok(warn, "记录 warn");
  assert.equal(warn.detail.reason, "timeout");
  assert.ok(!JSON.stringify(warn).includes("sk-test"), "warn 不含 key");
  assert.ok(!JSON.stringify(warn).includes("本期 300km"), "warn 不含 prompt 数据");
});

test("enhanceInsight：未启用 / 未配置 / 非 200 全部回退 null", async () => {
  const off = makeAi(); // 未配置
  assert.equal(await off.ai.enhanceInsight("daily", {}), null);

  const noKey = makeAi();
  noKey.ai.saveConfig({ enabled: true, baseUrl: "https://x.example.com", model: "m" }); // 无 key
  assert.equal(await noKey.ai.enhanceInsight("daily", {}), null);

  const bad = enabledAi({ fetchImpl: fakeFetch({ status: 500 }) });
  assert.equal(await bad.ai.enhanceInsight("monthly", {}), null);
  assert.equal(bad.logs.find((l) => l.type === "ai.insight_fallback")?.detail.reason, "http_500");
});

test("testConnection：成功 preview / 失败 error（契约 200 + ok:false）", async () => {
  const okCtx = enabledAi({ fetchImpl: fakeFetch({ content: "ok" }) });
  assert.deepEqual(await okCtx.ai.testConnection(), { ok: true, preview: "ok" });

  const failCtx = enabledAi({ fetchImpl: fakeFetch({ status: 401 }) });
  assert.deepEqual(await failCtx.ai.testConnection(), { ok: false, error: "http_401" });
});

test("路由：GET/PUT 校验 + PUT 不落 key 到事件日志", async () => {
  const { ai, logs } = enabledAi();
  const routes = createAiRoutes({ ai, eventLog: { log: (type, detail) => logs.push({ type, detail }) } });

  const got = await routes.get(fakeCtx());
  assert.equal(got.hasKey, true);
  assert.ok(!JSON.stringify(got).includes("sk-test"));

  const put = await routes.put(fakeCtx({ body: { enabled: true, baseUrl: "https://api.example.com/v1", model: "gpt-4o-mini" } }));
  assert.equal(put.ok, true);
  assert.equal(ai.getConfig().hasKey, true, "省略 apiKey 不清除");

  await assert.rejects(
    () => routes.put(fakeCtx({ body: { enabled: "yes" } })),
    /enabled must be boolean/
  );
  const logged = logs.find((l) => l.type === "ai.config_updated");
  assert.ok(!JSON.stringify(logged).includes("sk-test"), "事件日志无 key");
});

test("Notifier 集成：AI 启用时正文末尾追加 💡 行；禁用/失败时不追加", async () => {
  const fetchImpl = fakeFetch({ content: "本周低温续航略降，建议预热出发。" });
  const { ai } = enabledAi({ fetchImpl });
  const sent = [];
  const fakeChannel = { enabled: () => true, send: async (m) => { sent.push(m); return { sent: true }; } };
  const state = { pushRules: { matrix: { weekly: { feishu: true }, chargingStart: { feishu: true } } } };
  const notifier = createNotifier({ state, feishu: fakeChannel, ai });

  await notifier.dispatch({ type: "weekly", summary: "本期 300km · ¥45" });
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /本期 300km · ¥45\n💡 本周低温续航略降/);

  // 充电开始不在 AI_KINDS：不调用模型
  await notifier.dispatch({ type: "charging_start", locationName: "家" });
  assert.ok(!sent[1].body.includes("💡"));
  assert.equal(fetchImpl.calls.length, 1, "充电事件不消耗 AI 调用");

  // AI 失败静默回退：模板原样
  const failFetch = fakeFetch({ status: 500 });
  const failAi = enabledAi({ fetchImpl: failFetch }).ai;
  const notifier2 = createNotifier({ state, feishu: fakeChannel, ai: failAi });
  sent.length = 0;
  await notifier2.dispatch({ type: "weekly", summary: "模板正文" });
  assert.equal(sent[0].body, "模板正文", "失败时正文无 💡 且模板完整");

  // 未注入 ai：行为与旧版完全一致
  const notifier3 = createNotifier({ state, feishu: fakeChannel });
  sent.length = 0;
  await notifier3.dispatch({ type: "weekly", summary: "模板正文" });
  assert.equal(sent[0].body, "模板正文");
});
