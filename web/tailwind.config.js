/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: {
          950: '#0B0F14',
          900: '#0F141B',
          800: '#141B24',
          700: '#1B2430',
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
        card: '0 8px 32px rgba(0,0,0,0.35)',
        glow: '0 0 24px rgba(232,33,39,0.25)',
      },
    },
  },
  plugins: [],
}
