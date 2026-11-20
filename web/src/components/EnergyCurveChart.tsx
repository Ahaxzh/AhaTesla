import { useRef, useState } from 'react'
import { useI18n } from '@/i18n'
import { fmtKm } from '@/utils/format'

/**
 * 车机能量曲线（v2.8.2，SVG）——TeslaMate positions 表显续航分桶后的一图两投：
 * mode='decay'   续航衰减图（车机「额定值」页签主图）：Y=剩余表显续航，X=行驶 km，
 *                灰虚线=额定 1:1 斜率；线段在虚线上方=绿（跑赢额定）下方=琥珀。
 * mode='instant' 瞬时vs平均图（车机「自充电以来」页）：橙线=瞬时 Wh/km（3 点滑动平均），
 *                绿虚线=累计平均；瞬时低于平均的区段自然低于绿线，位置关系即极性。
 * 指针/touch 移动 → 垂直游标 + 最近点 tooltip（div 定位，左右缘钳制）。
 */

export interface CurvePoint {
  km: number
  ratedLeft: number
  instant: number | null
  avg: number | null
}

const W = 300
const H = 120
const PAD_X = 2

export function EnergyCurveChart({
  points,
  startRatedKm,
  mode,
}: {
  points: CurvePoint[]
  startRatedKm: number | null
  mode: 'decay' | 'instant'
}) {
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState<{ xPct: number; i: number } | null>(null)

  if (points.length < 2) return null

  const xs = points.map((p) => p.km)
  const xMax = xs[xs.length - 1] || 1
  const X = (km: number) => PAD_X + (km / xMax) * (W - PAD_X * 2)

  // Y 域
  let yLo: number, yHi: number
  if (mode === 'decay') {
    const ys = points.map((p) => p.ratedLeft)
    yLo = Math.min(...ys, startRatedKm ?? Math.min(...ys))
    yHi = Math.max(...ys, startRatedKm ?? Math.max(...ys))
  } else {
    const ys = points.map((p) => p.instant ?? 0)
    yLo = Math.min(0, ...ys)
    yHi = Math.max(...ys, ...points.map((p) => p.avg ?? 0))
  }
  const span = yHi - yLo || 1
  yLo -= span * 0.08
  yHi += span * 0.08
  const Y = (v: number) => H - ((v - yLo) / (yHi - yLo)) * H

  /** 指针定位最近点（x 比例反查）+ tooltip div 左右缘钳制 */
  const locate = (clientX: number, host: HTMLElement) => {
    const r = host.getBoundingClientRect()
    const pct = Math.min(Math.max((clientX - r.left) / r.width, 0), 1)
    const km = pct * xMax
    let best = 0
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i].km - km) < Math.abs(points[best].km - km)) best = i
    }
    const px = r.left + (X(points[best].km) / W) * r.width
    const cx = Math.min(Math.max(px - r.left, 70), Math.max(r.width - 70, 70))
    setCursor({ xPct: cx, i: best })
  }

  const active = cursor ? points[cursor.i] : null
  const last = points[points.length - 1]

  // decay 模式：线段着色（ratedLeft ≥ 额定斜线 → 绿）
  const segments: string[] = []
  if (mode === 'decay') {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]
      const b = points[i]
      const better = (a.ratedLeft + b.ratedLeft) / 2 >= (startRatedKm ?? 0) - (a.km + b.km) / 2
      segments.push(
        `<line x1="${X(a.km).toFixed(1)}" y1="${Y(a.ratedLeft).toFixed(1)}" x2="${X(b.km).toFixed(1)}" y2="${Y(b.ratedLeft).toFixed(1)}" stroke="${better ? '#10b981' : '#f59e0b'}" stroke-width="2" stroke-linecap="round" />`,
      )
    }
  }

  return (
    <div data-testid={`energy-curve-${mode}`}>
      <div ref={hostRef} className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-36 w-full touch-none"
          data-testid={`energy-curve-svg-${mode}`}
          role="img"
          aria-label={mode === 'decay' ? t('energy.curve.decayAria', '续航衰减曲线') : t('energy.curve.instantAria', '瞬时能耗曲线')}
          onPointerMove={(e) => locate(e.clientX, hostRef.current!)}
          onPointerLeave={() => setCursor(null)}
        >
          {mode === 'decay' ? (
            <>
              {/* 额定 1:1 斜率参考线 */}
              <line
                x1={X(0)} y1={Y(startRatedKm ?? yHi)}
                x2={X(xMax)} y2={Y((startRatedKm ?? yHi) - xMax)}
                stroke="rgba(128,140,155,0.7)" strokeWidth="1.5" strokeDasharray="5 4"
              />
              {/* 线段着色（dangerouslySetInnerHTML 注入 —— 上方拼串仅含数字常量） */}
              <g dangerouslySetInnerHTML={{ __html: segments.join('') }} />
              {/* 垂直游标 */}
              {active && cursor && (
                <line x1={X(active.km)} y1={0} x2={X(active.km)} y2={H} stroke="rgba(128,140,155,0.5)" strokeWidth="1" />
              )}
            </>
          ) : (
            <>
              {/* 累计平均线（绿） */}
              <polyline
                points={points.filter((p) => p.avg != null).map((p) => `${X(p.km).toFixed(1)},${Y(p.avg!).toFixed(1)}`).join(' ')}
                fill="none" stroke="#10b981" strokeWidth="1.5" strokeDasharray="5 4"
              />
              {/* 瞬时线（琥珀） */}
              <polyline
                points={points.filter((p) => p.instant != null).map((p) => `${X(p.km).toFixed(1)},${Y(p.instant!).toFixed(1)}`).join(' ')}
                fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
              />
              {active && cursor && (
                <line x1={X(active.km)} y1={0} x2={X(active.km)} y2={H} stroke="rgba(128,140,155,0.5)" strokeWidth="1" />
              )}
            </>
          )}
        </svg>

        {/* tooltip */}
        {active && cursor && (
          <div
            className="pointer-events-none absolute -top-1.5 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-white/10 bg-base-900/95 px-3 py-2 text-xs shadow-lg"
            style={{ left: `${cursor.xPct}px` }}
            data-testid={`energy-curve-tooltip-${mode}`}
            role="tooltip"
          >
            {mode === 'decay' ? (
              <>
                <span className="num font-medium text-slate-200">{fmtKm(active.km, 1)} km</span>
                <span className="num ml-2 text-slate-300">{t('energy.curve.remaining', '剩余')} {fmtKm(active.ratedLeft, 1)} km</span>
              </>
            ) : (
              <>
                <span className="num font-medium text-slate-200">{fmtKm(active.km, 1)} km</span>
                <span className="num ml-2 text-amber-400">{active.instant != null ? `${Math.round(active.instant)} Wh/km` : '--'}</span>
                <span className="num ml-2 text-emerald-400">{t('energy.curve.avg', '均')} {active.avg != null ? Math.round(active.avg) : '--'}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* x 轴首/尾里程 + 图例 */}
      <div className="mt-1.5 flex justify-between text-[11px] text-slate-400">
        <span className="num">0 km</span>
        <span className="num">{fmtKm(xMax, 1)} km</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
        {mode === 'decay' ? (
          <>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-[2px] w-4 rounded-full bg-emerald-500" />
              {t('energy.curve.better', '好于额定')}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-[2px] w-4 rounded-full bg-amber-500" />
              {t('energy.curve.worse', '差于额定')}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-[2px] w-4 rounded-full bg-slate-400" />
              {t('energy.curve.ratedLine', '额定斜率')}
            </span>
            <span className="num ml-auto text-slate-500">
              {t('energy.curve.end', '终点')} {fmtKm(last.ratedLeft, 1)} km
            </span>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-[2px] w-4 rounded-full bg-amber-500" />
              {t('energy.curve.instant', '瞬时能耗')}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-[2px] w-4 rounded-full bg-emerald-500" />
              {t('energy.curve.avgLine', '累计平均')}
            </span>
            <span className="num ml-auto text-slate-500">
              {t('energy.curve.avgNow', '当前均')} {last.avg != null ? `${Math.round(last.avg)} Wh/km` : '--'}
            </span>
          </>
        )}
      </div>
    </div>
  )
}
