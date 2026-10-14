/** 行程路线图：内联 SVG polyline，等距投影 + 起终点标记 */
export function RouteMap({
  points,
  height = 220,
}: {
  points: [number, number][]
  height?: number
}) {
  // 兼容两种后端格式：[lng,lat][] 数组对，或 {lat,lng,t} 对象（API 契约实际返回）
  const pts = (points || [])
    .map((p: [number, number] | { lng: number; lat: number }): [number, number] =>
      Array.isArray(p) ? [p[0], p[1]] : [Number(p.lng), Number(p.lat)]
    )
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
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

  const lngs = pts.map((p) => p[0])
  const lats = pts.map((p) => p[1])
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
  const project = ([lng, lat]: [number, number]): [number, number] => [
    offsetX + (lng - minLng) * scale,
    offsetY + (maxLat - lat) * scale,
  ]

  const first = project(pts[0])
  const last = project(pts[pts.length - 1])
  const path = pts.map((p, i) => {
    const [x, y] = project(p)
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  })

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-base-900" data-testid="route-map">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', maxHeight: height * 1.6 }}
        role="img"
        aria-label="行程路线图"
      >
        <defs>
          <linearGradient id="route-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#FF4A50" />
            <stop offset="1" stopColor="#E82127" />
          </linearGradient>
        </defs>
        {/* 网格底纹 */}
        {Array.from({ length: 9 }, (_, i) => (
          <line key={`h${i}`} x1={0} y1={(H / 9) * i} x2={W} y2={(H / 9) * i} stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
        ))}
        {Array.from({ length: 13 }, (_, i) => (
          <line key={`v${i}`} x1={(W / 13) * i} y1={0} x2={(W / 13) * i} y2={H} stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
        ))}
        {/* 路线 */}
        <path
          d={path.join(' ')}
          fill="none"
          stroke="url(#route-grad)"
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* 起点 */}
        <circle cx={first[0]} cy={first[1]} r={7} fill="#0B0F14" stroke="#34D399" strokeWidth={2.5} />
        {/* 终点 */}
        <circle cx={last[0]} cy={last[1]} r={7} fill="#0B0F14" stroke="#E82127" strokeWidth={2.5} />
        <circle cx={last[0]} cy={last[1]} r={2.5} fill="#E82127" />
      </svg>
      <div className="flex items-center justify-center gap-5 border-t border-white/[0.06] py-2 text-[11px] text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-emerald-400" /> 起点
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-tesla bg-tesla/40" /> 终点
        </span>
      </div>
    </div>
  )
}
