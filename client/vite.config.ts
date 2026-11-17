import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
export default defineConfig(({ mode }) => ({
  base: mode === "hosted" ? "/app/" : "/",
  build: { outDir: mode === "hosted" ? "dist-hosted" : "dist" },
  plugins: [react(), {
    name: 'hosted-account-runtime',
    transformIndexHtml(html) { return mode === 'hosted' ? html.replace('viewport-fit=cover', 'viewport-fit=cover, interactive-widget=resizes-content') : html; },
    resolveId(source, importer) {
      if (source === './opaque.mjs' && importer?.endsWith('/portal/src/account-client.mjs')) return { id: '/app/opaque.mjs', external: true };
    },
    closeBundle() {
      if (mode !== 'hosted') return;
      mkdirSync('dist-hosted', { recursive: true });
      copyFileSync('../portal/node_modules/@serenity-kit/opaque/esm/index.js', 'dist-hosted/opaque.mjs');
      copyFileSync('../portal/node_modules/@serenity-kit/opaque/LICENSE', 'dist-hosted/OPAQUE-LICENSE.txt');
    },
  }],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: 1420,
    strictPort: true,
    proxy: mode === "hosted" ? undefined : {
      "/api": {
        target: process.env.HOUSECALL_API ?? "http://127.0.0.1:3000",
        changeOrigin: false,
      },
    },
  },
  clearScreen: false,
}));
