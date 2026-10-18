import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, BellRing, CheckCircle2, Link2, Lock, Send, Smartphone, XCircle } from 'lucide-react'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { useToast } from '@/components/Toast'
import { timeAgo } from '@/utils/format'

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

/** Web Push（US-11）：HTTPS 前置检测（AC-11.0 置灰）+ 订阅 + 测试 */
function WebPushCard({ https }: { https: boolean }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const { data: channels } = useQuery({ queryKey: ['channels'], queryFn: api.channelStatus })
  const webpush = channels?.webpush

  const enablePush = useMutation({
    mutationFn: async () => {
      // 1) 确保 VAPID 密钥存在（后端生成，私钥加密落库）
      const vapid = await api.webpushInitVapid()
      // 2) 浏览器订阅
      const reg = await navigator.serviceWorker.ready
      const key = urlBase64ToUint8Array(vapid.publicKey)
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key.buffer as ArrayBuffer,
      })
      const json = sub.toJSON()
      // 3) 上报订阅
      return api.webpushSubscribe({
        endpoint: String(json.endpoint),
        keys: { p256dh: String(json.keys?.p256dh ?? ''), auth: String(json.keys?.auth ?? '') },
      })
    },
    onSuccess: () => {
      toast('Web Push 已开启，本设备将收到通知', 'success')
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  const test = useMutation({
    mutationFn: api.webpushTest,
    onSuccess: () => toast('测试通知已发送', 'success'),
    onError: (err) => toast(err.message, 'error'),
  })

  // AC-11.0：仅按 HTTPS 判定置灰（订阅失败由 mutation 错误提示兜底）
  const disabled = !https
  const subscriberCount = webpush?.subscriberCount ?? 0

  return (
    <section className="glass-card-flat p-5" data-testid="webpush-card">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-tesla/[0.12] text-tesla">
            <Smartphone className="h-[18px] w-[18px]" />
          </div>
          <div>
            <h2 className="text-sm font-medium text-slate-100">Web Push</h2>
            <p className="text-[11px] text-slate-400">默认推送渠道 · 零第三方依赖</p>
          </div>
        </div>
        {!channels ? (
          <span className="skeleton h-[26px] w-20 rounded-full" data-testid="webpush-status-loading" />
        ) : webpush && (
          <span
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${
              subscriberCount > 0 ? 'bg-emerald-400/10 text-emerald-400' : 'bg-white/[0.06] text-slate-400'
            }`}
            data-testid="webpush-status"
          >
            {subscriberCount > 0 ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
            {subscriberCount > 0 ? `${subscriberCount} 台设备` : '未订阅'}
          </span>
        )}
      </div>

      {disabled ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-3.5 text-xs leading-5 text-amber-400" data-testid="webpush-https-warning">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" />
          当前为非 HTTPS 环境，Web Push 不可用。建议配置反代启用 HTTPS，或优先绑定 Telegram / 飞书。
        </div>
      ) : (
        <div className="flex gap-2.5">
          <button
            className="btn-primary flex-1"
            onClick={() => enablePush.mutate()}
            disabled={enablePush.isPending}
            data-testid="webpush-enable"
          >
            <Bell className="h-4 w-4" />
            {enablePush.isPending ? '开启中…' : subscriberCount > 0 ? '重新订阅本设备' : '一键开启 Web Push'}
          </button>
          <button
            className="btn-ghost flex-1"
            onClick={() => test.mutate()}
            disabled={test.isPending || subscriberCount === 0}
            data-testid="webpush-test"
          >
            <Send className="h-4 w-4" />
            发送测试通知
          </button>
        </div>
      )}
    </section>
  )
}

/** Telegram（US-10）：Token/ChatID 密文存储 + 连通性测试 */
function TelegramCard() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const { data: channels } = useQuery({ queryKey: ['channels'], queryFn: api.channelStatus })
  const telegram = channels?.telegram
  const [botToken, setBotToken] = useState('')
  const [chatId, setChatId] = useState('')

  const save = useMutation({
    mutationFn: () => api.saveTelegram({ enabled: true, botToken: botToken.trim() || undefined, chatId: chatId.trim() || undefined }),
    onSuccess: (res) => {
      toast(res.connected ? 'Telegram 已连接' : '已保存，但连接未成功，请检查 Token/ChatID', res.connected ? 'success' : 'error')
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  const test = useMutation({
    mutationFn: api.testTelegram,
    onSuccess: () => toast('测试消息已发送', 'success'),
    onError: (err) => toast(err.message, 'error'),
  })

  return (
    <section className="glass-card-flat p-5" data-testid="telegram-card">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-tesla/[0.12] text-tesla">
            <Send className="h-[18px] w-[18px]" />
          </div>
          <div>
            <h2 className="text-sm font-medium text-slate-100">Telegram</h2>
            <p className="text-[11px] text-slate-400">@BotFather 创建 Bot 取 Token → @userinfobot 取 ChatID</p>
          </div>
        </div>
        {!channels ? (
          <span className="skeleton h-[26px] w-20 rounded-full" data-testid="telegram-status-loading" />
        ) : telegram && (
          <span
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${
              telegram.connected ? 'bg-emerald-400/10 text-emerald-400' : 'bg-white/[0.06] text-slate-400'
            }`}
            data-testid="telegram-status"
          >
            {telegram.connected ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
            {telegram.connected ? '已连接' : '未连接'}
          </span>
        )}
      </div>

      <div className="space-y-3">
        <div>
          <label htmlFor="tg-token" className="mb-1.5 block text-xs font-medium text-slate-400">Bot Token</label>
          <input
            id="tg-token"
            type="password"
            className="input-dark"
            placeholder={telegram?.botAlias ? `已保存（${telegram.botAlias}…），留空则不修改` : '123456789:AAF…'}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            data-testid="tg-token-input"
          />
        </div>
        <div>
          <label htmlFor="tg-chat" className="mb-1.5 block text-xs font-medium text-slate-400">Chat ID</label>
          <input
            id="tg-chat"
            className="input-dark num"
            placeholder={telegram?.chatIdAlias ? `已保存（${telegram.chatIdAlias}…）` : '123456789'}
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            data-testid="tg-chat-input"
          />
        </div>
        <div className="flex gap-2.5 pt-1">
          <button
            className="btn-primary flex-1"
            onClick={() => save.mutate()}
            disabled={save.isPending || (!botToken.trim() && !chatId.trim() && !telegram?.botAlias)}
            data-testid="telegram-save"
          >
            {save.isPending ? '连接中…' : '保存并连接'}
          </button>
          <button
            className="btn-ghost flex-1"
            onClick={() => test.mutate()}
            disabled={test.isPending || !telegram?.connected}
            data-testid="telegram-test"
          >
            <Send className="h-4 w-4" />
            发送测试消息
          </button>
        </div>
      </div>
    </section>
  )
}

/** 飞书（保留既有实现直连） */
function FeishuCard() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const { data: channels } = useQuery({ queryKey: ['channels'], queryFn: api.channelStatus })
  const feishu = channels?.feishu
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')

  const save = useMutation({
    mutationFn: () => api.saveFeishu({ enabled: true, appId: appId.trim(), appSecret: appSecret.trim() || undefined }),
    onSuccess: (res) => {
      toast(res.connected ? '飞书连接成功' : '已保存，但连接未成功，请检查 AppID/Secret', res.connected ? 'success' : 'error')
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  const test = useMutation({
    mutationFn: api.testFeishu,
    onSuccess: (res) => toast(res.message || '测试消息已发送', 'success'),
    onError: (err) => toast(err.message, 'error'),
  })

  return (
    <section className="glass-card-flat p-5" data-testid="feishu-card">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-tesla/[0.12] text-tesla">
            <Link2 className="h-[18px] w-[18px]" />
          </div>
          <div>
            <h2 className="text-sm font-medium text-slate-100">飞书</h2>
            <p className="text-[11px] text-slate-400">应用消息推送渠道</p>
          </div>
        </div>
        {!channels ? (
          <span className="skeleton h-[26px] w-20 rounded-full" data-testid="feishu-status-loading" />
        ) : feishu && (
          <span
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${
              feishu.connected ? 'bg-emerald-400/10 text-emerald-400' : 'bg-white/[0.06] text-slate-400'
            }`}
            data-testid="feishu-status"
          >
            {feishu.connected ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
            {feishu.connected ? '已连接' : '未连接'}
            {feishu.lastEventAt && <span className="text-slate-500">· {timeAgo(feishu.lastEventAt)}</span>}
          </span>
        )}
      </div>

      <div className="space-y-3">
        <div>
          <label htmlFor="feishu-appid" className="mb-1.5 block text-xs font-medium text-slate-400">App ID</label>
          <input
            id="feishu-appid"
            className="input-dark"
            placeholder={feishu?.appAlias ?? 'cli_xxxxxxxxxxxx'}
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="feishu-secret" className="mb-1.5 block text-xs font-medium text-slate-400">App Secret</label>
          <input
            id="feishu-secret"
            type="password"
            className="input-dark"
            placeholder="已保存的 Secret 不会回传，留空则不修改"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
          />
        </div>
        <div className="flex gap-2.5 pt-1">
          <button
            className="btn-primary flex-1"
            onClick={() => save.mutate()}
            disabled={save.isPending || !appId.trim()}
            data-testid="feishu-save"
          >
            {save.isPending ? '连接中…' : '保存并连接'}
          </button>
          <button
            className="btn-ghost flex-1"
            onClick={() => test.mutate()}
            disabled={test.isPending || !feishu?.connected}
            data-testid="feishu-test"
          >
            <Send className="h-4 w-4" />
            发送测试消息
          </button>
        </div>
      </div>
    </section>
  )
}

export default function PushPage() {
  const { data: pushEnv } = useQuery({ queryKey: ['push-env'], queryFn: api.pushEnv })
  const [https, setHttps] = useState(false)
  useEffect(() => {
    if (pushEnv?.https != null) setHttps(pushEnv.https)
    else if (typeof window !== 'undefined') setHttps(window.isSecureContext || window.location.protocol === 'https:')
  }, [pushEnv])

  return (
    <div>
      <PageHeader icon={BellRing} title="推送" subtitle="Web Push / Telegram / 飞书 三渠道配置（事件开关在「设置 → 推送矩阵」）" />
      <div className="space-y-5">
        <WebPushCard https={https} />
        <TelegramCard />
        <FeishuCard />
      </div>
    </div>
  )
}
