// feishu.mjs — push channel abstraction over Feishu (Lark) OpenAPI.
// Graceful degradation: when not configured, enabled=false and every send is a
// no-op returning {sent:false, reason:"disabled"}. Cards use a minimal,
// Card-1.0-compatible subset (header + markdown divs) so they render on both
// mobile and desktop clients.
import { getFeishuSecret } from "./state.mjs";

const FEISHU_API = "https://open.feishu.cn/open-apis";

export function createFeishuChannel(state, { fetchImpl = globalThis.fetch, logger = () => {} } = {}) {
  let cachedToken = null;
  let cachedTokenExp = 0;

  function config() {
    return state.feishu || {};
  }

  function enabled() {
    const cfg = config();
    return Boolean(cfg.enabled && cfg.appId && getFeishuSecret(state));
  }

  async function accessToken() {
    const now = Date.now();
    if (cachedToken && now < cachedTokenExp - 60_000) return cachedToken;
    const cfg = config();
    const secret = getFeishuSecret(state);
    if (!cfg.appId || !secret) return null;
    const resp = await fetchImpl(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: secret })
    });
    const data = await resp.json();
    if (!data?.tenant_access_token) {
      logger(`feishu token error: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }
    cachedToken = data.tenant_access_token;
    cachedTokenExp = now + (Number(data.expire) || 3600) * 1000;
    return cachedToken;
  }

  async function sendMessage(payload) {
    if (!enabled()) return { sent: false, reason: "disabled" };
    const token = await accessToken();
    if (!token) return { sent: false, reason: "auth_failed" };
    const resp = await fetchImpl(`${FEISHU_API}/im/v1/messages?receive_id_type=open_id`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
    const data = await resp.json().catch(() => ({}));
    const ok = resp.ok && data?.code === 0;
    if (!ok) logger(`feishu send error: ${JSON.stringify(data).slice(0, 200)}`);
    if (ok) {
      state.feishu.lastEventAt = new Date().toISOString();
      // 记住目标会话，后续主动推送复用
      if (data?.data?.receive_id) state.feishu.openId = data.data.receive_id;
    }
    return { sent: ok, reason: ok ? null : `api_error code=${data?.code} msg=${data?.msg}`, data };
  }

  // 单用户部署：通讯录根部门（可用范围=自己）取第一个用户 open_id 作为推送目标。
  async function resolveOpenId() {
    const cfg = config();
    if (cfg.openId) return cfg.openId;
    const token = await accessToken();
    if (!token) return null;
    const resp = await fetchImpl(
      `${FEISHU_API}/contact/v3/users/find_by_department?department_id=0&page_size=20`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await resp.json().catch(() => ({}));
    const user = data?.data?.items?.find((u) => u.open_id);
    if (!user) {
      logger(`feishu resolve open_id failed: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }
    state.feishu.openId = user.open_id;
    return user.open_id;
  }

  // Simplified interactive card (Card 1.0 compatible subset).
  function card(title, elements) {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: title }, template: "blue" },
      elements
    };
  }

  function markdown(content) {
    return { tag: "div", text: { tag: "lark_md", content } };
  }

  return {
    enabled,
    // m4b 统一渠道接口:send({title, body, url}) — Notifier.dispatch 的调用契约。
    // 卡片头放标题,正文 markdown;url 存在时附跳转链接。
    async send({ title, body, url } = {}) {
      if (!enabled()) return { sent: false, reason: "disabled" };
      const content = [body, url ? `[打开 AhaTesla](${url})` : null].filter(Boolean).join("\n");
      return this.sendCard(title || "AhaTesla", [markdown(content)]);
    },
    async status() {
      const cfg = config();
      let connected = false;
      if (enabled()) {
        const token = await accessToken().catch(() => null);
        connected = Boolean(token);
      }
      return {
        enabled: enabled(),
        connected,
        appAlias: cfg.appId ? `${String(cfg.appId).slice(0, 6)}…` : "",
        lastEventAt: cfg.lastEventAt || null
      };
    },
    async sendCard(title, elements, targetOpenId) {
      const openId = targetOpenId || config().openId || await resolveOpenId();
      if (!openId) return { sent: false, reason: "no_recipient: 先在飞书里给机器人发一条消息（任意内容）后重试" };
      return sendMessage({
        receive_id: openId,
        msg_type: "interactive",
        content: JSON.stringify(card(title, elements))
      });
    },
    async sendText(text, targetOpenId) {
      const openId = targetOpenId || config().openId || await resolveOpenId();
      if (!openId) return { sent: false, reason: "no_recipient" };
      return sendMessage({
        receive_id: openId,
        msg_type: "text",
        content: JSON.stringify({ text })
      });
    },
    async sendTest() {
      if (!enabled()) return { sent: false, reason: "disabled" };
      return this.sendCard("AhaTesla 测试推送", [
        markdown("**AhaTesla 连接成功**\n如果你看到这张卡片，说明飞书通道工作正常。")
      ]);
    },
    async pushEvent(event) {
      if (!enabled()) return { sent: false, reason: "disabled" };
      if (event.type === "trip_end") {
        return this.sendCard("行程结束", [
          markdown(`**行程结束**\n路段数：${event.segment_ids?.length ?? 0}\n原因：${event.reason || "-"}\n结束时间：${event.ended_at || "-"}`)
        ]);
      }
      if (event.type === "charging_start") {
        return this.sendCard("开始充电", [
          markdown(`**开始充电**\n会话 #${event.charging_process_id ?? "-"}\n开始时间：${event.started_at || "-"}`)
        ]);
      }
      if (event.type === "charging_done") {
        return this.sendCard("充电完成", [
          markdown(`**充电完成**\n会话 #${event.charging_process_id ?? "-"}\n结束时间：${event.ended_at || "-"}`)
        ]);
      }
      return { sent: false, reason: "unknown_event" };
    }
  };
}
