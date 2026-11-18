import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 개발 중에는 /api 를 로컬 Worker(wrangler dev, 8787)로 넘긴다.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
