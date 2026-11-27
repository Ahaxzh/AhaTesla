// push-routes.mjs — 渠道配置 / Web Push 订阅 / 推送矩阵 / 报告（契约 §6）。
//
// 三渠道平权（AC-10.1）：webpush/telegram/feishu 配置 + 一键测试（AC-10.2）。
// 矩阵（B4）：5 事件 × 3 渠道，替换 v1 每事件单 bool。
// 报告（GA-11/18）：列表/详情/手动生成。
import { HttpError } from "./http-kit.mjs";
import { saveChannelConfig, loadChannelConfig, PUSH_EVENTS, PUSH_CHANNELS, matrixFromRules } from "../core/push-channels.mjs";
import { setFeishuConfig } from "../core/state.mjs";
import { buildReport, startReportScheduler } from "../core/report-engine.mjs";
import { saveState } from "../core/state.mjs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

// ESM 下 require 未定义（此前 init-vapid 在"全新实例零订阅"时必炸 ReferenceError
// —— ensureVapid 因无订阅短路，globalThis 缓存从未被填充，形成鸡生蛋死锁）
const nodeRequire = createRequire(import.meta.url);

export function createPushRoutes({ state, notifier, eventLog, store, reportScheduler, buildDeps }) {
  const channelsApi = () => notifier.channels;

  return {
    // ---- 渠道状态 ---------------------------------------------------------
    async listChannels(ctx) {
      const entries = Object.entries(channelsApi());
      const list = await Promise.all(entries.map(([, ch]) => ch.status()));
      return Object.fromEntries(entries.map(([id], i) => [id, list[i]]));
    },

    // ---- 飞书渠道配置（自 channel-routes.mjs 并入：六渠道配置一处一域） ------
    async updateFeishu(ctx) {
      const feishu = channelsApi().feishu;
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
      const feishu = channelsApi().feishu;
      if (!feishu.enabled()) throw new HttpError(400, "channel_disabled", "feishu channel is not enabled/configured");
      const result = await feishu.sendTest();
      eventLog?.log("channels.feishu_test", { sent: result.sent });
      if (!result.sent) throw new HttpError(502, "channel_error", `feishu test failed: ${result.reason || "unknown"}`);
      return { ok: true, message: "测试卡片已发送" };
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
        const wp = globalThis.__ahatesla_webpush
          ?? (globalThis.__ahatesla_webpush = nodeRequire("web-push"));
        kp = wp.generateVAPIDKeys();
      } catch (error) {
        throw new HttpError(500, "internal", "web-push unavailable");
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

    // ---- 企业微信（m4b） -----------------------------------------------------
    async updateWecom(ctx) {
      const { enabled, webhookKey } = ctx.body || {};
      if (webhookKey !== undefined && webhookKey !== null && webhookKey !== "" && typeof webhookKey !== "string") {
        throw new HttpError(400, "bad_request", "webhookKey must be string");
      }
      const config = {};
      if (enabled !== undefined) config.enabled = Boolean(enabled);
      if (webhookKey) config.webhookKeyAlias = `${String(webhookKey).slice(0, 8)}…`;
      saveChannelConfig("wecom", { config, secret: webhookKey || undefined });
      eventLog?.log("channels.wecom_updated", { enabled: config.enabled });
      const status = await channelsApi().wecom.status();
      return { ok: true, connected: status.connected };
    },

    async testWecom(ctx) {
      const r = await channelsApi().wecom.test();
      eventLog?.log("channels.wecom_test", { sent: r.sent });
      if (!r.sent) throw new HttpError(502, "channel_error", `wecom test failed: ${r.reason || "unknown"}`);
      return { ok: true };
    },

    // ---- ntfy（m4b；无密钥，serverUrl 可自建） -------------------------------
    async updateNtfy(ctx) {
      const { enabled, serverUrl, topic } = ctx.body || {};
      if (topic !== undefined && topic !== null && topic !== "" && typeof topic !== "string") {
        throw new HttpError(400, "bad_request", "topic must be string");
      }
      if (serverUrl !== undefined && serverUrl !== null && serverUrl !== "" && typeof serverUrl !== "string") {
        throw new HttpError(400, "bad_request", "serverUrl must be string");
      }
      if (serverUrl && !/^https?:\/\//.test(serverUrl)) {
        throw new HttpError(400, "bad_request", "serverUrl must be http(s) URL");
      }
      const config = {};
      if (enabled !== undefined) config.enabled = Boolean(enabled);
      if (topic) config.topic = String(topic);
      if (serverUrl) config.serverUrl = String(serverUrl).replace(/\/+$/, "");
      saveChannelConfig("ntfy", { config });
      eventLog?.log("channels.ntfy_updated", { enabled: config.enabled });
      const status = await channelsApi().ntfy.status();
      return { ok: true, connected: status.connected };
    },

    async testNtfy(ctx) {
      const r = await channelsApi().ntfy.test();
      eventLog?.log("channels.ntfy_test", { sent: r.sent });
      if (!r.sent) throw new HttpError(502, "channel_error", `ntfy test failed: ${r.reason || "unknown"}`);
      return { ok: true };
    },

    // ---- Bark（m4b；deviceKey 加密，serverUrl 可自建） -----------------------
    async updateBark(ctx) {
      const { enabled, serverUrl, deviceKey } = ctx.body || {};
      if (deviceKey !== undefined && deviceKey !== null && deviceKey !== "" && typeof deviceKey !== "string") {
        throw new HttpError(400, "bad_request", "deviceKey must be string");
      }
      if (serverUrl !== undefined && serverUrl !== null && serverUrl !== "" && typeof serverUrl !== "string") {
        throw new HttpError(400, "bad_request", "serverUrl must be string");
      }
      if (serverUrl && !/^https?:\/\//.test(serverUrl)) {
        throw new HttpError(400, "bad_request", "serverUrl must be http(s) URL");
      }
      const config = {};
      if (enabled !== undefined) config.enabled = Boolean(enabled);
      if (deviceKey) config.deviceKeyAlias = `${String(deviceKey).slice(0, 6)}…`;
      if (serverUrl) config.serverUrl = String(serverUrl).replace(/\/+$/, "");
      saveChannelConfig("bark", { config, secret: deviceKey || undefined });
      eventLog?.log("channels.bark_updated", { enabled: config.enabled });
      const status = await channelsApi().bark.status();
      return { ok: true, connected: status.connected };
    },

    async testBark(ctx) {
      const r = await channelsApi().bark.test();
      eventLog?.log("channels.bark_test", { sent: r.sent });
      if (!r.sent) throw new HttpError(502, "channel_error", `bark test failed: ${r.reason || "unknown"}`);
      return { ok: true };
    },

    // ---- 推送矩阵（B4） ------------------------------------------------------
    async getPushRules(ctx) {
      const matrix = notifier.matrix();
      return { matrix, weeklyReportDay: state.pushRules.weeklyReportDay ?? 1, quietHours: state.pushRules.quietHours ?? { enabled: false, start: "23:00", end: "07:00" } };
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
        // 变更审计：记录改了哪些格子（排障盲区 —— 谁在何时改矩阵此前无处可查）
        const before = matrixFromRules({ matrix: state.pushRules?.matrix ?? {} });
        const changed = [];
        for (const ev of PUSH_EVENTS) {
          for (const ch of PUSH_CHANNELS) {
            if (before[ev]?.[ch] !== clean[ev][ch]) changed.push(`${ev}.${ch}`);
          }
        }
        if (changed.length) eventLog?.log?.("push.rules_updated", { changed });
        state.pushRules.matrix = clean;
      }
      if (body.weeklyReportDay !== undefined) {
        const day = Number(body.weeklyReportDay);
        if (!Number.isInteger(day) || day < 1 || day > 7) {
          throw new HttpError(400, "bad_request", "weeklyReportDay must be integer 1-7");
        }
        state.pushRules.weeklyReportDay = day;
      }
      if (body.quietHours !== undefined) {
        // P1-a 静音时段：{enabled,start:'HH:MM',end:'HH:MM'}，start==end 视为关闭
        const qh = body.quietHours;
        if (typeof qh !== "object" || qh === null) {
          throw new HttpError(400, "bad_request", "quietHours must be an object");
        }
        const hm = (v) => /^([01]?\d|2[0-3]):([0-5]\d)$/.test(String(v ?? ""));
        if (qh.enabled !== undefined && typeof qh.enabled !== "boolean") {
          throw new HttpError(400, "bad_request", "quietHours.enabled must be boolean");
        }
        if (!hm(qh.start) || !hm(qh.end)) {
          throw new HttpError(400, "bad_request", "quietHours.start/end must be HH:MM");
        }
        state.pushRules.quietHours = {
          enabled: qh.enabled === true,
          start: String(qh.start),
          end: String(qh.end)
        };
      }
      saveState(state);
      return { matrix: notifier.matrix(), weeklyReportDay: state.pushRules.weeklyReportDay, quietHours: state.pushRules.quietHours };
    },

    // ---- 报告（GA-11/18） -----------------------------------------------------
    async listReports(ctx) {
      const limit = Math.max(1, Math.min(100, Number(ctx.query.limit) || 50));
      const weekly = store.listReportSnapshots("weekly", limit);
      const monthly = store.listReportSnapshots("monthly", limit);
      const annual = store.listReportSnapshots("annual", limit);
      const toRow = (r) => ({
        id: r.id,
        type: r.kind,
        periodLabel: r.payload?.periodLabel || `${r.periodStart?.slice(0, 10)} ~ ${r.periodEnd?.slice(0, 10)}`,
        distanceKm: r.payload?.kpi?.distanceKm ?? null,
        totalCost: r.payload?.kpi?.totalCost ?? null,
        saved: r.payload?.kpi?.saved ?? null,
        createdAt: r.createdAt
      });
      return { items: [...monthly, ...weekly, ...annual].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(toRow) };
    },

    async reportDetail(ctx) {
      const id = Number(ctx.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "bad_request", "invalid report id");
      const all = [...store.listReportSnapshots("weekly", 500), ...store.listReportSnapshots("monthly", 500), ...store.listReportSnapshots("annual", 500)];
      const hit = all.find((r) => r.id === id);
      if (!hit) throw new HttpError(404, "not_found", "report not found");
      return { id: hit.id, type: hit.kind, createdAt: hit.createdAt, ...hit.payload };
    },

    async generateReport(ctx) {
      const type = ["daily", "weekly", "monthly", "annual"].includes(ctx.body?.type) ? ctx.body.type : "weekly";
      if (!reportScheduler) throw new HttpError(500, "internal", "report engine unavailable");
      // 日报手动触发 = 立即重发（绕过当日去重；不消费昨夜 backlog，那是定时早报的职责）。
      // 日报不落归档 → 返回各通道送达结果而非快照 id；昨日无数据 → 409 report_empty。
      if (type === "daily") {
        const result = await reportScheduler.runKind("daily", { force: true, manual: true });
        if (!result) throw new HttpError(409, "report_empty", "昨日无行程且无充电，日报已跳过");
        return {
          ok: true, type: "daily",
          periodLabel: result.report.periodLabel ?? null,
          results: result.results ?? {}
        };
      }
      const result = await reportScheduler.runKind(type);
      // runKind 对"同周期已有快照"返回 null（幂等防重）——返回已存在的那份而非报错
      if (!result) {
        const all = store.listReportSnapshots(type, 1);
        const existing = all[0];
        if (existing) {
          return { ok: true, id: existing.id, deduplicated: true, periodLabel: existing.payload?.periodLabel ?? null };
        }
        throw new HttpError(500, "internal", "report generation failed");
      }
      return { ok: true, id: result.id };
    }
  };
}
