/**
 * Build-cache sharing (opt-in). For a Nuxt/Nitro or other build-heavy repo,
 * every task re-running `build`/`e2e` from a cold worktree is wasteful. When
 * `buildCache.enabled`, the plugin symlinks configured cache dirs (`.nuxt`,
 * `.output`, `coverage`, `node_modules/.cache`, …) to a per-branch shared
 * location so consecutive tasks reuse prior output instead of rebuilding from
 * scratch. Purely best-effort and opt-in — a failed link is silently skipped.
 */
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Default shared cache dirs (gitignored build/test output). */
export const DEFAULT_CACHE_DIRS = [
  '.nuxt',
  '.output',
  'dist',
  'coverage',
  '.vitest',
  'node_modules/.cache',
];

/**
 * Symlink `workspace/<dir>` → `cacheDir/<dir>`, creating both as needed.
 * Returns false (and leaves the workspace untouched) when linking fails, so a
 * cache misconfiguration never blocks the gate run.
 */
export async function linkSharedCacheDir(workspacePath: string, cacheDir: string, dir: string): Promise<boolean> {
  try {
    const target = join(cacheDir, dir);
    await mkdir(target, { recursive: true });
    const linkPath = join(workspacePath, dir);
    await mkdir(join(workspacePath, dir.split('/').slice(0, -1).join('/')), { recursive: true });
    await rm(linkPath, { recursive: true, force: true });
    await symlink(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

/** Link every configured cache dir; returns the ones that were linked. */
export async function linkSharedCacheDirs(
  workspacePath: string,
  cacheDir: string,
  dirs: readonly string[],
): Promise<string[]> {
  const linked: string[] = [];
  for (const dir of dirs) {
    if (await linkSharedCacheDir(workspacePath, cacheDir, dir)) linked.push(dir);
  }
  return linked;
}
