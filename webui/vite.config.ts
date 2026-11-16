import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:4090', ws: true }, '/onebot': { target: 'http://127.0.0.1:4090', ws: true }, '/media': 'http://127.0.0.1:4090' } },
});
