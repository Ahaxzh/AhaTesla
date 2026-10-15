import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

/** 速度→颜色映射（km/h）：0 蓝 → 40 青 → 70 绿 → 100 黄 → 130+ 红 */
function speedColor(kmh: number | null | undefined): string {
  if (kmh == null || !Number.isFinite(kmh)) return '#64748B'
  const stops: Array<[number, [number, number, number]]> = [
    [0, [56, 130, 246]],   // 蓝
    [40, [34, 211, 238]],  // 青
    [70, [52, 211, 153]],  // 绿
    [100, [250, 204, 21]], // 黄
    [130, [239, 68, 68]],  // 红
  ]
  if (kmh <= 0) return 'rgb(56,130,246)'
  if (kmh >= 130) return 'rgb(239,68,68)'
  for (let i = 0; i < stops.length - 1; i++) {
    const [s0, c0] = stops[i]
    const [s1, c1] = stops[i + 1]
    if (kmh >= s0 && kmh <= s1) {
      const t = (kmh - s0) / (s1 - s0)
      const c = c0.map((v, j) => Math.round(v + (c1[j] - v) * t))
      return `rgb(${c[0]},${c[1]},${c[2]})`
    }
  }
  return 'rgb(239,68,68)'
}

// ---- WGS84 → GCJ02（国测局加密坐标）----
// 高德底图为 GCJ02 坐标系；TeslaMate 存 WGS84。不纠偏轨迹会整体偏移几百米（不贴路）。
function outsideChina(lat: number, lng: number) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}
function transformLat(x: number, y: number) {
  let v = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  v += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  v += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3
  v += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3
  return v
}
function transformLng(x: number, y: number) {
  let v = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  v += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  v += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3
  v += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x * Math.PI) / 30)) * 2) / 3
  return v
}
export function wgs84ToGcj02(lat: number, lng: number): [number, number] {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || outsideChina(lat, lng)) return [lat, lng]
  const a = 6378245.0
  const ee = 0.00669342162296594323
  let dLat = transformLat(lng - 105, lat - 35)
  let dLng = transformLng(lng - 105, lat - 35)
  const radLat = (lat / 180) * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - ee * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI)
  dLng = (dLng * 180) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI)
  return [lat + dLat, lng + dLng]
}

type RoutePoint = { lat: number; lng: number; t?: string; speed?: number | null } | [number, number]

/**
 * 行程路线图：Leaflet + 高德底图（国内直连快，GCJ02 纠偏贴路），
 * 轨迹按速度分段着色（蓝→青→绿→黄→红），起终点标记，悬停提示速度。
 * 瓦片由浏览器从高德 CDN 拉取（仅底图网格坐标，不含轨迹数据，无上传）。
 */
