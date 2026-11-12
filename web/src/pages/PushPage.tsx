import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, BellRing, CheckCircle2, Link2, Lock, MessageSquare, RefreshCw, Send, Smartphone, XCircle } from 'lucide-react'
import { api, subscribeWebPush } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { useToast } from '@/components/Toast'
import { useI18n } from '@/i18n'
import { timeAgo } from '@/utils/format'

/** PWA 环境探测:iOS Safari 判定(含 iPadOS 13+ 伪装 Mac 触点暴露)+ 是否已从主屏幕独立打开 */
function detectPwaEnv(): { isIOS: boolean; isStandalone: boolean } {
  if (typeof navigator === 'undefined') return { isIOS: false, isStandalone: false }
  const ua = navigator.userAgent || ''
  const maxTouchPoints = (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints ?? 0
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && maxTouchPoints > 1)
  const standaloneByDisplayMode =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches
  const standaloneByNavigator = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return { isIOS, isStandalone: standaloneByDisplayMode || standaloneByNavigator }
}

/** Web Push（US-11）：HTTPS 前置检测（AC-11.0 置灰）+ iOS 安装引导 + 订阅 + 自愈重订 + 测试 */
function WebPushCard({ https }: { https: boolean }) {
  const { toast } = useToast()
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data: channels } = useQuery({ queryKey: ['channels'], queryFn: api.channelStatus })
  const webpush = channels?.webpush

  // iOS PWA 推送要求 ≥16.4 且从主屏幕打开;权限被拒后需到系统设置恢复
  const [pwaEnv] = useState(detectPwaEnv)
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  )

  /** 订阅本设备并上报(手动开启与静默自愈共用；与向导 Step4 共享实现) */
  const subscribeDevice = subscribeWebPush

  const enablePush = useMutation({
    mutationFn: subscribeDevice,
    onSuccess: () => {
      toast(t('push.webpush.enabled.toast', 'Web Push 已开启，本设备将收到通知'), 'success')
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: (err) => toast(err.message, 'error'),
    // 用户在浏览器弹窗点了"阻止"后 Notification.permission 已变 —— 同步刷新，
    // 立即展示"去系统设置恢复"引导（此前要刷新页面才出现）
    onSettled: () => {
      if (typeof Notification !== 'undefined') setPermission(Notification.permission)
    },
  })

  // 静默自愈:权限已授予但本地订阅缺失/过期(浏览器会淘汰旧订阅)时自动重订,不打扰用户
  const resubscribe = useMutation({
    mutationFn: subscribeDevice,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: () => {
      /* 静默:自愈失败留待用户手动开启时兜底 */
    },
  })

  useEffect(() => {
    if (!https || permission !== 'granted') return
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    let cancelled = false
    void (async () => {
      try {
        const reg = await navigator.serviceWorker.ready
        const sub = await reg.pushManager.getSubscription()
        const expired = sub?.expirationTime != null && sub.expirationTime < Date.now()
        if (!cancelled && (!sub || expired)) resubscribe.mutate()
      } catch (e) {
        /* 静默 */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [https, permission])

  const test = useMutation({
    mutationFn: api.webpushTest,
    onSuccess: () => toast(t('push.webpush.test.sent', '测试通知已发送'), 'success'),
    onError: (err) => toast(err.message, 'error'),
  })

  // AC-11.0：仅按 HTTPS 判定置灰（订阅失败由 mutation 错误提示兜底）
  const disabled = !https
  // iOS 未安装到主屏幕时无法授权通知(订阅按钮禁用,给安装引导)
  const iosNeedsInstall = pwaEnv.isIOS && !pwaEnv.isStandalone
  const permissionDenied = permission === 'denied'
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
            <p className="text-[11px] text-slate-400">{t('push.webpush.tagline', '默认推送渠道 · 零第三方依赖')}</p>
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
            {subscriberCount > 0 ? `${subscriberCount} ${t('push.devicesSuffix', '台设备')}` : t('push.notSubscribed', '未订阅')}
          </span>
        )}
      </div>

      {disabled ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-3.5 text-xs leading-5 text-amber-400" data-testid="webpush-https-warning">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" />
          {t('push.webpush.https', '当前为非 HTTPS 环境，Web Push 不可用。建议配置反代启用 HTTPS，或优先绑定 Telegram / 飞书。')}
        </div>
      ) : iosNeedsInstall ? (
        /* iOS Safari 未安装到主屏幕:16.4+ 才支持 PWA 推送,且必须从主屏打开才能授权 */
        <div data-testid="webpush-ios-install-guide" className="space-y-3">
          <div className="rounded-xl border border-sky-400/20 bg-sky-400/[0.06] p-3.5 text-xs leading-6 text-slate-300">
            <div className="mb-1 font-medium text-sky-400">{t('push.ios.title', '📱 先把 AhaTesla 安装到主屏幕（iOS 16.4+）')}</div>
            <ol className="list-decimal space-y-0.5 pl-5">
              <li>{t('push.ios.step1', '点 Safari 底部「分享」按钮')}</li>
              <li>{t('push.ios.step2', '选「添加到主屏幕」')}</li>
              <li>{t('push.ios.step3', '从主屏幕图标打开 AhaTesla，再回到这里开启通知')}</li>
            </ol>
          </div>
          <button className="btn-primary w-full" disabled data-testid="webpush-enable">
            <Bell className="h-4 w-4" />
            {t('push.ios.button', '安装到主屏幕后可开启')}
          </button>
        </div>
      ) : permissionDenied ? (
        /* 权限曾被拒绝:浏览器页面内无法再弹窗,必须去系统/站点设置恢复 */
        <div className="space-y-3" data-testid="webpush-permission-denied">
          <div className="flex items-start gap-2.5 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-3.5 text-xs leading-6 text-amber-400">
            <Bell className="mt-0.5 h-4 w-4 shrink-0" />
            {pwaEnv.isIOS ? (
              <span>
                {t('push.denied.ios', '通知权限已被拒绝。请到 系统设置 → 通知 → AhaTesla 打开「允许通知」，然后回到这里重新检测。')}
              </span>
            ) : (
              <span>
                {t('push.denied.desktop', '通知权限已被拒绝。请在浏览器地址栏左侧的站点设置中把通知改为「允许」，然后回到这里重新检测。')}
              </span>
            )}
          </div>
          <button
            className="btn-ghost w-full"
            onClick={() => setPermission(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported')}
            data-testid="webpush-permission-recheck"
          >
            <RefreshCw className="h-4 w-4" />
            {t('push.denied.recheck', '我已开启，重新检测')}
          </button>
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
            {enablePush.isPending ? t('push.webpush.enabling', '开启中…') : subscriberCount > 0 ? t('push.webpush.resub', '重新订阅本设备') : t('push.webpush.enable', '一键开启 Web Push')}
          </button>
          <button
            className="btn-ghost flex-1"
            onClick={() => test.mutate()}
            disabled={test.isPending || subscriberCount === 0}
            data-testid="webpush-test"
          >
            <Send className="h-4 w-4" />
            {t('push.testMsg', '发送测试消息')}
          </button>
        </div>
      )}
    </section>
  )
}

/** Telegram（US-10）：Token/ChatID 密文存储 + 连通性测试 */
function TelegramCard() {
  const { toast } = useToast()
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data: channels } = useQuery({ queryKey: ['channels'], queryFn: api.channelStatus })
  const telegram = channels?.telegram
  const [botToken, setBotToken] = useState('')
  const [chatId, setChatId] = useState('')

  const save = useMutation({
    mutationFn: () => api.saveTelegram({ enabled: true, botToken: botToken.trim() || undefined, chatId: chatId.trim() || undefined }),
    onSuccess: (res) => {
      toast(res.connected ? t('push.tg.connected', 'Telegram 已连接') : t('push.tg.savedUnconnected', '已保存，但连接未成功，请检查 Token/ChatID'), res.connected ? 'success' : 'error')
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  const test = useMutation({
    mutationFn: api.testTelegram,
    onSuccess: () => toast(t('push.tg.test.sent', '测试消息已发送'), 'success'),
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
            <p className="text-[11px] text-slate-400">{t('push.tg.tagline', '@BotFather 创建 Bot 取 Token → @userinfobot 取 ChatID')}</p>
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
            {telegram.connected ? t('push.connected', '已连接') : t('push.notConnected', '未连接')}
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
            placeholder={telegram?.botAlias ? t('push.savedKeep', '已保存（{alias}…），留空则不修改').replace('{alias}', telegram.botAlias) : '123456789:AAF…'}
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
            placeholder={telegram?.chatIdAlias ? t('push.saved', '已保存（{alias}…）').replace('{alias}', telegram.chatIdAlias) : '123456789'}
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
            {save.isPending ? t('push.connecting', '连接中…') : t('push.saveConn', '保存并连接')}
          </button>
          <button
            className="btn-ghost flex-1"
            onClick={() => test.mutate()}
            disabled={test.isPending || !telegram?.connected}
            data-testid="telegram-test"
          >
            <Send className="h-4 w-4" />
            {t('push.testMsg', '发送测试消息')}
          </button>
        </div>
      </div>
    </section>
  )
}

/** 飞书（保留既有实现直连） */
function FeishuCard() {
  const { toast } = useToast()
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data: channels } = useQuery({ queryKey: ['channels'], queryFn: api.channelStatus })
  const feishu = channels?.feishu
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')

  const save = useMutation({
    mutationFn: () => api.saveFeishu({ enabled: true, appId: appId.trim(), appSecret: appSecret.trim() || undefined }),
    onSuccess: (res) => {
      toast(res.connected ? t('push.feishu.connected', '飞书连接成功') : t('push.feishu.savedUnconnected', '已保存，但连接未成功，请检查 AppID/Secret'), res.connected ? 'success' : 'error')
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  const test = useMutation({
    mutationFn: api.testFeishu,
    onSuccess: (res) => toast(res.message || t('push.test.fallback', '测试消息已发送'), 'success'),
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
            <h2 className="text-sm font-medium text-slate-100">{t('push.ch.feishu', '飞书')}</h2>
            <p className="text-[11px] text-slate-400">{t('push.feishu.tagline', '应用消息推送渠道')}</p>
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
            {feishu.connected ? t('push.connected', '已连接') : t('push.notConnected', '未连接')}
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
            placeholder={t('push.secretKeep', '已保存的 Secret 不会回传，留空则不修改')}
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
            {save.isPending ? t('push.connecting', '连接中…') : t('push.saveConn', '保存并连接')}
          </button>
          <button
            className="btn-ghost flex-1"
            onClick={() => test.mutate()}
            disabled={test.isPending || !feishu?.connected}
            data-testid="feishu-test"
          >
            <Send className="h-4 w-4" />
            {t('push.testMsg', '发送测试消息')}
          </button>
        </div>
      </div>
    </section>
  )
}

/** 渠道卡头部:图标 + 名称 + 定位语 + 已配置/未配置徽标(m4b 三渠道共用骨架) */
function ChannelCardHeader({ icon: Icon, name, tagline, configured, testid }: {
  icon: typeof Bell
  name: string
  tagline: string
  configured: boolean | undefined
  testid: string
}) {
  const { t } = useI18n()
  return (
    <div className="mb-4 flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-tesla/[0.12] text-tesla">
          <Icon className="h-[18px] w-[18px]" />
        </div>
        <div>
          <h2 className="text-sm font-medium text-slate-100">{name}</h2>
          <p className="text-[11px] text-slate-400">{tagline}</p>
        </div>
      </div>
      {configured != null && (
        <span
          className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${
            configured ? 'bg-emerald-400/10 text-emerald-400' : 'bg-white/[0.06] text-slate-400'
          }`}
          data-testid={testid}
        >
          {configured ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
          {configured ? t('push.configured', '已配置') : t('push.notConfigured', '未配置')}
        </span>
      )}
    </div>
  )
}

/** 企业微信(m4b):群机器人 webhook Key,密文存储 */
function WecomCard() {
  const { toast } = useToast()
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data: channels } = useQuery({ queryKey: ['channels'], queryFn: api.channelStatus })
  const wecom = channels?.wecom
  const [webhookKey, setWebhookKey] = useState('')

  const save = useMutation({
    mutationFn: () => api.saveWecom({ enabled: true, webhookKey: webhookKey.trim() || undefined }),
    onSuccess: () => {
      toast(t('push.wecom.saved', '企业微信配置已保存'), 'success')
      setWebhookKey('')
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  const test = useMutation({
    mutationFn: api.testWecom,
    onSuccess: (res) => toast(res.message || t('push.test.fallback', '测试消息已发送'), 'success'),
    onError: (err) => toast(err.message, 'error'),
  })

  return (
    <section className="glass-card-flat p-5" data-testid="wecom-card">
      <ChannelCardHeader icon={MessageSquare} name="企业微信" tagline={t('push.wecom.tagline', '群机器人 webhook,适合团队/家庭群')} configured={wecom == null ? undefined : wecom.configured} testid="wecom-status" />
      <div className="space-y-3">
        <div>
          <label htmlFor="wecom-key" className="mb-1.5 block text-xs font-medium text-slate-400">Webhook Key</label>
          <input
            id="wecom-key"
            type="password"
            className="input-dark"
            placeholder={wecom?.webhookKeyAlias ? t('push.savedKeep', '已保存（{alias}…），留空则不修改').replace('{alias}', wecom.webhookKeyAlias) : t('push.wecom.keyPh', '群机器人 webhook 地址中 key= 后面的部分')}
            value={webhookKey}
            onChange={(e) => setWebhookKey(e.target.value)}
            data-testid="wecom-key"
          />
        </div>
        <div className="flex gap-2.5 pt-1">
          <button
            className="btn-primary flex-1"
            onClick={() => save.mutate()}
            disabled={save.isPending || (!webhookKey.trim() && !wecom?.configured)}
            data-testid="wecom-save"
          >
            {save.isPending ? t('push.saving', '保存中…') : t('push.saveCfg', '保存配置')}
          </button>
          <button
            className="btn-ghost flex-1"
            onClick={() => test.mutate()}
            disabled={test.isPending || !wecom?.configured}
            data-testid="wecom-test"
          >
            <Send className="h-4 w-4" />
            {t('push.testMsg', '发送测试消息')}
          </button>
        </div>
      </div>
    </section>
  )
}

/** ntfy(m4b):开源推送服务,server URL + topic,无密钥,可自建 */
function NtfyCard() {
  const { toast } = useToast()
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data: channels } = useQuery({ queryKey: ['channels'], queryFn: api.channelStatus })
  const ntfy = channels?.ntfy
  const [serverUrl, setServerUrl] = useState('')
  const [topic, setTopic] = useState('')

  const save = useMutation({
    mutationFn: () => api.saveNtfy({ enabled: true, serverUrl: serverUrl.trim() || undefined, topic: topic.trim() || undefined }),
    onSuccess: () => {
      toast(t('push.ntfy.saved', 'ntfy 配置已保存'), 'success')
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  const test = useMutation({
    mutationFn: api.testNtfy,
    onSuccess: (res) => toast(res.message || t('push.test.fallback', '测试消息已发送'), 'success'),
    onError: (err) => toast(err.message, 'error'),
  })

  return (
    <section className="glass-card-flat p-5" data-testid="ntfy-card">
      <ChannelCardHeader icon={Bell} name="ntfy" tagline={t('push.ntfy.tagline', '开源推送服务,支持自建')} configured={ntfy == null ? undefined : ntfy.configured} testid="ntfy-status" />
      <div className="space-y-3">
        <div>
          <label htmlFor="ntfy-server" className="mb-1.5 block text-xs font-medium text-slate-400">Server URL</label>
          <input
            id="ntfy-server"
            className="input-dark"
            placeholder={ntfy?.serverUrl || 'https://ntfy.sh'}
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            data-testid="ntfy-server"
          />
        </div>
        <div>
          <label htmlFor="ntfy-topic" className="mb-1.5 block text-xs font-medium text-slate-400">Topic</label>
          <input
            id="ntfy-topic"
            className="input-dark"
            placeholder={ntfy?.topic || 'ahatesla'}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            data-testid="ntfy-topic"
          />
        </div>
        <div className="flex gap-2.5 pt-1">
          <button
            className="btn-primary flex-1"
            onClick={() => save.mutate()}
            disabled={save.isPending || (!serverUrl.trim() && !topic.trim() && !ntfy?.configured)}
            data-testid="ntfy-save"
          >
            {save.isPending ? t('push.saving', '保存中…') : t('push.saveCfg', '保存配置')}
          </button>
          <button
            className="btn-ghost flex-1"
            onClick={() => test.mutate()}
            disabled={test.isPending || !ntfy?.configured}
            data-testid="ntfy-test"
          >
            <Send className="h-4 w-4" />
            {t('push.testMsg', '发送测试消息')}
          </button>
        </div>
      </div>
    </section>
  )
}

/** Bark(m4b):iOS Bark App 专用,server URL + device key */
function BarkCard() {
  const { toast } = useToast()
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data: channels } = useQuery({ queryKey: ['channels'], queryFn: api.channelStatus })
  const bark = channels?.bark
  const [serverUrl, setServerUrl] = useState('')
  const [deviceKey, setDeviceKey] = useState('')

  const save = useMutation({
    mutationFn: () => api.saveBark({ enabled: true, serverUrl: serverUrl.trim() || undefined, deviceKey: deviceKey.trim() || undefined }),
    onSuccess: () => {
      toast(t('push.bark.saved', 'Bark 配置已保存'), 'success')
      setDeviceKey('')
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  const test = useMutation({
    mutationFn: api.testBark,
    onSuccess: (res) => toast(res.message || t('push.test.fallback', '测试消息已发送'), 'success'),
    onError: (err) => toast(err.message, 'error'),
  })

  return (
    <section className="glass-card-flat p-5" data-testid="bark-card">
      <ChannelCardHeader icon={Smartphone} name="Bark" tagline={t('push.bark.tagline', 'iOS Bark App 专用')} configured={bark == null ? undefined : bark.configured} testid="bark-status" />
      <div className="space-y-3">
        <div>
          <label htmlFor="bark-server" className="mb-1.5 block text-xs font-medium text-slate-400">Server URL</label>
          <input
            id="bark-server"
            className="input-dark"
            placeholder={bark?.serverUrl || 'https://api.day.app'}
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            data-testid="bark-server"
          />
        </div>
        <div>
          <label htmlFor="bark-key" className="mb-1.5 block text-xs font-medium text-slate-400">Device Key</label>
          <input
            id="bark-key"
            type="password"
            className="input-dark"
            placeholder={bark?.deviceKeyAlias ? t('push.savedKeep', '已保存（{alias}…），留空则不修改').replace('{alias}', bark.deviceKeyAlias) : t('push.bark.keyPh', 'Bark App 里复制的关键字符串')}
            value={deviceKey}
            onChange={(e) => setDeviceKey(e.target.value)}
            data-testid="bark-key"
          />
        </div>
        <div className="flex gap-2.5 pt-1">
          <button
            className="btn-primary flex-1"
            onClick={() => save.mutate()}
            disabled={save.isPending || (!serverUrl.trim() && !deviceKey.trim() && !bark?.configured)}
            data-testid="bark-save"
          >
            {save.isPending ? t('push.saving', '保存中…') : t('push.saveCfg', '保存配置')}
          </button>
          <button
            className="btn-ghost flex-1"
            onClick={() => test.mutate()}
            disabled={test.isPending || !bark?.configured}
            data-testid="bark-test"
          >
            <Send className="h-4 w-4" />
            {t('push.testMsg', '发送测试消息')}
          </button>
        </div>
      </div>
    </section>
  )
}

export default function PushPage() {
  const { t } = useI18n()
  const { data: pushEnv } = useQuery({ queryKey: ['push-env'], queryFn: api.pushEnv })
  const [https, setHttps] = useState(false)
  useEffect(() => {
    if (pushEnv?.https != null) setHttps(pushEnv.https)
    else if (typeof window !== 'undefined') setHttps(window.isSecureContext || window.location.protocol === 'https:')
  }, [pushEnv])

  return (
    <div>
      <PageHeader icon={BellRing} title={t('push.page.title', '推送')} subtitle={t('push.page.subtitle', 'Web Push / Telegram / 飞书 / 企业微信 / ntfy / Bark 六渠道配置（事件开关在「设置 → 推送矩阵」）')} />
      <div className="space-y-5">
        <WebPushCard https={https} />
        <TelegramCard />
        <FeishuCard />
        <WecomCard />
        <NtfyCard />
        <BarkCard />
      </div>
    </div>
  )
}
