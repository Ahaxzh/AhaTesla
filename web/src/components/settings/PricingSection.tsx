/**
 * 电价设置分区（v2.2 从独立「电价」页并入设置页）。
 * 内容：默认电价 · 地点单价表（teslamate geofences）· 费率变更历史
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Database, History, Save } from 'lucide-react'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { useToast } from '@/components/Toast'
import { fmtDateTime } from '@/utils/format'

export function PricingSection() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { data, isLoading } = useQuery({ queryKey: ['pricing'], queryFn: api.pricing })
  const { data: history } = useQuery({ queryKey: ['pricing-history'], queryFn: api.pricingHistory })

  const [rate, setRate] = useState('')

  useEffect(() => {
    if (data) setRate(String(data.defaultRateCnyPerKwh))
  }, [data])

  const saveMutation = useMutation({
    mutationFn: (value: number) => api.setDefaultRate(value),
    onSuccess: () => {
      toast('默认电价已保存', 'success')
      void queryClient.invalidateQueries({ queryKey: ['pricing'] })
      void queryClient.invalidateQueries({ queryKey: ['pricing-history'] })
    },
    onError: (err) => toast(err.message, 'error'),
  })

  const onSave = () => {
    const value = Number.parseFloat(rate)
    if (!rate.trim() || Number.isNaN(value) || value <= 0 || value > 10) {
      toast('请输入 0~10 之间的有效电价（元/kWh）', 'error')
      return
    }
    saveMutation.mutate(value)
  }

  return (
    <div className="space-y-5">
      {/* 默认价编辑 */}
      <div data-testid="default-rate-card">
        <h3 className="text-xs font-medium text-slate-300">默认电价</h3>
        <p className="section-desc mt-1">充电记录无地点单价时按此价格计费，变更只影响之后的新行程。</p>
        <div className="mt-3 flex max-w-sm items-center gap-3">
          <div className="relative flex-1">
            <input
              id="default-rate"
              type="number"
              step="0.01"
              min="0"
              max="10"
              inputMode="decimal"
              className="input-dark num pr-16"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              placeholder="0.00"
              aria-label="默认电价（元每千瓦时）"
              disabled={isLoading}
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-500">
              元/kWh
            </span>
          </div>
          <button
            className="btn-primary shrink-0"
            onClick={onSave}
            disabled={saveMutation.isPending || isLoading || !data}
            data-testid="save-rate"
          >
            <Save className="h-4 w-4" />
            {saveMutation.isPending ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      {/* 地点单价表 */}
      <div className="overflow-hidden rounded-xl border border-white/[0.06]" data-testid="location-table">
        <div className="flex items-center gap-2 px-4 py-3">
          <Database className="h-4 w-4 text-tesla" />
          <span className="text-xs font-medium text-slate-200">地点单价</span>
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] text-slate-400">
            teslamate geofences
          </span>
        </div>
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="skeleton h-10" />
            ))}
          </div>
        ) : !data || data.locations.length === 0 ? (
          <EmptyState icon={Database} title="暂无地点单价" description="在 TeslaMate 中配置 geofence 电价后会自动同步" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-white/[0.06] bg-white/[0.02] text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2.5 font-medium">地点</th>
                  <th className="px-4 py-2.5 text-right font-medium">单价 (元/kWh)</th>
                  <th className="px-4 py-2.5 text-right font-medium">服务费</th>
                  <th className="px-4 py-2.5 font-medium">计费方式</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {data.locations.map((loc) => (
                  <tr key={loc.id} className="transition hover:bg-white/[0.02]">
                    <td className="max-w-[220px] truncate px-4 py-2.5 text-slate-200">{loc.name}</td>
                    <td className="num px-4 py-2.5 text-right font-medium text-white">
                      {loc.pricePerUnit != null ? `¥${loc.pricePerUnit.toFixed(2)}` : '--'}
                    </td>
                    <td className="num px-4 py-2.5 text-right text-slate-400">
                      {loc.sessionFee != null ? `¥${loc.sessionFee.toFixed(2)}` : '--'}
                    </td>
                    <td className="px-4 py-2.5 text-slate-400">{loc.billingType}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 变更历史 */}
      <div data-testid="rate-history">
        <div className="mb-2 flex items-center gap-2">
          <History className="h-4 w-4 text-tesla" />
          <span className="text-xs font-medium text-slate-300">费率变更历史</span>
        </div>
        {!history || history.length === 0 ? (
          <p className="py-3 text-xs text-slate-500">暂无变更记录</p>
        ) : (
          <ul className="divide-y divide-white/[0.04] rounded-xl border border-white/[0.06] px-4">
            {history.map((h, i) => (
              <li key={i} className="flex items-center justify-between gap-3 py-2.5 text-xs">
                <span className="num text-slate-400">{fmtDateTime(h.changedAt)}</span>
                <span className="num text-slate-300">
                  ¥{h.from.toFixed(2)} <span className="text-slate-600">→</span>{' '}
                  <span className="font-medium text-tesla">¥{h.to.toFixed(2)}</span>
                </span>
                <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] text-slate-500">{h.source}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
