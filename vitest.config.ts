import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // better-sqlite3 is a native addon; forks avoid worker_threads edge cases.
    pool: 'forks',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
