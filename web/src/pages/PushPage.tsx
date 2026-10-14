import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Calendar, CheckCircle2, Link2, Send, XCircle } from 'lucide-react'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { ToggleRow } from '@/components/Toggle'
import { useToast } from '@/components/Toast'
import { timeAgo } from '@/utils/format'
import type { PushRules } from '@/types'

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

export default function PushPage() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { data: channels } = useQuery({ queryKey: ['channels'], queryFn: api.channels })
  const { data: rules } = useQuery({ queryKey: ['push-rules'], queryFn: api.pushRules })

  const [localRules, setLocalRules] = useState<PushRules | null>(null)
  useEffect(() => {
    if (rules) setLocalRules(rules)
  }, [rules])

  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')

  const saveRules = useMutation({
    mutationFn: (next: PushRules) => api.setPushRules(next),
    onSuccess: (_data, next) => {
      setLocalRules(next)
      void queryClient.invalidateQueries({ queryKey: ['push-rules'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  const toggleRule = (key: keyof PushRules) => {
    if (!localRules) return
    const next = { ...localRules, [key]: !localRules[key] }
    setLocalRules(next) // 乐观更新
    saveRules.mutate(next)
  }

  const saveFeishu = useMutation({
    mutationFn: () => api.saveFeishu({ enabled: true, appId: appId.trim(), appSecret: appSecret.trim() || undefined }),
    onSuccess: (res) => {
      toast(res.connected ? '飞书连接成功' : '已保存，但连接未成功，请检查 AppID/Secret', res.connected ? 'success' : 'error')
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  const testFeishu = useMutation({
    mutationFn: () => api.testFeishu(),
    onSuccess: (res) => toast(res.message || '测试消息已发送', res.ok ? 'success' : 'error'),
    onError: (err) => toast(err.message, 'error'),
  })

  const feishu = channels?.feishu

  return (
    <div>
      <PageHeader icon={Bell} title="推送" subtitle="通知规则与飞书渠道" />

      {/* 推送规则开关组 */}
      <section className="glass-card mb-4 px-5 py-1" data-testid="push-rules">
        <h2 className="sr-only">推送规则</h2>
        {localRules ? (
          <>
            <ToggleRow
              title="行程结束通知"
              description="每次行程结束推送里程与电费摘要"
              checked={localRules.tripEnd}
              onChange={() => toggleRule('tripEnd')}
            />
            <div className="border-t border-white/[0.05]" />
            <ToggleRow
              title="充电开始通知"
              description="插入充电枪开始充电时提醒"
              checked={localRules.chargingStart}
              onChange={() => toggleRule('chargingStart')}
            />
            <div className="border-t border-white/[0.05]" />
            <ToggleRow
              title="充电结束通知"
              description="充电完成时推送补充电量与费用"
              checked={localRules.chargingDone}
              onChange={() => toggleRule('chargingDone')}
            />
            <div className="border-t border-white/[0.05]" />
            <ToggleRow
              title="周报"
              description="每周汇总里程 / 电费 / 能耗"
              checked={localRules.weeklyReport}
              onChange={() => toggleRule('weeklyReport')}
            />
            {localRules.weeklyReport && (
              <div className="flex items-center gap-2 pb-4 pt-1 pl-1">
                <Calendar className="h-3.5 w-3.5 text-slate-500" />
                <span className="text-xs text-slate-500">发送日：</span>
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAYS.map((d, i) => {
                    const day = i + 1
                    const active = localRules.weeklyReportDay === day
                    return (
                      <button
                        key={d}
                        onClick={() => {
                          const next = { ...localRules, weeklyReportDay: day }
                          setLocalRules(next)
                          saveRules.mutate(next)
                        }}
                        className={`rounded-lg px-2.5 py-1 text-xs transition ${
                          active ? 'bg-tesla font-medium text-white' : 'bg-white/[0.05] text-slate-400 hover:bg-white/[0.09]'
                        }`}
                        aria-pressed={active}
                      >
                        {d}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            <div className="border-t border-white/[0.05]" />
            <ToggleRow
              title="月报"
              description="每月 1 日推送上月完整账单"
              checked={localRules.monthlyReport}
              onChange={() => toggleRule('monthlyReport')}
            />
          </>
        ) : (
          <div className="space-y-3 py-4">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="skeleton h-4 w-36" />
                <div className="skeleton h-6 w-11 rounded-full" />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 飞书连接卡片 */}
      <section className="glass-card p-5" data-testid="feishu-card">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-tesla/12 text-tesla">
              <Link2 className="h-[18px] w-[18px]" />
            </div>
            <div>
              <h2 className="text-sm font-medium text-slate-100">飞书</h2>
              <p className="text-[11px] text-slate-500">应用消息推送渠道</p>
            </div>
          </div>
          {feishu && (
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
            <label htmlFor="feishu-appid" className="mb-1.5 block text-xs font-medium text-slate-400">
              App ID
            </label>
            <input
              id="feishu-appid"
              className="input-dark"
              placeholder={feishu?.appAlias ?? 'cli_xxxxxxxxxxxx'}
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="feishu-secret" className="mb-1.5 block text-xs font-medium text-slate-400">
              App Secret
            </label>
            <input
              id="feishu-secret"
              className="input-dark"
              type="password"
              placeholder="已保存的 Secret 不会回传，留空则不修改"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
            />
          </div>
          <div className="flex gap-2.5 pt-1">
            <button
              className="btn-primary flex-1"
              onClick={() => saveFeishu.mutate()}
              disabled={saveFeishu.isPending || !appId.trim()}
              data-testid="feishu-save"
            >
              {saveFeishu.isPending ? '连接中…' : '保存并连接'}
            </button>
            <button
              className="btn-ghost flex-1"
              onClick={() => testFeishu.mutate()}
              disabled={testFeishu.isPending || !feishu?.connected}
              data-testid="feishu-test"
            >
              <Send className="h-4 w-4" />
              {testFeishu.isPending ? '发送中…' : '发送测试消息'}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
