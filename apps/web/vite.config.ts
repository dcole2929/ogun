import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    // Dev proxies to the control plane so the app talks to a same-origin /api in both
    // dev and production, where hono serves the built assets itself.
    proxy: {
      '/api': {
        target: process.env.OGUN_SERVER_URL ?? 'http://localhost:7777',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
