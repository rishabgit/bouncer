import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    fileParallelism: false,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
  },
});
