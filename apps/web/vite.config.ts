import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('.'),
  resolve: {
    alias: {
      '@mng/protocol': r('../../packages/protocol/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    // Keep the browser same-origin while forwarding game and Smoke requests
    // to the authoritative backend during local development.
    proxy: {
      '/api': { target: process.env.MNG_SERVER_URL ?? 'http://localhost:10000' },
      '/ws': { target: process.env.MNG_SERVER_URL?.replace(/^http/, 'ws') ?? 'ws://localhost:10000', ws: true },
      '/healthz': process.env.MNG_SERVER_URL ?? 'http://localhost:10000',
      '/metrics': process.env.MNG_SERVER_URL ?? 'http://localhost:10000',
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
