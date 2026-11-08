import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * The real client (index.html -> main.tsx -> App.tsx) served on the UI lane's
 * own port 1521, proxying /api to the UI fixture API on 3131. Engineering's
 * dev setup (1420 -> 3031) is untouched.
 */
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  plugins: [react()],
  server: {
    port: Number(process.env.UI_APP_PORT ?? 1521), strictPort: true, host: '127.0.0.1',
    proxy: { '/api': { target: process.env.UI_FIXTURE_API ?? 'http://127.0.0.1:3131', changeOrigin: false } },
  },
  // Production-built candidate for the adversarial pass: `vite build` then `vite preview` on 1522.
  build: { outDir: process.env.UI_DIST ?? 'dist', emptyOutDir: true },
  preview: {
    port: 1522, strictPort: true, host: '127.0.0.1',
    proxy: { '/api': { target: process.env.UI_FIXTURE_API ?? 'http://127.0.0.1:3131', changeOrigin: false } },
  },
  clearScreen: false,
});
