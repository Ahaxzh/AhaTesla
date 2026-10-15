// push-routes.mjs — 渠道配置 / Web Push 订阅 / 推送矩阵 / 报告（契约 §6）。
//
// 三渠道平权（AC-10.1）：webpush/telegram/feishu 配置 + 一键测试（AC-10.2）。
// 矩阵（B4）：5 事件 × 3 渠道，替换 v1 每事件单 bool。
// 报告（GA-11/18）：列表/详情/手动生成。
import { HttpError } from "./http-kit.mjs";
import { saveChannelConfig, loadChannelConfig, PUSH_EVENTS, PUSH_CHANNELS } from "../core/push-channels.mjs";
import { buildReport, startReportScheduler } from "../core/report-engine.mjs";
import { saveState } from "../core/state.mjs";
import { randomBytes } from "node:crypto";

export function createPushRoutes({ state, notifier, eventLog, store, reportScheduler, buildDeps }) {
  const channelsApi = () => notifier.channels;

  return {
    // ---- 渠道状态 ---------------------------------------------------------
    async listChannels(ctx) {
      const [feishu, telegram, webpush] = await Promise.all([
        channelsApi().feishu.status(),
        channelsApi().telegram.status(),
        channelsApi().webpush.status()
      ]);
      return { feishu, telegram, webpush };
    },

    // ---- Web Push ---------------------------------------------------------
    async getPushEnv(ctx) {
      // 匿名（在 index 注册处不加 requireAuth）；HTTPS 判定 + VAPID 公钥
      const https = ctx.req?.headers?.["x-forwarded-proto"] === "https"
        || String(ctx.req?.socket?.encrypted ?? "") === "true";
      return { https, vapidPublicKey: channelsApi().webpush.vapidPublicKey() };
    },

    async webpushSubscribe(ctx) {
      const { endpoint, keys } = ctx.body || {};
      if (!endpoint || typeof endpoint !== "string" || !keys?.p256dh || !keys?.auth) {
        throw new HttpError(400, "bad_request", "endpoint and keys {p256dh, auth} required");
      }
      channelsApi().webpush.addSubscription({ endpoint, keys });
      eventLog?.log("push.webpush_subscribed", {});
      return { ok: true };
    },

    async webpushUnsubscribe(ctx) {
      const { endpoint } = ctx.body || {};
      if (!endpoint) throw new HttpError(400, "bad_request", "endpoint required");
      channelsApi().webpush.removeSubscription({ endpoint });
      return { ok: true };
    },

    async webpushTest(ctx) {
      const r = await channelsApi().webpush.test();
      eventLog?.log("push.webpush_test", { sent: r.sent });
      if (!r.sent) throw new HttpError(502, "channel_error", `webpush test failed: ${r.reason || "unknown"}`);
      return { ok: true };
    },

    async webpushInitVapid(ctx) {
      // 首次开启 Web Push：生成 VAPID 密钥对（私钥加密落库，公钥回传一次）
      const cur = loadChannelConfig("webpush");
      if (cur.config?.vapid?.publicKey && cur.config?.vapid?.privateKey) {
        return { ok: true, publicKey: cur.config.vapid.publicKey, created: false };
      }
      let kp;
      try {
        const wp = globalThis.__ahatesla_webpush ?? require("web-push");
        kp = wp.generateVAPIDKeys();
      } catch (error) {
        throw new HttpError(500, "internal", `web-push unavailable: ${error.message}`);
      }
      saveChannelConfig("webpush", {
        config: { vapid: { publicKey: kp.publicKey, privateKey: kp.privateKey } }
      });
      eventLog?.log("push.vapid_generated", {});
      return { ok: true, publicKey: kp.publicKey, created: true };
    },

    // ---- Telegram ----------------------------------------------------------
    async updateTelegram(ctx) {
      const { botToken, chatId, enabled } = ctx.body || {};
      if (botToken !== undefined && botToken !== null && botToken !== "" && typeof botToken !== "string") {
        throw new HttpError(400, "bad_request", "botToken must be string");
      }
      if (chatId !== undefined && chatId !== null && chatId !== "" && typeof chatId !== "string") {
        throw new HttpError(400, "bad_request", "chatId must be string");
      }
      const config = {};
      if (enabled !== undefined) config.enabled = Boolean(enabled);
      if (chatId) config.chatId = String(chatId);
      // 别名用于回显（不回传明文 token）
      if (botToken) config.botTokenAlias = `${String(botToken).slice(0, 8)}…`;
      if (chatId) config.chatIdAlias = `${String(chatId).slice(0, 6)}…`;
      saveChannelConfig("telegram", { config, secret: botToken || undefined });
      eventLog?.log("channels.telegram_updated", { enabled: config.enabled });
      const status = await channelsApi().telegram.status();
      return { ok: true, connected: status.connected };
    },

    async testTelegram(ctx) {
      const r = await channelsApi().telegram.test();
      eventLog?.log("channels.telegram_test", { sent: r.sent });
      if (!r.sent) throw new HttpError(502, "channel_error", `telegram test failed: ${r.reason || "unknown"}`);
      return { ok: true };
    },

    // ---- 飞书（保留既有 state 直连实现） ------------------------------------
    async updateFeishu(ctx) {
      return channelsApi().feishu === notifier.channels.feishu
        ? notifier.channels.feishu.updateConfig?.(ctx)
        : undefined;
    },

    // ---- 推送矩阵（B4） ------------------------------------------------------
    async getPushRules(ctx) {
      const matrix = notifier.matrix();
      return { matrix, weeklyReportDay: state.pushRules.weeklyReportDay ?? 1 };
    },

    async putPushRules(ctx) {
      const body = ctx.body || {};
      if (body.matrix !== undefined) {
        if (typeof body.matrix !== "object" || body.matrix === null) {
          throw new HttpError(400, "bad_request", "matrix must be an object");
        }
        const clean = {};
        for (const ev of PUSH_EVENTS) {
          const row = body.matrix[ev];
          clean[ev] = {};
          for (const ch of PUSH_CHANNELS) {
            if (row?.[ch] !== undefined && typeof row[ch] !== "boolean") {
              throw new HttpError(400, "bad_request", `matrix.${ev}.${ch} must be boolean`);
            }
            clean[ev][ch] = Boolean(row?.[ch]);
          }
        }
        state.pushRules.matrix = clean;
      }
      if (body.weeklyReportDay !== undefined) {
        const day = Number(body.weeklyReportDay);
        if (!Number.isInteger(day) || day < 1 || day > 7) {
          throw new HttpError(400, "bad_request", "weeklyReportDay must be integer 1-7");
        }
        state.pushRules.weeklyReportDay = day;
      }
      saveState(state);
      return { matrix: notifier.matrix(), weeklyReportDay: state.pushRules.weeklyReportDay };
    },

    // ---- 报告（GA-11/18） -----------------------------------------------------
    async listReports(ctx) {
      const limit = Math.max(1, Math.min(100, Number(ctx.query.limit) || 50));
      const weekly = store.listReportSnapshots("weekly", limit);
      const monthly = store.listReportSnapshots("monthly", limit);
      const toRow = (r) => ({
        id: r.id,
        type: r.kind,
        periodLabel: r.payload?.periodLabel || `${r.periodStart?.slice(0, 10)} ~ ${r.periodEnd?.slice(0, 10)}`,
        distanceKm: r.payload?.kpi?.distanceKm ?? null,
        totalCost: r.payload?.kpi?.totalCost ?? null,
        saved: r.payload?.kpi?.saved ?? null,
        createdAt: r.createdAt
      });
      return { items: [...monthly, ...weekly].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(toRow) };
    },

    async reportDetail(ctx) {
      const id = Number(ctx.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "bad_request", "invalid report id");
      const all = [...store.listReportSnapshots("weekly", 500), ...store.listReportSnapshots("monthly", 500)];
      const hit = all.find((r) => r.id === id);
      if (!hit) throw new HttpError(404, "not_found", "report not found");
      return { id: hit.id, type: hit.kind, createdAt: hit.createdAt, ...hit.payload };
    },

    async generateReport(ctx) {
      const type = ctx.body?.type === "monthly" ? "monthly" : "weekly";
      if (!reportScheduler) throw new HttpError(500, "internal", "report engine unavailable");
      const result = await reportScheduler.runKind(type);
      if (!result) throw new HttpError(500, "internal", "report generation failed");
      return { ok: true, id: result.id };
    }
  };
}
