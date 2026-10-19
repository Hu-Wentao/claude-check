import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __SLC_E2E__: 'false',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
});
