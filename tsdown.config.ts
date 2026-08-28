/**
 * Standalone build for dsh-ai-team, mirroring the DSH monorepo artifact
 * contracts (packages/client/tsdown.client.ts):
 *
 *  1. Host half: tsc emits lib/types/**, tsdown bundles lib/types/index.js
 *     into lib/index.js (ESM, node). Production dependencies stay imports.
 *  2. Client half: lib/types/client/index.js is bundled into lib/client.js
 *     as a closure-factory artifact — window.__ModuleLoader__.load({id,
 *     factory}) with banner/footer/intro, CJS format, browser platform.
 *     react / react-dom resolve through the loader module table (external),
 *     everything else inlines.
 */
import { defineConfig } from 'tsdown'
import { isBuiltin } from 'node:module'
import pkg from './package.json' with { type: 'json' }

const productionDeps = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
])
const isProductionDependency = (specifier: string): boolean =>
  [...productionDeps].some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  )

/** Modules the browser loader module table answers (see DSH platform.ts). */
const isClientExternal = (specifier: string): boolean =>
  specifier === 'react' ||
  specifier.startsWith('react/') ||
  specifier === 'react-dom' ||
  specifier.startsWith('react-dom/') ||
  specifier.startsWith('@deepseek-ai/')

export default defineConfig([
  {
    name: 'dsh-ai-team',
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: isProductionDependency,
      alwaysBundle: (specifier: string) =>
        !isBuiltin(specifier) && !isProductionDependency(specifier),
    },
  },
  {
    name: 'dsh-ai-team/client',
    entry: { client: 'lib/types/client/index.js' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: true,
    deps: {
      neverBundle: isClientExternal,
      alwaysBundle: (specifier: string) => !isClientExternal(specifier),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(
        process.env.NODE_ENV ?? 'production',
      ),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: "dsh-ai-team", factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
