import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
      // 共享 fixture / helper 不是测试套件，但 matches tests/**/*.ts
      '**/helpers.ts',
    ],
    testTimeout: 90_000,
    hookTimeout: 30_000,
    // Tests create real git repos on disk; keep them isolated per file.
    pool: 'forks',
    fileParallelism: false,
  },
});
