// ai-routes.mjs — BYO 模型配置端点（契约 §AI，m4c-c3）。
//   GET  /api/ai/config → {enabled, baseUrl, model, hasKey, keyAlias}（绝不回明文 key）
//   PUT  /api/ai/config {enabled, baseUrl, model, apiKey?} → {ok}（apiKey 省略=不变，空串=清除）
//   POST /api/ai/test   → {ok:true, preview} | {ok:false, error}
import { HttpError } from "./http-kit.mjs";

export function createAiRoutes({ ai, eventLog = null }) {
  return {
    async get(ctx) {
      return ai.getConfig();
    },

    async put(ctx) {
      const { enabled, baseUrl, model, apiKey } = ctx.body || {};
      if (typeof enabled !== "boolean") throw new HttpError(400, "bad_request", "enabled must be boolean");
      if (baseUrl !== undefined && typeof baseUrl !== "string") throw new HttpError(400, "bad_request", "baseUrl must be string");
      if (model !== undefined && typeof model !== "string") throw new HttpError(400, "bad_request", "model must be string");
      if (apiKey !== undefined && apiKey !== null && typeof apiKey !== "string") {
        throw new HttpError(400, "bad_request", "apiKey must be string");
      }
      const saved = ai.saveConfig({ enabled, baseUrl, model, apiKey: apiKey === null ? undefined : apiKey });
      // 事件日志不含 key 内容，只记形态
      eventLog?.log("ai.config_updated", { enabled: saved.enabled, hasKey: saved.hasKey, model: saved.model });
      return { ok: true };
    },

    async test(ctx) {
      const result = await ai.testConnection();
      // 契约：连通失败也回 200 + {ok:false, error}（前端 toast 展示 error）
      if (!result.ok) eventLog?.log("ai.test_failed", { reason: result.error });
      return result;
    }
  };
}
