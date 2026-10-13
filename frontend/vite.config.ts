/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The read-only demo (VITE_STATIC=1) is served from a sub-path such as GitHub Pages' /<repository>/, given as
// VITE_BASE; the live app is always served from the root.
const base = process.env.VITE_STATIC === '1' ? (process.env.VITE_BASE ?? '/') : '/';

export default defineConfig({
  base,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8765', changeOrigin: true } },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
