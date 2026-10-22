import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { FileBarChart, FileText, Play, TrendingDown } from 'lucide-react'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { useToast } from '@/components/Toast'
import { useI18n } from '@/i18n'
import { useCar } from '@/contexts/CarContext'
import { fmtCny, fmtDateTime, fmtKm } from '@/utils/format'

/** P5 报告页（/reports）：周报/月报卡片瀑布流 + 手动生成（调试） */
export default function ReportsPage() {
  const { currentCarId } = useCar()
  const { toast } = useToast()
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'all' | 'weekly' | 'monthly'>('all')
  const { data, isLoading } = useQuery({ queryKey: ['reports', currentCarId], queryFn: () => api.reports(currentCarId) })

  const generate = useMutation({
    mutationFn: (type: 'daily' | 'weekly' | 'monthly') => api.generateReport(type),
    onSuccess: (res, type) => {
      // 日报不落归档、送达即全部 → 逐通道汇报结果（排障时一眼看出挂在哪个渠道）
      if (type === 'daily' && res.results) {
        const CHANNEL_LABELS: Record<string, string> = { feishu: '飞书', telegram: 'Telegram', webpush: 'WebPush', wecom: '企微', ntfy: 'Ntfy', bark: 'Bark' }
        const parts = Object.entries(res.results).map(
          ([ch, r]) => `${CHANNEL_LABELS[ch] ?? ch} ${r.sent ? '✓' : '✗'}`,
        )
        const anySent = Object.values(res.results).some((r) => r.sent)
        toast(`${t('rep.toast.dailySent', '日报已推送')}${parts.length ? `：${parts.join(' · ')}` : ''}`, anySent ? 'success' : 'error')
      } else {
        toast(t('rep.toast.generated', '报告已生成'), 'success')
        void queryClient.invalidateQueries({ queryKey: ['reports'] })
      }
    },
    onError: (err) => toast(err.message, 'error'),
  })

  const items = (data?.items ?? []).filter((r) => tab === 'all' || r.type === tab)

  return (
    <div>
      <PageHeader icon={FileBarChart} title={t('rep.title', '报告')} subtitle={t('rep.subtitle', '周报与月报归档（推送失败不丢报告本体）')} />

      {/* 顶部：筛选 + 手动生成 */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1.5 rounded-xl bg-white/[0.04] p-1" role="tablist" data-testid="report-tabs">
          {([
            ['all', t('rep.tab.all', '全部')],
            ['weekly', t('rep.tab.weekly', '周报')],
            ['monthly', t('rep.tab.monthly', '月报')],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`rounded-xl px-3.5 py-1.5 text-xs transition ${
                tab === key ? 'bg-tesla font-medium text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            className="btn-ghost !px-3 !py-1.5 text-xs"
            onClick={() => generate.mutate('daily')}
            disabled={generate.isPending}
            data-testid="generate-daily"
          >
            <Play className="h-3.5 w-3.5" />
            {t('rep.gen.daily', '重发昨日日报')}
          </button>
          <button
            className="btn-ghost !px-3 !py-1.5 text-xs"
            onClick={() => generate.mutate('weekly')}
            disabled={generate.isPending}
            data-testid="generate-weekly"
          >
            <Play className="h-3.5 w-3.5" />
            {t('rep.gen.weekly', '生成本周周报')}
          </button>
          <button
            className="btn-ghost !px-3 !py-1.5 text-xs"
            onClick={() => generate.mutate('monthly')}
            disabled={generate.isPending}
            data-testid="generate-monthly"
          >
            <Play className="h-3.5 w-3.5" />
            {t('rep.gen.monthly', '生成本月月报')}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="skeleton h-24 rounded-2xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="glass-card-flat">
          <EmptyState
            icon={FileText}
            title={t('rep.empty.title', '暂无报告')}
            description={t('rep.empty.desc', '每周一上午自动生成周报，每月 1 日生成月报；也可手动生成')}
          />
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="report-list">
          {items.map((r) => (
            <li key={r.id}>
              <Link
                to={`/reports/${r.id}`}
                className="glass-card block p-5 transition hover:border-tesla/30"
                data-testid="report-item"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      r.type === 'weekly' ? 'bg-sky-400/10 text-sky-400' : 'bg-violet-400/10 text-violet-400'
                    }`}
                  >
                    {r.type === 'weekly' ? t('rep.badge.weekly', '周报') : t('rep.badge.monthly', '月报')}
                  </span>
                  <span className="num text-[10px] text-slate-400">{fmtDateTime(r.createdAt)}</span>
                </div>
                <div className="truncate text-sm font-medium text-slate-100">{r.periodLabel}</div>
                <div className="num mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
                  <span>{t('rep.kpi.km', '里程')} {fmtKm(r.distanceKm)} km</span>
                  <span>{t('rep.kpi.cost', '电费')} {fmtCny(r.totalCost)}</span>
                  {r.saved != null && (
                    <span className="flex items-center gap-0.5 text-emerald-400">
                      <TrendingDown className="h-3 w-3" />
                      {t('rep.saved', '省')} {fmtCny(Math.abs(r.saved))}
                    </span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
