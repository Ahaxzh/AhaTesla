import { lazy, Suspense } from 'react'
import type { DashboardData } from '@/types'

/**
 * 车辆位置地图（懒加载边界）：无壳裸地图，宿主（仪表盘合并卡）提供卡片容器与布局。
 * 无定位数据时返回 null —— 合并卡自动退化为纯信息卡。
 */
const CarLocationMap = lazy(() => import('./CarLocationMap'))

export function CarLocationCard({ position, state }: { position: DashboardData['car']['position']; state: string }) {
  if (!position) return null
  return (
    <Suspense fallback={<div className="skeleton h-full min-h-56 w-full" data-testid="car-location-fallback" />}>
      <CarLocationMap position={position} state={state} />
    </Suspense>
  )
}
