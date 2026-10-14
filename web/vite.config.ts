import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:18500', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:18500', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
