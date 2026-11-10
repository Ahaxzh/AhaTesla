import { useEffect, useRef } from 'react'
import { MapPin, Navigation } from 'lucide-react'
import { useI18n } from '@/i18n'
import type { DashboardData } from '@/types'

/** TeslaMate 风格车头朝向箭头（SVG）：红色箭身 + 白描边，随 headingDeg 旋转。
 *  无朝向数据（仅一个定位点）时固定朝上。 */
function headingArrowIcon(leaflet: any, headingDeg: number | null | undefined) {
  const rotate = headingDeg != null ? `transform: rotate(${headingDeg}deg)` : ''
  return leaflet.divIcon({
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: `<div style="${rotate};width:28px;height:28px;display:flex;align-items:center;justify-content:center">
      <svg width="28" height="28" viewBox="0 0 28 28">
        <circle cx="14" cy="14" r="13" fill="rgba(11,15,20,0.55)"/>
        <path d="M14 5.5 L19 20 L14 16.8 L9 20 Z" fill="#e82127" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/>
      </svg>
    </div>`,
  })
}

/** 迷你地图实现（经 CarLocationCard 懒加载）：高德标准瓦片 + WGS84→GCJ02 纠偏 + 朝向箭头。 */
export default function CarLocationMap({ position, state }: { position: NonNullable<DashboardData['car']['position']>; state: string }) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let map: any = null
    let cancelled = false
    ;(async () => {
      const leaflet = (await import('leaflet')).default
      await import('leaflet/dist/leaflet.css')
      const { wgs84ToGcj02 } = await import('./RouteMap')
      if (cancelled || !ref.current) return
      const [lat, lng] = wgs84ToGcj02(position.lat, position.lng)
      map = leaflet.map(ref.current, {
        zoomControl: false,
        attributionControl: false,
        dragging: true,
        scrollWheelZoom: false, // 页内滚动不被地图劫持；双指/双击缩放仍可用
      })
      leaflet
        .tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
          subdomains: ['1', '2', '3', '4'],
          maxZoom: 18,
        })
        .addTo(map)
      leaflet.marker([lat, lng], { icon: headingArrowIcon(leaflet, position.headingDeg) }).addTo(map)
      map.setView([lat, lng], 15)
    })()
    return () => {
      cancelled = true
      map?.remove()
    }
  }, [position.lat, position.lng, position.headingDeg])

  const stateLabel =
    state === 'charging' ? t('car.state.charging', '充电中')
    : state === 'driving' ? t('car.state.driving', '行驶中')
    : state === 'online' ? t('car.state.online', '在线')
    : state === 'asleep' ? t('car.state.asleep', '休眠')
    : state === 'offline' ? t('car.state.offline', '离线')
    : t('car.state.parked', '驻车')

  const fixTime = position.at ? new Date(position.at).toLocaleString() : ''

  return (
    <div className="relative h-full min-h-56 w-full" data-testid="car-location-card">
      <div ref={ref} className="h-full min-h-56 w-full" data-testid="car-location-map" />
      {/* 信息浮层：左下状态 + 定位时间；右下外部地图深链 */}
      <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded-xl border border-white/10 bg-base-900/80 px-3 py-1.5 text-xs text-slate-200 backdrop-blur">
        <MapPin className="h-3.5 w-3.5 text-tesla" />
        <span data-testid="car-location-state">{stateLabel}</span>
        {fixTime && <span className="text-slate-400">· {fixTime}</span>}
      </div>
      <a
        href={`https://maps.apple.com/?ll=${position.lat},${position.lng}&q=Tesla`}
        target="_blank"
        rel="noreferrer"
        className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-xl border border-white/10 bg-base-900/80 px-3 py-1.5 text-xs text-slate-200 backdrop-blur transition hover:text-white"
        data-testid="car-location-open"
        title={t('dashboard.location.open', '在地图应用中打开')}
      >
        <Navigation className="h-3.5 w-3.5" />
        {t('dashboard.location.open', '打开')}
      </a>
    </div>
  )
}
