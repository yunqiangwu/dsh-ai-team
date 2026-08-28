import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    format: 'esm',
    platform: 'node',
    outDir: 'lib',
    // lib/types (the tsc output, including our entries) lives in the same
    // directory — never wipe it.
    clean: false,
    outputOptions: {
      entryFileNames: 'index.js',
    },
    external: [/^@deepseek-ai\//, /^node:/, 'zod', 'yaml'],
  },
  {
    entry: ['lib/types/client/index.js'],
    format: 'cjs',
    platform: 'browser',
    outDir: 'lib',
    clean: false,
    outputOptions: {
      entryFileNames: 'client.js',
      banner:
        'window.__ModuleLoader__.load({ id: "dsh-ai-team", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
    external: ['react', 'react-dom', 'react/jsx-runtime'],
  },
]);
