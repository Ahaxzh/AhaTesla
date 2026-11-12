import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { TriangleAlert } from 'lucide-react'
import { api } from '@/api/client'
import { useI18n } from '@/i18n'

/**
 * GA-32 / AC-5.2：全站数据源失联横幅。
 * 轮询匿名 /api/system/health-lite（30s）；dbOk=false 时常驻黄/红横幅。
 * 挂在 AppLayout 顶部，全页面可见。
 */
export function HealthBanner() {
  const { t } = useI18n()
  const { data } = useQuery({
    queryKey: ['health-lite'],
    queryFn: api.healthLite,
    refetchInterval: 30_000,
    retry: false,
  })

  if (!data || data.dbOk) return null

  const isError = data.bannerLevel === 'error'
  const outageMin = Math.floor(data.outageMs / 60_000)

  return (
    <div
      role="alert"
      data-testid="health-banner"
      data-level={data.bannerLevel}
      className={`sticky top-0 z-40 flex items-center justify-center gap-2 px-4 py-2 text-center text-xs font-medium ${
        isError ? 'bg-red-500/90 text-white' : 'bg-amber-400/90 text-amber-950'
      }`}
    >
      <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
      <span>
        {t('health.bannerText', 'TeslaMate 数据库连接中断，当前展示离线缓存数据')}
        {outageMin >= 1 && (
          <span className="opacity-80">
            （{t('health.outageFor', '已失联 {n} 分钟').replace('{n}', String(outageMin))}）
          </span>
        )}
      </span>
      <Link to="/settings#settings-system" className="ml-1 shrink-0 underline underline-offset-2">
        {t('health.check', '检查连接')}
      </Link>
    </div>
  )
}