export function RouteMap({
  points,
  height = 340,
  showSpeedLegend = true,
}: {
  points: RoutePoint[]
  height?: number
  showSpeedLegend?: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const [hover, setHover] = useState<{ speed: number | null } | null>(null)
  const [satellite, setSatellite] = useState(false)
  const tileRef = useRef<L.TileLayer | null>(null)

  // 兼容 [lng,lat][] 与 {lat,lng,speed} 两种格式；统一转 GCJ02 贴高德路网
  const pts = (points || [])
    .map((p): { lng: number; lat: number; speed: number | null } =>
      Array.isArray(p)
        ? { lng: p[0], lat: p[1], speed: null }
        : { lng: Number(p.lng), lat: Number(p.lat), speed: p.speed != null ? Number(p.speed) : null },
    )
    .filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat))
    .map((p) => {
      const [lat, lng] = wgs84ToGcj02(p.lat, p.lng)
      return { ...p, lat, lng }
    })

  // 初始化地图（一次）
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: false, // 高德要求署名，放图例栏文字标注
      preferCanvas: true,
    })
    const std = L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
      subdomains: ['1', '2', '3', '4'],
      maxZoom: 18,
    })
    std.addTo(map)
    tileRef.current = std
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      layerRef.current = null
      tileRef.current = null
    }
  }, [])

  // 图层切换（标准 / 卫星）
  useEffect(() => {
    const map = mapRef.current
    if (!map || !tileRef.current) return
    if (satellite) {
      map.removeLayer(tileRef.current)
      tileRef.current = L.tileLayer(
        'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
        { subdomains: ['1', '2', '3', '4'], maxZoom: 18 },
      ).addTo(map)
    } else {
      map.removeLayer(tileRef.current)
      tileRef.current = L.tileLayer(
        'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
        { subdomains: ['1', '2', '3', '4'], maxZoom: 18 },
      ).addTo(map)
    }
  }, [satellite])

  // 数据变化时重画轨迹
  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()
    if (pts.length < 2) return

    const hasSpeed = pts.some((p) => p.speed != null)

    // 白色描边底（让轨迹在浅色底图上也清晰）
    L.polyline(
      pts.map((p) => [p.lat, p.lng]),
      { color: 'rgba(255,255,255,0.9)', weight: 8, opacity: 0.9, lineCap: 'round', lineJoin: 'round' },
    ).addTo(layer)

    // 速度分段 polyline
    if (hasSpeed) {
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i]
        const q = pts[i + 1]
        const sp = p.speed != null ? p.speed : q.speed
        L.polyline(
          [
            [p.lat, p.lng],
            [q.lat, q.lng],
          ],
          { color: speedColor(sp), weight: 5, opacity: 1, lineCap: 'round' },
        )
          .on('mouseover', () => setHover({ speed: sp }))
          .on('mouseout', () => setHover(null))
          .addTo(layer)
      }
    } else {
      L.polyline(
        pts.map((p) => [p.lat, p.lng]),
        { color: '#E82127', weight: 5, opacity: 1, lineCap: 'round' },
      ).addTo(layer)
    }

    // 起终点标记
    const startIcon = L.divIcon({
      className: '',
      html: '<div style="width:14px;height:14px;border-radius:50%;background:#fff;border:3px solid #34D399;box-shadow:0 0 6px rgba(0,0,0,.4)"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    })
    const endIcon = L.divIcon({
      className: '',
      html: '<div style="width:14px;height:14px;border-radius:50%;background:#fff;border:3px solid #E82127;box-shadow:0 0 6px rgba(0,0,0,.4)"><div style="width:4px;height:4px;border-radius:50%;background:#E82127;margin:2px auto"></div></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    })
    L.marker([pts[0].lat, pts[0].lng], { icon: startIcon }).addTo(layer)
    L.marker([pts[pts.length - 1].lat, pts[pts.length - 1].lng], { icon: endIcon }).addTo(layer)

    // 适配视野
    const bounds = L.latLngBounds(pts.map((p) => [p.lat, p.lng] as [number, number]))
    map.fitBounds(bounds, { padding: [30, 30] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points])

  if (pts.length < 2) {
    return (
      <div
        className="flex h-40 items-center justify-center rounded-xl bg-white/[0.03] text-xs text-slate-500"
        data-testid="route-map-empty"
      >
        暂无路线轨迹数据
      </div>
    )
  }

  const speeds = pts.filter((p) => p.speed != null).map((p) => p.speed as number)
  const maxSpeed = speeds.length ? Math.max(...speeds) : null

  return (
    <div
      className="overflow-hidden rounded-xl border border-white/[0.06]"
      data-testid="route-map"
    >
      <div className="relative" style={{ height }}>
        <div ref={containerRef} className="h-full w-full" style={{ background: '#0d1117' }} />
        {hover && (
          <div
            className="pointer-events-none absolute z-[1000] rounded-lg border border-white/10 bg-[rgba(11,15,20,0.92)] px-2.5 py-1 text-xs font-semibold text-slate-100 shadow-lg"
            style={{ left: '50%', top: 8, transform: 'translateX(-50%)' }}
          >
            {hover.speed != null ? `${Math.round(hover.speed)} km/h` : '--'}
          </div>
        )}
        {/* 图层切换 */}
        <div className="absolute right-2 top-2 z-[1000] flex overflow-hidden rounded-lg border border-white/15 bg-[rgba(11,15,20,0.85)] text-[11px] font-medium">
          <button
            className={`px-2.5 py-1 ${!satellite ? 'bg-tesla text-white' : 'text-slate-300'}`}
            onClick={() => setSatellite(false)}
          >
            标准
          </button>
          <button
            className={`px-2.5 py-1 ${satellite ? 'bg-tesla text-white' : 'text-slate-300'}`}
            onClick={() => setSatellite(true)}
          >
            卫星
          </button>
        </div>
      </div>
      {showSpeedLegend && (
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 border-t border-white/[0.06] px-3 py-2 text-[11px] text-slate-400" data-testid="route-speed-legend">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-emerald-400" /> 起点
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-tesla bg-tesla/40" /> 终点
          </span>
          <span className="flex items-center gap-2">
            <span>慢</span>
            <span
              className="inline-block h-2 w-28 rounded-full"
              style={{ background: 'linear-gradient(to right, rgb(56,130,246), rgb(34,211,238), rgb(52,211,153), rgb(250,204,21), rgb(239,68,68))' }}
            />
            <span>快{maxSpeed != null ? `（最高 ${Math.round(maxSpeed)} km/h）` : ''}</span>
          </span>
          <span className="text-slate-500">悬停轨迹看速度 · 拖拽缩放 · 底图©高德</span>
        </div>
      )}
    </div>
  )
}
