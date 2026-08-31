/**
 * Build-cache sharing tests. Linking a shared cache dir must symlink
 * `workspace/<dir>` → `cacheDir/<dir>`, and writes through the symlink must
 * land in the shared location (so consecutive tasks reuse prior output).
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, lstat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkSharedCacheDir, linkSharedCacheDirs, DEFAULT_CACHE_DIRS } from '../../src/cache.js';

describe('cache: build-cache sharing', () => {
  it('links a cache dir into the workspace and writes through to the shared target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cache-'));
    try {
      const workspace = join(root, 'ws');
      const cacheDir = join(root, 'cache', 'branch');
      const linked = await linkSharedCacheDir(workspace, cacheDir, '.output');
      expect(linked).toBe(true);
      const linkStat = await lstat(join(workspace, '.output'));
      expect(linkStat.isSymbolicLink()).toBe(true);
      // Writing through the workspace symlink lands in the shared cache dir.
      await writeFile(join(workspace, '.output', 'server.mjs'), 'export {};\n', 'utf8');
      expect(await readdir(join(cacheDir, '.output'))).toContain('server.mjs');
      expect(await readdir(cacheDir)).toContain('.output');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('links every configured dir and skips the ones that fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cache-all-'));
    try {
      const workspace = join(root, 'ws');
      const cacheDir = join(root, 'cache', 'b');
      const linked = await linkSharedCacheDirs(workspace, cacheDir, ['.nuxt', '.output', 'coverage']);
      expect(linked).toEqual(['.nuxt', '.output', 'coverage']);
      for (const dir of ['.nuxt', '.output', 'coverage']) {
        expect((await lstat(join(workspace, dir))).isSymbolicLink()).toBe(true);
      }
      // DEFAULT_CACHE_DIRS is a sane opt-in list.
      expect(DEFAULT_CACHE_DIRS).toContain('.output');
      expect(DEFAULT_CACHE_DIRS).toContain('node_modules/.cache');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
