// push-channels.mjs — 统一 Notifier 抽象（US-10 / AC-10.1，GA-08）。
//
// 三渠道平权：webpush / telegram / feishu 各自独立实现同一接口
//   { id, enabled(), status(), send({title, body, url}) → {sent, reason?, deliveryMs} }
// dispatch() 按推送矩阵（5 事件 × 3 渠道）并行投递；单渠道失败不阻塞其他
// 渠道（AC-12.2），每渠道结果独立记录 deliveryMs（AC-12.3 SLA 口径）。
//
// 安全红线：botToken/appSecret/WebPush 私钥一律经 secret-box 加密落库或存
// secret.key 文件；明文不进日志、不进 API 回传、不进错误信息。

import { getStore } from "./state.mjs";
import { encryptSecret, decryptSecret } from "./secret-box.mjs";
import { createFeishuChannel } from "./feishu.mjs";

// ---- 渠道配置读写（channel_secrets 表 + state.feishu 兼容层） ----------------

const CH_KEY = (id) => `push:channel:${id}`;

export function saveChannelConfig(id, { config = {}, secret }) {
  const store = getStore();
  const cur = store.getChannel(id) || { config: {}, secretEnc: null };
  store.putChannel(id, {
    config: { ...cur.config, ...config },
    secretEnc: secret !== undefined && secret !== null && secret !== ""
      ? encryptSecret(String(secret))
      : (secret === "" ? null : cur.secretEnc)
  });
  const saved = store.getChannel(id);
  return { config: saved.config, hasSecret: Boolean(saved.secretEnc) };
}

export function loadChannelConfig(id) {
  const store = getStore();
  const row = store.getChannel(id);
  if (!row) return { config: {}, secret: null };
  return {
    config: row.config || {},
    secret: row.secretEnc ? decryptSecret(row.secretEnc) : null
  };
}

// ---- Telegram（US-10；Bot API，密文存储 botToken） ---------------------------

