// channels + push-rules routes.
import { HttpError } from "./http-kit.mjs";
import { setFeishuConfig, saveState } from "../core/state.mjs";

export function createChannelRoutes({ state, feishu, eventLog }) {
  return {
    async list(ctx) {
      const feishuStatus = await feishu.status();
      return { feishu: feishuStatus, web: { enabled: true } };
    },

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
    },

    async getPushRules(ctx) {
      return { ...state.pushRules };
    },

    async putPushRules(ctx) {
      const body = ctx.body || {};
      const allowed = ["tripEnd", "chargingStart", "chargingDone", "weeklyReport", "monthlyReport"];
      const update = {};
      for (const key of allowed) {
        if (body[key] !== undefined) {
          if (typeof body[key] !== "boolean") throw new HttpError(400, "bad_request", `${key} must be boolean`);
          update[key] = body[key];
        }
      }
      if (body.weeklyReportDay !== undefined) {
        const day = Number(body.weeklyReportDay);
        if (!Number.isInteger(day) || day < 1 || day > 7) {
          throw new HttpError(400, "bad_request", "weeklyReportDay must be integer 1-7");
        }
        update.weeklyReportDay = day;
      }
      Object.assign(state.pushRules, update);
      saveState(state);
      return { ...state.pushRules };
    }
  };
}
