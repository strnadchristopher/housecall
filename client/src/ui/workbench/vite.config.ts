import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/** UI-lane workbench on its own port (1520), separate from engineering's 1420. */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: { port: 1520, strictPort: true, host: '127.0.0.1', fs: { allow: [fileURLToPath(new URL('../../..', import.meta.url))] } },
  clearScreen: false,
});