export function createTelegramChannel({ fetchImpl = globalThis.fetch, logger = () => {} } = {}) {
  function cfg() {
    return loadChannelConfig("telegram");
  }
  function enabled() {
    const { config, secret } = cfg();
    return Boolean(config.enabled && config.botTokenAlias && secret);
  }

  async function apiCall(token, method, payload) {
    const resp = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await resp.json().catch(() => ({}));
    if (!data?.ok) {
      logger(`telegram ${method} error: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }
    return data;
  }

  return {
    id: "telegram",
    enabled,
    async status() {
      const { config, secret } = cfg();
      let connected = false;
      if (enabled()) {
        const me = await apiCall(secret, "getMe", {}).catch(() => null);
        connected = Boolean(me?.result?.username);
      }
      return {
        enabled: enabled(),
        connected,
        botAlias: config.botTokenAlias ? `${String(config.botTokenAlias).slice(0, 8)}…` : null,
        chatIdAlias: config.chatIdAlias || null
      };
    },
    async test() {
      const { config, secret } = cfg();
      if (!enabled()) return { sent: false, reason: "channel_disabled" };
      const r = await apiCall(secret, "sendMessage", {
        chat_id: config.chatId,
        text: "✅ AhaTesla Telegram 通道测试成功"
      });
      return { sent: Boolean(r), reason: r ? null : "telegram_api_error" };
    },
    async send({ title, body, _url }) {
      if (!enabled()) return { sent: false, reason: "disabled" };
      const { config, secret } = cfg();
      const text = `【AhaTesla】${title}\n${body || ""}`;
      const r = await apiCall(secret, "sendMessage", {
        chat_id: config.chatId,
        text
      });
      return { sent: Boolean(r), reason: r ? null : "telegram_api_error" };
    }
  };
}

// ---- Web Push（US-11；VAPID，订阅存 push_subscriptions 表） ------------------

export function createWebPushChannel({
  webpush = null, // 可注入（测试）；缺省懒加载 web-push
  fetchImpl = globalThis.fetch,
  logger = () => {}
} = {}) {
  let wp = webpush;
  let vapidReady = false;

  function subscriptions() {
    return getStore().listPushSubscriptions();
  }

  function ensureVapid() {
    if (vapidReady) return true;
    if (!wp) {
      try {
        // 零框架纪律的例外：Web Push 需要 RFC 8291 ECDH/AES128GCM 加密，
        // 手写成本高且易错，采用成熟 web-push 库（协议层，非框架）。
        wp = globalThis.__ahatesla_webpush
          ?? (globalThis.__ahatesla_webpush = require("web-push"));
      } catch (error) {
        logger(`web-push load failed: ${error.message}`);
        return false;
      }
    }
    const { config } = loadChannelConfig("webpush");
    const vapid = config?.vapid || null;
    if (!vapid?.publicKey || !vapid?.privateKey) return false;
    try {
      wp.setVapidDetails("mailto:admin@ahatesla.local", vapid.publicKey, vapid.privateKey);
      vapidReady = true;
      return true;
    } catch (error) {
      logger(`vapid setup failed: ${error.message}`);
      return false;
    }
  }

  return {
    id: "webpush",
    enabled() {
      return subscriptions().length > 0 && ensureVapid();
    },
    isConfigured() {
      const { config } = loadChannelConfig("webpush");
      return Boolean(config?.vapid?.publicKey && config?.vapid?.privateKey);
    },
    vapidPublicKey() {
      const { config } = loadChannelConfig("webpush");
      return config?.vapid?.publicKey ?? null;
    },
    async status() {
      const subs = subscriptions();
      return {
        enabled: this.enabled(),
        configured: this.isConfigured(),
        subscriberCount: subs.length
      };
    },
    addSubscription({ endpoint, keys }) {
      const store = getStore();
      store.addPushSubscription({ endpoint, keys, meta: {} });
      return { ok: true };
    },
    removeSubscription({ endpoint }) {
      getStore().removePushSubscription(endpoint);
      return { ok: true };
    },
    async test() {
      const r = await this.send({
        title: "AhaTesla 测试通知",
        body: "如果你看到这条通知，说明 Web Push 通道工作正常。",
        url: "/"
      });
      return r;
    },
    async send({ title, body, url }) {
      if (!ensureVapid()) return { sent: false, reason: "vapid_not_configured" };
      const subs = subscriptions();
      if (subs.length === 0) return { sent: false, reason: "no_subscribers" };
      const payload = JSON.stringify({ title, body, url: url || "/" });
      let sentAny = false;
      let sentCount = 0;
      for (const sub of subs) {
        try {
          await wp.sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            payload,
            { TTL: 3600, urgency: "normal" }
          );
          sentAny = true;
          sentCount += 1;
        } catch (error) {
          const status = error?.statusCode;
          // AC-11.3：404/410 = 订阅已失效 → 清理
          if (status === 404 || status === 410) {
            getStore().removePushSubscription(sub.endpoint);
            logger(`webpush subscription pruned (${status})`);
          } else {
            logger(`webpush send error: ${String(error?.message).slice(0, 120)}`);
          }
        }
      }
      return { sent: sentAny, sentCount, reason: sentAny ? null : "all_failed" };
    }
  };
}

// ---- Notifier 门面：矩阵化 dispatch + SLA 埋点 -------------------------------

export const PUSH_EVENTS = ["tripEnd", "chargingStart", "chargingDone", "weekly", "monthly"];
export const PUSH_CHANNELS = ["webpush", "telegram", "feishu"];

// state.pushRules v2：{matrix:{tripEnd:{webpush,telegram,feishu},…}, weeklyReportDay}
export function defaultMatrix() {
  const m = {};
  for (const ev of PUSH_EVENTS) m[ev] = { webpush: false, telegram: false, feishu: true };
  return m;
}

export function matrixFromRules(rules) {
  // v1 兼容：旧布尔规则映射为“全渠道同开同关”
  if (!rules?.matrix) {
    const m = defaultMatrix();
    const legacy = {
      tripEnd: rules?.tripEnd,
      chargingStart: rules?.chargingStart,
      chargingDone: rules?.chargingDone,
      weekly: rules?.weeklyReport ?? rules?.weekly,
      monthly: rules?.monthlyReport ?? rules?.monthly
    };
    for (const ev of PUSH_EVENTS) {
      if (legacy[ev] === false) m[ev] = { webpush: false, telegram: false, feishu: false };
      else if (legacy[ev] === true) m[ev] = { webpush: true, telegram: true, feishu: true };
    }
    return m;
  }
  const out = {};
  for (const ev of PUSH_EVENTS) {
    out[ev] = { ...(rules.matrix[ev] || {}) };
    for (const ch of PUSH_CHANNELS) if (typeof out[ev][ch] !== "boolean") out[ev][ch] = false;
  }
  return out;
}

export function createNotifier({ state, eventLog, feishu = null, telegram = null, webpush = null, fetchImpl = globalThis.fetch } = {}) {
  // feishu 渠道复用既有实现（state.feishu 直连），其余走新配置层
  const feishuChannel = feishu || createFeishuChannel(state, { logger: (m) => logger?.("feishu.error", { message: m }) });
  const telegramChannel = telegram || createTelegramChannel({ fetchImpl, logger: (m) => logger?.("telegram.error", { message: m }) });
  const webpushChannel = webpush;

  const channels = {
    feishu: feishuChannel,
    telegram: telegramChannel,
    ...(webpushChannel ? { webpush: webpushChannel } : {})
  };

  function eventTitle(event) {
    switch (event.type) {
      case "trip_end": return "行程结束";
      case "charging_start": return "开始充电";
      case "charging_done": return "充电完成";
      case "weekly": return "每周用车周报";
      case "monthly": return "每月账本月报";
      default: return "AhaTesla 通知";
    }
  }

  function eventBody(event) {
    if (event.type === "trip_end") {
      const parts = [];
      if (event.distanceKm != null) parts.push(`里程 ${event.distanceKm} km`);
      if (event.costCny != null) parts.push(`电费 ¥${event.costCny}`);
      if (event.savedCny != null) parts.push(`较油车省 ¥${event.savedCny}`);
      return parts.length > 0 ? parts.join(" · ") : `行程已结束（${event.segment_ids?.length ?? 0} 段）`;
    }
    if (event.type === "charging_done") {
      const parts = [];
      if (event.energyKwh != null) parts.push(`充入 ${event.energyKwh} kWh`);
      if (event.costCny != null) parts.push(`费用 ¥${event.costCny}`);
      return parts.length > 0 ? parts.join(" · ") : `充电会话 #${event.charging_process_id ?? "-"} 已结束`;
    }
    if (event.type === "charging_start") return `充电会话 #${event.charging_process_id ?? "-"} 开始`;
    if (event.type === "weekly" || event.type === "monthly") return event.summary || "";
    return "";
  }

  function eventUrl(event) {
    if (event.type === "trip_end" && event.driveIds?.length) return `/trips/${event.driveIds[0]}`;
    if (event.type === "charging_done") return `/charging?focus=${event.charging_process_id}`;
    if (event.type === "weekly" || event.type === "monthly") return "/reports";
    return "/";
  }

  /**
   * 按矩阵并行投递一个事件（AC-12.2：单渠道失败隔离）。
   * 返回 {results: {channel: {sent, deliveryMs, reason}}}。
   */
  async function dispatch(event, { matrix } = {}) {
    const rules = matrix ? { matrix } : state.pushRules;
    const m = matrixFromRules(rules);
    const ruleKey = { trip_end: "tripEnd", charging_start: "chargingStart", charging_done: "chargingDone", weekly: "weekly", monthly: "monthly" }[event.type] || event.type;
    const targets = m[ruleKey] || {};
    const title = eventTitle(event);
    const body = eventBody(event);
    const url = eventUrl(event);

    const jobs = [];
    for (const [id, channel] of Object.entries(channels)) {
      if (!targets[id]) continue;
      jobs.push((async () => {
        const t0 = Date.now();
        try {
          const r = await channel.send({ title, body, url });
          return { channel: id, ...r, deliveryMs: Date.now() - t0 };
        } catch (error) {
          return { channel: id, sent: false, reason: String(error?.message).slice(0, 120), deliveryMs: Date.now() - t0 };
        }
      })());
    }
    const results = await Promise.all(jobs);
    const byChannel = {};
    for (const r of results) byChannel[r.channel] = { sent: r.sent, deliveryMs: r.deliveryMs, ...(r.reason ? { reason: r.reason } : {}) };
    return { results: byChannel };
  }

  return {
    channels,
    dispatch,
    matrix: () => matrixFromRules(state.pushRules)
  };
}
