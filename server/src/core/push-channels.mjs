// push-channels.mjs — 统一 Notifier 抽象（US-10 / AC-10.1，GA-08）。
//
// 三渠道平权：webpush / telegram / feishu 各自独立实现同一接口
//   { id, enabled(), status(), send({title, body, url}) → {sent, reason?, deliveryMs} }
// dispatch() 按推送矩阵（5 事件 × 3 渠道）并行投递；单渠道失败不阻塞其他
// 渠道（AC-12.2），每渠道结果独立记录 deliveryMs（AC-12.3 SLA 口径）。
//
// 安全红线：botToken/appSecret/WebPush 私钥一律经 secret-box 加密落库或存
// secret.key 文件；明文不进日志、不进 API 回传、不进错误信息。

import { createRequire } from "node:module";
import { getStore, clearChannelSecret, saveState } from "./state.mjs";
import { encryptSecret, decryptSecret } from "./secret-box.mjs";
import { createFeishuChannel } from "./feishu.mjs";

// ESM 下加载 CJS 的 web-push(直接 require 在 type:module 里是 ReferenceError)
const nodeRequire = createRequire(import.meta.url);

// ---- 静音时段（PUSH-DESIGN P1-a） ---------------------------------------------
// 仅约束 trip_end（内容型）；charging/日报/告警不受影响。窗口按北京时间墙钟,
// start>end 视为跨午夜（如 23:00→07:00）。

const HM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function inQuietHours(quietHours, now = new Date()) {
  const qh = quietHours && quietHours.enabled ? quietHours : null;
  if (!qh || !HM_RE.test(String(qh.start)) || !HM_RE.test(String(qh.end))) return false;
  if (qh.start === qh.end) return false;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const cur = Number(parts.hour === "24" ? "0" : parts.hour) * 60 + Number(parts.minute);
  const [sh, sm] = qh.start.split(":").map(Number);
  const [eh, em] = qh.end.split(":").map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s < e ? (cur >= s && cur < e) : (cur >= s || cur < e); // 跨午夜取并集
}

/** 静音摘取：只留早报「昨夜」段需要的紧凑字段 */
function quietDigest(event) {
  return {
    at: event.ended_at || event.at || new Date().toISOString(),
    startLabel: event.startLabel ?? null,
    endLabel: event.endLabel ?? null,
    distanceKm: event.distanceKm ?? null,
    durationMin: event.durationMin ?? null,
    costCny: event.costCny ?? null
  };
}

// ---- 渠道配置读写（channel_secrets 表 + state.feishu 兼容层） ----------------

const CH_KEY = (id) => `push:channel:${id}`;

export function saveChannelConfig(id, { config = {}, secret }) {
  const store = getStore();
  const cur = store.getChannel(id) || { config: {}, secretEnc: null };
  const clearing = secret === "";
  store.putChannel(id, {
    config: { ...cur.config, ...config },
    secretEnc: secret !== undefined && secret !== null && secret !== ""
      ? encryptSecret(String(secret))
      : (clearing ? null : cur.secretEnc)
  });
  // putChannel 的 coalesce 语义：null 不覆盖旧密文 —— 显式清空走单独 UPDATE
  if (clearing) clearChannelSecret(store, id);
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
          ?? (globalThis.__ahatesla_webpush = nodeRequire("web-push"));
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

// ---- 企业微信 / ntfy / Bark（m4b：矩阵 6 渠道） -------------------------------

/** 带超时的 fetch + JSON 解析；任何异常返回 null（渠道级失败隔离） */
async function fetchJsonTimed(fetchImpl, url, init, timeoutMs, logger, tag) {
  try {
    const resp = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: resp.ok, status: resp.status, data: await resp.json().catch(() => ({})) };
  } catch (error) {
    logger(`${tag} request error: ${String(error?.message || error).slice(0, 120)}`);
    return null;
  }
}

