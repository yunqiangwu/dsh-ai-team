/**
 * 构建缓存共享（可选开启）。对于 Nuxt/Nitro 或其他构建密集型仓库，每个任务
 * 都在全新 worktree 上重跑 `build`/`e2e` 是很浪费的。当 `buildCache.enabled`
 * 时，插件会把配置好的缓存目录（`.nuxt`、`.output`、`coverage`、
 * `node_modules/.cache` 等）符号链接到按分支共享的位置，让后续任务复用已有
 * 产物，而不是从零重建。纯属尽力而为的可选能力 —— 链接失败会被静默跳过。
 */
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

/** 默认共享缓存目录（已被 gitignore 的构建/测试产物）。 */
export const DEFAULT_CACHE_DIRS = [
  '.nuxt',
  '.output',
  'dist',
  'coverage',
  '.vitest',
  'node_modules/.cache',
];

/**
 * 建立符号链接 `workspace/<dir>` → `cacheDir/<dir>`，按需创建两端。
 * 链接失败时返回 false（并保持 workspace 不被改动），这样缓存配置错误
 * 永远不会阻塞门禁运行。
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

/** 链接所有已配置的缓存目录；返回实际链接成功的那些。 */
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
