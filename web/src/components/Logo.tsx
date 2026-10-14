/** AhaTesla Logo — 盾形 + 闪电 + 字母 A 组合，深色背景上红色渐变 */
export function LogoMark({ size = 40, className = '' }: { size?: number; className?: string }) {
  const id = `lg-${size}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      role="img"
      aria-label="AhaTesla Logo"
    >
      <defs>
        <linearGradient id={`${id}-red`} x1="14" y1="6" x2="50" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FF4A50" />
          <stop offset="1" stopColor="#C21822" />
        </linearGradient>
        <linearGradient id={`${id}-inner`} x1="24" y1="18" x2="40" y2="46" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#FFD9DA" />
        </linearGradient>
      </defs>
      {/* 盾形主体 */}
      <path
        d="M32 4 L56 12 V30 C56 44.5 46.2 55.6 32 60 C17.8 55.6 8 44.5 8 30 V12 Z"
        fill={`url(#${id}-red)`}
      />
      {/* 盾内高光描边 */}
      <path
        d="M32 7.5 L52.8 14.4 V30 C52.8 42.6 44.3 52.3 32 56.4 C19.7 52.3 11.2 42.6 11.2 30 V14.4 Z"
        stroke="rgba(255,255,255,0.25)"
        strokeWidth="1.2"
        fill="none"
      />
      {/* 字母 A（右侧竖笔顺带闪电斜切造型） */}
      <path
        d="M22 44 L31 20 H33.6 L43 44 H38.6 L36.5 38.6 H29.9 L31.2 34.6 H35 L32.2 26.8 L27.6 38.6 H26.8 L28.1 34.6 H26.2 L24.6 44 Z"
        fill={`url(#${id}-inner)`}
      />
      {/* 闪电（A 的右斜笔延伸为闪电） */}
      <path
        d="M37.2 18 L31.8 30.2 H35.4 L32.6 38.8 L41.4 26.6 H37.4 L40.4 18 Z"
        fill="#FFD9DA"
      />
    </svg>
  )
}

export function LogoFull({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <LogoMark size={34} />
      <div className="text-[20px] font-semibold tracking-tight text-white">
        Aha<span className="text-tesla">Tesla</span>
      </div>
    </div>
  )
}
