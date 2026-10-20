import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * 开发模式把 /api 代理到后端。
 * 后端端口可能与默认值不同（例如本机已有服务占用 9070），用 DEV_API_TARGET 覆盖：
 *   DEV_API_TARGET=http://127.0.0.1:9071 pnpm dev:web
 */
const target = process.env.DEV_API_TARGET ?? 'http://127.0.0.1:9070'

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Tauri production assets are loaded from the app's asset protocol rather than `/`.
  // Keep dev URLs absolute for Vite's proxy, but make packaged assets portable.
  base: command === 'build' ? './' : '/',
  server: {
    port: 9067,
    strictPort: true,
    proxy: {
      '/api': { target, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
}))
