import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5176,
      proxy: { '/api': { target: env.API_PROXY_TARGET || 'http://localhost:3000', changeOrigin: true } },
    },
  }
})
