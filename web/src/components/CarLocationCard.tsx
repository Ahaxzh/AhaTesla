import { lazy, Suspense } from 'react'
import type { DashboardData } from '@/types'

/**
 * 车辆位置地图卡（仿 TeslaMate 主页）：最新定位 + 状态胶囊 + 定位时间 + 外部地图深链。
 * leaflet 重组件随本卡懒加载（路由分割下不影响首屏）；无定位数据时整卡不渲染。
 */
const CarLocationMap = lazy(() => import('./CarLocationMap'))

export function CarLocationCard({ position, state }: { position: DashboardData['car']['position']; state: string }) {
  if (!position) return null
  return (
    <section className="glass-card fade-up relative overflow-hidden p-0" data-testid="car-location-card">
      <Suspense fallback={<div className="skeleton h-56 w-full" data-testid="car-location-fallback" />}>
        <CarLocationMap position={position} state={state} />
      </Suspense>
    </section>
  )
}
