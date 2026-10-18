// ai-copywriter.mjs — BYO 模型（OpenAI 兼容端点）接入推送文案润色（m4c-c3）。
//
// 设计原则：
//   - 默认关闭；未配置/未启用/任何失败（网络/超时/非 200/解析）一律静默回退 null，
//     推送正文完整性不依赖 AI（模板永远先行，AI 只在末尾追加一行「💡 …」）。
//   - apiKey 走 AES-256-GCM 落库（secret-box），对外只回显 hasKey + keyAlias
//     （sha256 指纹前 4 位，不泄露 key 内容）。
//   - 仅调用用户自配端点，无遥测；eventLog 记 warn 不含 key、不含完整 prompt。
import { createHash } from "node:crypto";
import { getStore } from "./state.mjs";
import { encryptSecret, decryptSecret } from "./secret-box.mjs";

const CHANNEL_ID = "ai";
const TIMEOUT_MS = 8_000;
const MAX_INSIGHT_CHARS = 120;

const SYSTEM_PROMPT = "你是特斯拉用车管家，根据数据写 1-2 句中文洞察，口吻懂车、具体、不套话，直接输出文案不要前缀";

/** 归一化 baseUrl：去尾斜杠；缺 /chat/completions 自动补（用户可只填根地址） */
function completionsUrl(baseUrl) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return null;
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

export function createAiCopywriter({ store = null, eventLog = null, fetchImpl = globalThis.fetch } = {}) {
  const db = () => store ?? getStore();

  // ---- 配置 CRUD（渠道表 CHANNEL_ID，config 明文 + secretEnc 密文） ----------------

  function readRaw() {
    const row = db().getChannel(CHANNEL_ID);
    return row ? { config: row.config || {}, secretEnc: row.secretEnc ?? null } : { config: {}, secretEnc: null };
  }

  function getConfig() {
    const { config, secretEnc } = readRaw();
    return {
      enabled: Boolean(config.enabled),
      baseUrl: String(config.baseUrl ?? ""),
      model: String(config.model ?? ""),
      hasKey: Boolean(secretEnc),
      keyAlias: config.keyAlias ?? null
    };
  }

  function saveConfig({ enabled, baseUrl, model, apiKey } = {}) {
    const cur = readRaw();
    const nextConfig = {
      ...cur.config,
      enabled: Boolean(enabled),
      baseUrl: String(baseUrl ?? cur.baseUrl ?? "").trim(),
      model: String(model ?? cur.model ?? "").trim(),
      keyAlias: cur.config.keyAlias ?? null
    };
    let secretEnc = cur.secretEnc;
    if (apiKey === "") {
      // 空串 = 清除
      secretEnc = null;
      nextConfig.keyAlias = null;
    } else if (typeof apiKey === "string" && apiKey.length > 0) {
      secretEnc = encryptSecret(apiKey);
      nextConfig.keyAlias = createHash("sha256").update(apiKey).digest("hex").slice(0, 4);
    }
    // apiKey 省略（undefined）= 保持不变
    db().putChannel(CHANNEL_ID, { config: nextConfig, secretEnc });
    // putChannel 的 upsert 用 coalesce 保留旧密文（护渠道密钥语义），显式清除需单独 UPDATE
    if (secretEnc === null) {
      db().db.prepare("UPDATE channel_secrets SET secret_enc=NULL WHERE channel=?").run(CHANNEL_ID);
    }
    return getConfig();
  }

  // ---- OpenAI 兼容调用 ------------------------------------------------------------

  async function chatCompletion({ messages, maxTokens }) {
    const { config, secretEnc } = readRaw();
    if (!config.enabled) return { ok: false, error: "disabled" };
    const url = completionsUrl(config.baseUrl);
    if (!url || !config.model) return { ok: false, error: "config_incomplete" };
    const apiKey = secretEnc ? decryptSecret(secretEnc) : null;
    if (!apiKey) return { ok: false, error: "no_api_key" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetchImpl(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.7
        })
      });
      if (!resp.ok) {
        return { ok: false, error: `http_${resp.status}` };
      }
      const data = await resp.json().catch(() => null);
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) {
        return { ok: false, error: "empty_completion" };
      }
      return { ok: true, text: text.trim() };
    } catch (error) {
      const reason = error?.name === "AbortError" ? "timeout" : "network_error";
      return { ok: false, error: reason };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 连通性测试：极短生成请求（契约 POST /api/ai/test） */
  async function testConnection() {
    const r = await chatCompletion({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: "连通性测试：请只回复「ok」" }
      ],
      maxTokens: 16
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, preview: r.text.slice(0, 120) };
  }

  /**
   * 文案润色：kind = daily|weekly|monthly|trip_end。
   * 成功返回截断后的文案字符串；任何失败返回 null（调用方什么都不加）。
   * data 为模板渲染用的原始事件对象（小体量 JSON）。
   */
  async function enhanceInsight(kind, data) {
    // 摘除无需送模型的字段（游标/内部 id），压缩 prompt
    const { segment_ids, driveIds, eventKey, ...payload } = data || {};
    const r = await chatCompletion({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ kind, ...payload }) }
      ],
      maxTokens: 160
    });
    if (!r.ok) {
      // 静默回退：只记 kind 与原因，绝不落 key / 完整 prompt
      eventLog?.log?.("ai.insight_fallback", { kind, reason: r.error });
      return null;
    }
    // 单行化（模型偶发换行），截断保上限
    return r.text.replace(/\s*\n+\s*/g, " ").slice(0, MAX_INSIGHT_CHARS);
  }

  return { getConfig, saveConfig, testConnection, enhanceInsight };
}
