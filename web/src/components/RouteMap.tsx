import { useState } from 'react'

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

type RoutePoint = { lat: number; lng: number; t?: string; speed?: number | null } | [number, number]

/** 行程路线图：内联 SVG，等距投影 + 起终点标记 + 速度渐变着色分段 + 悬停速度提示 */
export function RouteMap({
  points,
  height = 260,
  showSpeedLegend = true,
}: {
  points: RoutePoint[]
  height?: number
  showSpeedLegend?: boolean
}) {
  const [hover, setHover] = useState<{ x: number; y: number; speed: number | null; idx: number } | null>(null)

  // 兼容 [lng,lat][] 与 {lat,lng,speed} 两种格式
  const pts = (points || [])
    .map((p): { lng: number; lat: number; speed: number | null } =>
      Array.isArray(p)
        ? { lng: p[0], lat: p[1], speed: null }
        : { lng: Number(p.lng), lat: Number(p.lat), speed: p.speed != null ? Number(p.speed) : null },
    )
    .filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat))

  const hasSpeed = pts.some((p) => p.speed != null)
  const speeds = pts.filter((p) => p.speed != null).map((p) => p.speed as number)
  const maxSpeed = speeds.length ? Math.max(...speeds) : null

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

  const W = 640
  const H = 360
  const PAD = 26

  const lngs = pts.map((p) => p.lng)
  const lats = pts.map((p) => p.lat)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const spanLng = Math.max(maxLng - minLng, 1e-6)
  const spanLat = Math.max(maxLat - minLat, 1e-6)

  // 等比例适配到 viewBox（纬度方向翻转）
  const scale = Math.min((W - PAD * 2) / spanLng, (H - PAD * 2) / spanLat)
  const offsetX = (W - spanLng * scale) / 2
  const offsetY = (H - spanLat * scale) / 2
  const project = (p: { lng: number; lat: number }): [number, number] => [
    offsetX + (p.lng - minLng) * scale,
    offsetY + (maxLat - p.lat) * scale,
  ]

  const first = project(pts[0])
  const last = project(pts[pts.length - 1])

  // 速度分段线：相邻点一段，颜色取该段速度（无速度数据时统一主题红）
  const segments = pts.slice(0, -1).map((p, i) => {
    const q = pts[i + 1]
    const [x1, y1] = project(p)
    const [x2, y2] = project(q)
    const sp = p.speed != null ? p.speed : q.speed
    return { x1, y1, x2, y2, speed: sp, idx: i }
  })

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-base-900" data-testid="route-map">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', maxHeight: height * 1.6 }}
        role="img"
        aria-label="行程路线图（按速度着色）"
      >
        {/* 网格底纹 */}
        {Array.from({ length: 9 }, (_, i) => (
          <line key={`h${i}`} x1={0} y1={(H / 9) * i} x2={W} y2={(H / 9) * i} stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
        ))}
        {Array.from({ length: 13 }, (_, i) => (
          <line key={`v${i}`} x1={(W / 13) * i} y1={0} x2={(W / 13) * i} y2={H} stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
        ))}

        {/* 速度着色路线段 */}
        {hasSpeed ? (
          segments.map((s) => (
            <line
              key={s.idx}
              x1={s.x1}
              y1={s.y1}
              x2={s.x2}
              y2={s.y2}
              stroke={speedColor(s.speed)}
              strokeWidth={4}
              strokeLinecap="round"
              opacity={hover == null || Math.abs(hover.idx - s.idx) <= 2 ? 1 : 0.4}
              onMouseEnter={() => setHover({ x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2, speed: s.speed, idx: s.idx })}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'crosshair' }}
            />
          ))
        ) : (
          <path
            d={pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${project(p)[0].toFixed(1)},${project(p)[1].toFixed(1)}`).join(' ')}
            fill="none"
            stroke="#E82127"
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* 悬停速度提示 */}
        {hover && (
          <g pointerEvents="none">
            <rect x={Math.min(hover.x + 10, W - 96)} y={hover.y - 32} width={86} height={26} rx={6} fill="rgba(11,15,20,0.92)" stroke="rgba(255,255,255,0.12)" />
            <text x={Math.min(hover.x + 10, W - 96) + 43} y={hover.y - 14} textAnchor="middle" fill="#E2E8F0" fontSize={13} fontWeight={600}>
              {hover.speed != null ? `${Math.round(hover.speed)} km/h` : '--'}
            </text>
          </g>
        )}

        {/* 起终点 */}
        <circle cx={first[0]} cy={first[1]} r={7} fill="#0B0F14" stroke="#34D399" strokeWidth={2.5} />
        <circle cx={last[0]} cy={last[1]} r={7} fill="#0B0F14" stroke="#E82127" strokeWidth={2.5} />
        <circle cx={last[0]} cy={last[1]} r={2.5} fill="#E82127" />
      </svg>

      {/* 图例：速度色带 */}
      {hasSpeed && showSpeedLegend ? (
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
          <span className="text-slate-500">悬停路段查看速度</span>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-5 border-t border-white/[0.06] py-2 text-[11px] text-slate-400">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-emerald-400" /> 起点
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-tesla bg-tesla/40" /> 终点
          </span>
        </div>
      )}
    </div>
  )
}
