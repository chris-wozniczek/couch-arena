import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { host: true, port: 5173 },
  preview: { port: 4173 },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2500,
  },
  test: {
    include: ['tests/core/**/*.test.ts'],
    environment: 'node',
  },
});