/** 企业微信群机器人：webhook key 加密落库，markdown 卡片 */
export function createWecomChannel({ fetchImpl = globalThis.fetch, logger = () => {} } = {}) {
  function cfg() {
    return loadChannelConfig("wecom");
  }
  function enabled() {
    const { config, secret } = cfg();
    return Boolean(config.enabled && config.webhookKeyAlias && secret);
  }
  async function push({ title, body }) {
    const { secret } = cfg();
    const r = await fetchJsonTimed(
      fetchImpl,
      `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${secret}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "markdown", markdown: { content: `**${title}**\n${body || ""}` } })
      },
      5000,
      logger,
      "wecom"
    );
    if (!r) return { sent: false, reason: "network_error" };
    // 企业微信成功 errcode=0；errcode 93000 系列是 key 无效
    return { sent: r.data?.errcode === 0, reason: r.data?.errcode === 0 ? null : `wecom_errcode_${r.data?.errcode ?? r.status}` };
  }
  return {
    id: "wecom",
    enabled,
    async status() {
      const { config } = cfg();
      return {
        enabled: enabled(),
        connected: enabled(), // webhook 无只读探测 API，configured 即视为可达；test 端点真发一条验证
        webhookKeyAlias: config.webhookKeyAlias || null
      };
    },
    async test() {
      if (!enabled()) return { sent: false, reason: "channel_disabled" };
      return push({ title: "AhaTesla 测试通知", body: "✅ 企业微信通道测试成功" });
    },
    async send({ title, body }) {
      if (!enabled()) return { sent: false, reason: "disabled" };
      return push({ title, body });
    }
  };
}

/** ntfy：topic 即配置（无密钥）；Title/Click 头承载标题与跳转 */
export function createNtfyChannel({ fetchImpl = globalThis.fetch, logger = () => {} } = {}) {
  function cfg() {
    return loadChannelConfig("ntfy");
  }
  function enabled() {
    const { config } = cfg();
    return Boolean(config.enabled && config.topic);
  }
  function baseUrl(config) {
    return String(config.serverUrl || "https://ntfy.sh").replace(/\/+$/, "");
  }
  async function push({ title, body, url }) {
    const { config } = cfg();
    const r = await fetchJsonTimed(
      fetchImpl,
      `${baseUrl(config)}/${encodeURIComponent(config.topic)}`,
      {
        method: "POST",
        headers: { Title: title, ...(url ? { Click: url } : {}) },
        body: `【AhaTesla】${body || ""}`
      },
      5000,
      logger,
      "ntfy"
    );
    if (!r) return { sent: false, reason: "network_error" };
    return { sent: r.ok, reason: r.ok ? null : `ntfy_status_${r.status}` };
  }
  return {
    id: "ntfy",
    enabled,
    async status() {
      const { config } = cfg();
      return {
        enabled: enabled(),
        connected: enabled(),
        topic: config.topic || null,
        serverUrl: config.serverUrl || "https://ntfy.sh"
      };
    },
    async test() {
      if (!enabled()) return { sent: false, reason: "channel_disabled" };
      return push({ title: "AhaTesla 测试通知", body: "✅ ntfy 通道测试成功", url: "/" });
    },
    async send({ title, body, url }) {
      if (!enabled()) return { sent: false, reason: "disabled" };
      return push({ title, body, url });
    }
  };
}

/** Bark（iOS）：device key 加密落库；支持自建 server */
export function createBarkChannel({ fetchImpl = globalThis.fetch, logger = () => {} } = {}) {
  function cfg() {
    return loadChannelConfig("bark");
  }
  function enabled() {
    const { config, secret } = cfg();
    return Boolean(config.enabled && config.deviceKeyAlias && secret);
  }
  async function push({ title, body }) {
    const { config, secret } = cfg();
    const base = String(config.serverUrl || "https://api.day.app").replace(/\/+$/, "");
    const r = await fetchJsonTimed(
      fetchImpl,
      `${base}/${secret}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body: body || "", group: "AhaTesla" })
      },
      5000,
      logger,
      "bark"
    );
    if (!r) return { sent: false, reason: "network_error" };
    return { sent: r.ok && r.data?.code === 200, reason: r.ok && r.data?.code === 200 ? null : `bark_status_${r.status}` };
  }
  return {
    id: "bark",
    enabled,
    async status() {
      const { config } = cfg();
      return {
        enabled: enabled(),
        connected: enabled(),
        deviceKeyAlias: config.deviceKeyAlias || null,
        serverUrl: config.serverUrl || "https://api.day.app"
      };
    },
    async test() {
      if (!enabled()) return { sent: false, reason: "channel_disabled" };
      return push({ title: "AhaTesla 测试通知", body: "✅ Bark 通道测试成功" });
    },
    async send({ title, body }) {
      if (!enabled()) return { sent: false, reason: "disabled" };
      return push({ title, body });
    }
  };
}

