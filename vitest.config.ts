import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/test-*.ts', 'tests/smoke-*.ts'],
    testTimeout: 90_000,
    hookTimeout: 30_000,
    // Tests create real git repos on disk; keep them isolated per file.
    pool: 'forks',
    fileParallelism: false,
  },
});
