// channel-routes.mjs — 飞书渠道配置（六渠道中唯一需要服务端代持 appId/Secret
// 做长连接探测的渠道；其余渠道的配置端点在 push-routes.mjs）。
import { HttpError } from "./http-kit.mjs";
import { setFeishuConfig } from "../core/state.mjs";

export function createChannelRoutes({ state, feishu, eventLog }) {
  return {
    async updateFeishu(ctx) {
      const { enabled, appId, appSecret } = ctx.body || {};
      if (typeof enabled !== "boolean") throw new HttpError(400, "bad_request", "enabled must be boolean");
      if (appId !== undefined && typeof appId !== "string") throw new HttpError(400, "bad_request", "appId must be string");
      if (appSecret !== undefined && appSecret !== null && appSecret !== "" && typeof appSecret !== "string") {
        throw new HttpError(400, "bad_request", "appSecret must be string");
      }
      setFeishuConfig(state, { enabled, appId, appSecret: appSecret || undefined });
      eventLog?.log("channels.feishu_updated", { enabled });
      const status = await feishu.status();
      return { ok: true, connected: status.connected };
    },

    async testFeishu(ctx) {
      if (!feishu.enabled()) throw new HttpError(400, "channel_disabled", "feishu channel is not enabled/configured");
      const result = await feishu.sendTest();
      eventLog?.log("channels.feishu_test", { sent: result.sent });
      if (!result.sent) throw new HttpError(502, "channel_error", `feishu test failed: ${result.reason || "unknown"}`);
      return { ok: true, message: "测试卡片已发送" };
    }
  };
}
