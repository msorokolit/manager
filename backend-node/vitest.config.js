import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // Each test file gets a fresh module graph so per-file env vars take
    // effect (config.js caches its settings on import).
    isolate: true,
    pool: 'forks',
    testTimeout: 15_000,
    silent: false,
  },
});
