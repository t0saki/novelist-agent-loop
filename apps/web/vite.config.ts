import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// dev：/api 代理到 server（NOVELIST_LISTEN_PORT，默认 8000）；SSE 需要关闭代理缓冲
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.NOVELIST_API ?? 'http://127.0.0.1:8000', changeOrigin: false, ws: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 2000 },
  test: { environment: 'jsdom', include: ['test/**/*.test.{ts,tsx}'] },
} as never);
