import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@mng/engine': r('./packages/engine/src/index.ts'),
      '@mng/protocol': r('./packages/protocol/src/index.ts'),
      '@mng/config': r('./packages/config/src/index.ts'),
      '@mng/testing': r('./packages/testing/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
  },
});
