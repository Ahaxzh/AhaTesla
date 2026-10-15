/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: {
          950: '#08090A',
          900: '#0F1011',
          850: '#121315',
          800: '#16181A',
          700: '#1D2022',
        },
        tesla: {
          DEFAULT: '#E82127',
          soft: '#FF3B41',
          dark: '#B0161B',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
        numeric: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 32px rgba(0,0,0,0.35)',
        glow: '0 0 24px rgba(232,33,39,0.25)',
        overlay: '0 16px 48px rgba(0,0,0,0.5)',
      },
    },
  },
  plugins: [],
}
