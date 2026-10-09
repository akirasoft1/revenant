/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dynatrace RUM: injected only when VITE_DT_RUM_SRC is set at build time
 * (e.g. the tenant's "jsInlineScript"/"jsTagComplete" src URL). Empty or unset
 * = no tag at all, so local builds and tests never phone home.
 */
function dynatraceRum(src: string | undefined): Plugin {
  return {
    name: 'hangar-dynatrace-rum',
    transformIndexHtml() {
      if (!src) return [];
      return [
        {
          tag: 'script',
          attrs: { type: 'text/javascript', src, crossorigin: 'anonymous' },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const rumSrc = (process.env.VITE_DT_RUM_SRC ?? env.VITE_DT_RUM_SRC ?? '').trim();
  return {
    plugins: [react(), dynatraceRum(rumSrc || undefined)],
    server: {
      port: 5173,
      proxy: {
        // Local hangar-service (`python -m src.main`, PORT 8080).
        '/api': { target: 'http://localhost:8080', changeOrigin: false },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // Hashed filenames under dist/assets/ -> served with long-cache headers;
      // index.html is served no-cache by hangar-service.
      assetsDir: 'assets',
      sourcemap: false,
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      css: false,
    },
  };
});