// ---- Notifier 门面：矩阵化 dispatch + SLA 埋点 -------------------------------

export const PUSH_EVENTS = ["tripEnd", "chargingStart", "chargingDone", "daily", "weekly", "monthly"];
export const PUSH_CHANNELS = ["webpush", "telegram", "feishu", "wecom", "ntfy", "bark"];

// state.pushRules v2：{matrix:{tripEnd:{webpush,…,bark},…}, weeklyReportDay}；新渠道默认关（用户显式开）
export function defaultMatrix() {
  const m = {};
  for (const ev of PUSH_EVENTS) {
    m[ev] = { webpush: false, telegram: false, feishu: true, wecom: false, ntfy: false, bark: false };
  }
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
      // v1 语义是“全渠道同开同关”，覆盖到全部六渠道
      if (legacy[ev] === false) m[ev] = Object.fromEntries(PUSH_CHANNELS.map((c) => [c, false]));
      else if (legacy[ev] === true) m[ev] = Object.fromEntries(PUSH_CHANNELS.map((c) => [c, true]));
    }
    return m;
  }
  // 只保留已知六渠道键并归一布尔（未知渠道键剔除，防止脏数据进矩阵）
  const out = {};
  for (const ev of PUSH_EVENTS) {
    const row = rules.matrix[ev] || {};
    out[ev] = {};
    for (const ch of PUSH_CHANNELS) out[ev][ch] = row[ch] === true;
  }
  return out;
}

export function createNotifier({ state, eventLog, feishu = null, telegram = null, webpush = null, wecom = null, ntfy = null, bark = null, ai = null, fetchImpl = globalThis.fetch } = {}) {
  // feishu 渠道复用既有实现（state.feishu 直连），其余走新配置层
  const feishuChannel = feishu || createFeishuChannel(state, { logger: (m) => logger?.("feishu.error", { message: m }) });
  const telegramChannel = telegram || createTelegramChannel({ fetchImpl, logger: (m) => logger?.("telegram.error", { message: m }) });
  const webpushChannel = webpush;
  const wecomChannel = wecom || createWecomChannel({ fetchImpl, logger: (m) => logger?.("wecom.error", { message: m }) });
  const ntfyChannel = ntfy || createNtfyChannel({ fetchImpl, logger: (m) => logger?.("ntfy.error", { message: m }) });
  const barkChannel = bark || createBarkChannel({ fetchImpl, logger: (m) => logger?.("bark.error", { message: m }) });

  const channels = {
    feishu: feishuChannel,
    telegram: telegramChannel,
    ...(webpushChannel ? { webpush: webpushChannel } : {}),
    wecom: wecomChannel,
    ntfy: ntfyChannel,
    bark: barkChannel
  };

  function eventTitle(event) {
    // 北京时间戳（推送时间≠事件时间，标注发送时刻避免“昨晚信息今早收到”困惑）
    const now = new Date();
    const ts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(now).replace(/\//g, "-");
    switch (event.type) {
      case "trip_end": return `行程结束 · ${ts}`;
      case "charging_start": return `开始充电 · ${ts}`;
      case "charging_done": return `${event.endedEarly ? "⚠ 充电提前中止" : "充电完成"} · ${ts}`;
      case "daily": return `昨日用车日报 · ${event.dateLabel || ts}`;
      case "weekly": return "每周用车周报";
      case "monthly": return "每月账本月报";
      default: return `AhaTesla 通知 · ${ts}`;
    }
  }

  function eventBody(event) {
    if (event.type === "trip_end") {
      // v2.2 富化版：路线 + 核心数字 + 驾驶洞察（天气/胎压/拥堵/效率）
      const lines = [];
      // 路线行:双侧 A → B;仅终点 → HOME(读作"到 HOME");仅起点 A →;双无 → 整行省略
      const route = event.startLabel && event.endLabel
        ? `${event.startLabel} → ${event.endLabel}`
        : event.endLabel
          ? `→ ${event.endLabel}`
          : event.startLabel || null;
      if (route) {
        lines.push(`🚗 ${route}`);
      }

      const stats = [];
      if (event.distanceKm != null) stats.push(`${event.distanceKm} km`);
      if (event.durationMin != null) stats.push(`${event.durationMin} 分钟`);
      if (event.energyKwh != null) stats.push(`${event.energyKwh} kWh`);
      if (event.costCny != null) stats.push(`¥${event.costCny}`);
      if (stats.length) lines.push(`📊 ${stats.join(" · ")}`);
      if (event.savedCny != null) lines.push(`💰 较油车省 ¥${event.savedCny}`);

      const insights = [];
      if (event.avgTempC != null) insights.push(`🌡 ${event.avgTempC}°C${event.minTempC != null && event.minTempC < event.avgTempC ? `（最低 ${event.minTempC}°C）` : ""}`);
      if (event.avgSpeedKmh != null && event.maxSpeedKmh != null) insights.push(`🏎 均 ${event.avgSpeedKmh} / 峰 ${event.maxSpeedKmh} km/h`);
      if (event.idleRatio != null && event.idleRatio >= 0.15) insights.push(`🚦 堵车怠速占 ${Math.round(event.idleRatio * 100)}%`);
      // 能耗效率：仅在能耗数据有效时显示（避免"0 kWh/100km"假数据）
      if (event.kwhPer100km != null && event.kwhPer100km > 0) insights.push(`⚡ ${event.kwhPer100km} kWh/100km`);
      if (event.powerMaxKw != null && event.powerMaxKw >= 100) insights.push(`🔥 峰值功率 ${event.powerMaxKw} kW`);
      if (event.tirePressure) {
        const tp = event.tirePressure;
        const vals = [tp.fl, tp.fr, tp.rl, tp.rr].filter((v) => v != null).map((v) => Number(v));
        if (vals.length === 4) {
          const min = Math.min(...vals);
          const max = Math.max(...vals);
          // 四轮一致显示单值，有差异才显示区间
          const range = max - min < 0.05 ? `${min.toFixed(1)}` : `${min.toFixed(1)}~${max.toFixed(1)}`;
          const tag = max - min >= 0.3 ? "⚠️" : "🛞";
          insights.push(`${tag} 胎压 ${range} bar`);
        }
      }
      if (insights.length) lines.push(insights.join(" · "));

      // P1-b 费用口径行：多批次 FIFO 计价时透明化来源（前 2 批，其余省略）
      const fb = Array.isArray(event.fifoBatches) ? event.fifoBatches.filter((b) => b && b.kwh > 0) : [];
      if (fb.length > 1) {
        const head = fb.slice(0, 2).map((b) => `${b.source} ${b.kwh}kWh@¥${b.price}`).join(" · ");
        lines.push(`🔋 计价批次 ${head}${fb.length > 2 ? " …" : ""}`);
      }

      return lines.length ? lines.join("\n") : `行程已结束（${event.segment_ids?.length ?? 0} 段）`;
    }
    if (event.type === "charging_done") {
      const lines = [];
      const parts = [];
      if (event.energyKwh != null) parts.push(`充入 ${event.energyKwh} kWh`);
      if (event.costCny != null) parts.push(`¥${event.costCny}`);
      if (parts.length) lines.push(`⚡ ${parts.join(" · ")}`);
      if (event.endBattery != null) lines.push(`🔋 已充至 ${Math.round(event.endBattery)}%`);
      if (event.locationName) lines.push(`📍 ${event.locationName}`);
      if (event.priceCmpPct != null) {
        // P1-d 与本站近 5 次平均单价对比（数据可得才出现）
        const v = Math.round(event.priceCmpPct);
        if (v !== 0) lines.push(`📊 较本站近 5 次均价 ${v > 0 ? "高" : "低"} ${Math.abs(v)}%`);
      }
      if (event.tempC != null) lines.push(`🌡 充电时气温 ${event.tempC}°C`);
      return lines.length ? lines.join("\n") : `充电会话 #${event.charging_process_id ?? "-"} 已结束`;
    }
    if (event.type === "charging_start") {
      // P1-c 富化：电量/预估由富化层注入（数据可得才显示，不硬造）
      const bits = [`🔌 充电开始`];
      if (event.batteryPct != null) bits.push(`🔋 当前 ${Math.round(event.batteryPct)}%`);
      if (event.locationName) bits.push(`📍 ${event.locationName}`);
      if (event.estimate) bits.push(`⏱ ${event.estimate}`);
      return bits.join("\n");
    }
    if (event.type === "daily") {
      // m4c-c1 昨日日报：核心一句话 → 行程/充电 → 对比 → 本月累计 → 异常提醒（~10 行）
      const k = event.kpi || {};
      const lines = [];
      const core = [];
      if (k.distanceKm != null) core.push(`${k.distanceKm} km`);
      if (k.totalCost != null) core.push(`¥${k.totalCost}`);
      if (k.saved > 0) core.push(`省 ¥${k.saved}`);
      lines.push(`📈 昨日 ${core.join(" · ")}`);
      if (k.driveCount > 0) {
        const bits = [`🚗 ${k.driveCount} 次`];
        if (k.energyKwh != null) bits.push(`${k.energyKwh} kWh`);
        if (event.topRoute) bits.push(event.topRoute);
        lines.push(bits.join(" · "));
      }
      const cs = event.chargeSummary;
      if (cs && cs.count > 0) {
        const bits = [`⚡ 充电 ${cs.kwh} kWh · ${cs.count} 次`];
        if (cs.locations?.length) bits.push(cs.locations.join("/"));
        if (cs.lastEndTime) bits.push(`至 ${cs.lastEndTime}`);
        lines.push(bits.join(" · "));
      }
      const cmp = event.compare;
      if (cmp && (cmp.kmDeltaPct != null || cmp.costDeltaPct != null)) {
        const fmtDelta = (v) => (v == null ? "--" : `${v > 0 ? "+" : ""}${v}%`);
        lines.push(`📊 较上周同日 里程 ${fmtDelta(cmp.kmDeltaPct)} · 电费 ${fmtDelta(cmp.costDeltaPct)}`);
      }
      if (cmp?.month && cmp.month.distanceKm > 0) {
        lines.push(`📅 本月累计 ${cmp.month.distanceKm} km · ¥${cmp.month.totalCost}`);
      }
      // 异常提醒（有才出现）
      const ins = event.insights || {};
      if (ins.tireMinBar != null && ins.tireMinBar < 2.8) {
        lines.push(`🛞 四轮最低胎压 ${ins.tireMinBar} bar（低于 2.8，建议补气）`);
      }
      if (ins.avgTempC != null && ins.avgTempC < 5 && ins.kwhPer100km != null && ins.kwhPer100km > 15) {
        lines.push(`🌡 ${ins.avgTempC}°C 低温，能耗 ${ins.kwhPer100km} kWh/100km 偏高`);
      }
      if (ins.idlePct != null && ins.idlePct >= 25) {
        lines.push(`🚦 怠速占比 ${ins.idlePct}%，拥堵较多`);
      }
      const pl = k.parkingLoss;
      if (pl && pl.kwh > 0.5) {
        lines.push(`🌙 驻车损耗 ${pl.kwh.toFixed(1)} kWh（¥${(pl.cost ?? 0).toFixed(2)}）`);
      }
      // P1-e 今夜插枪提醒：TOU 用户且昨日无充电（report-engine 注入 plugHint）
      if (event.plugHint) lines.push(`🔌 ${event.plugHint}`);
      // P1-a 昨夜静音行程合并段（最多 3 条逐条，更多聚合计数）
      const qt = Array.isArray(event.quietTrips) ? event.quietTrips : [];
      if (qt.length) {
        const hm = (iso) => {
          try {
            return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
          } catch { return ""; }
        };
        const item = (t) => {
          const route = t.startLabel && t.endLabel ? `${t.startLabel}→${t.endLabel}` : t.endLabel ? `→${t.endLabel}` : "";
          const nums = [t.distanceKm != null ? `${t.distanceKm}km` : null, t.costCny != null ? `¥${t.costCny}` : null].filter(Boolean).join(" ");
          return [hm(t.at), route, nums].filter(Boolean).join(" ");
        };
        const shown = qt.slice(0, 3).map(item).filter(Boolean).join("；");
        lines.push(`🌙 昨夜静默行程 ${shown}${qt.length > 3 ? ` 等 ${qt.length} 段` : ""}`);
      }
      return lines.join("\n");
    }
    if (event.type === "weekly" || event.type === "monthly") return event.summary || "";
    return "";
  }

  function eventUrl(event) {
    if (event.type === "trip_end" && event.driveIds?.length) return `/trips/${event.driveIds[0]}`;
    if (event.type === "charging_done") return `/charging?focus=${event.charging_process_id}`;
    if (event.type === "weekly" || event.type === "monthly") return "/reports";
    return "/";
  }

  /** AI 润色适用的事件（充电开始/结束数字极简，不消费 AI） */
  const AI_KINDS = new Set(["trip_end", "daily", "weekly", "monthly"]);

  /**
   * 按矩阵并行投递一个事件（AC-12.2：单渠道失败隔离）。
   * 返回 {results: {channel: {sent, deliveryMs, reason}}}。
   */
  async function dispatch(event, { matrix } = {}) {
    // P1-a 静音时段：trip_end 命中 → 摘要入 backlog，次日早报合并呈现（不丢弃）
    if (event.type === "trip_end" && inQuietHours(state.pushRules?.quietHours)) {
      const rules = state.pushRules;
      const backlog = Array.isArray(rules.quietBacklog) ? rules.quietBacklog : [];
      backlog.push(quietDigest(event));
      while (backlog.length > 10) backlog.shift(); // 上限 10，最旧的先丢
      rules.quietBacklog = backlog;
      try { saveState(state); } catch { /* 持久化失败不阻断（内存 backlog 仍会被早报消费） */ }
      eventLog?.log?.("push.quiet_deferred", { eventKey: event.eventKey ?? null, backlog: backlog.length });
      return { results: {}, deferred: true };
    }
    const rules = matrix ? { matrix } : state.pushRules;
    const m = matrixFromRules(rules);
    const ruleKey = { trip_end: "tripEnd", charging_start: "chargingStart", charging_done: "chargingDone", daily: "daily", weekly: "weekly", monthly: "monthly" }[event.type] || event.type;
    const targets = m[ruleKey] || {};
    const title = eventTitle(event);
    let body = eventBody(event);
    // m4c-c3 BYO 模型：启用且生成成功 → 模板末尾追加一行；任何失败静默回退（模板完整）
    if (ai && AI_KINDS.has(event.type) && body) {
      const insight = await ai.enhanceInsight(event.type, event).catch(() => null);
      if (insight) body = `${body}\n💡 ${insight}`;
    }
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
