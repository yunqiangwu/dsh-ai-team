/**
 * `git` CLI 的 Promise 薄封装。仓库拓扑：
 *
 *   <rootDir>/<teamId>/repo                  共享仓库（集成检出，始终在 baseBranch）
 *   <rootDir>/<teamId>/workspaces/<memberId>  每个成员一个隔离的 git worktree，
 *                                             共享同一个 object store。
 *
 * 本模块补齐了远端一侧：（可能为空的）远端 clone、基于环境变量引用构造
 * GIT_SSH_COMMAND 的鉴权 push，以及 spec §4.5 的 push 安全规则。
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MergeStrategy } from './profile.js';

/** Identity used for commits the plugin itself creates (init, merges). */
const COMMITTER = ['-c', 'user.name=dsh-ai-team', '-c', 'user.email=dsh-ai-team@localhost'];

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  /** Extra environment entries, e.g. GIT_SSH_COMMAND for authenticated ops. */
  env?: Record<string, string>;
}

/**
 * git ref / 分支名的安全边界。
 *
 * `team_branch` 工具的 `branch` / `target` 由模型自由填写，会被直接拼进
 * `git branch <name> <start>` 与 `git merge … <name>` 的 argv：一个以 `-` 开头的
 * 值会被 git 当成选项 —— `git branch -D <victim>` 就能静默删掉同事那条未检出的
 * 任务分支。所以除了 git 自身的 ref 命名规则，这里额外禁止前导 `-`。
 * 全部可变操作都过这道函数，不依赖调用方自觉。
 */
const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/;

export function assertSafeRef(name: string, label = 'branch'): string {
  if (!SAFE_REF_RE.test(name) || name.includes('..') || name.includes('@{')) {
    throw new Error(
      `invalid ${label} name "${name}": must start with an alphanumeric character and contain only ` +
        `letters, digits, '.', '_', '-', '+', '/' or '@' (no spaces, no leading '-', no '..' or '@{')`,
    );
  }
  return name;
}

/** Run git in `cwd`, returning trimmed stdout. Throws GitError on failure. */
export async function git(args: string[], cwd: string, options?: GitOptions): Promise<string> {
  try {
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
      execFile(
        'git',
        args,
        {
          cwd,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options?.env },
        },
        (error, stdoutText, stderr) => {
          if (error !== null) {
            const err = error as Error & { stderr?: string; stdout?: string };
            err.stderr = stderr;
            err.stdout = stdoutText;
            reject(err);
          } else {
            resolvePromise({ stdout: stdoutText, stderr });
          }
        },
      );
    });
    return stdout.trim();
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const stderr = (err.stderr ?? '').trim();
    throw new GitError(`git ${args.join(' ')} failed (cwd: ${cwd})${stderr ? `: ${stderr}` : ''}`, stderr);
  }
}

async function isRepo(path: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--is-inside-work-tree'], path);
    return true;
  } catch {
    return false;
  }
}

async function hasCommits(path: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', 'HEAD'], path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 确保 `path` 是位于 `baseBranch` 上、且至少有一个提交的 git 仓库
 *（worktree 与合并都需要一个 HEAD 作为 fork 起点）。
 */
export async function ensureRepo(path: string, baseBranch: string): Promise<void> {
  await mkdir(path, { recursive: true });
  if (!(await isRepo(path))) {
    await git(['init', '-b', baseBranch], path);
  }
  if (!(await hasCommits(path))) {
    await git([...COMMITTER, 'commit', '--allow-empty', '-m', 'chore: initial commit'], path);
  }
}

/** 从 `startPoint` 创建分支 `branch` 并在一个新的 worktree 中检出。 */
export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  startPoint: string,
): Promise<void> {
  await mkdir(worktreePath, { recursive: true });
  const branches = await listBranches(repoPath);
  if (branches.includes(branch)) {
    await git(['worktree', 'add', worktreePath, branch], repoPath);
  } else {
    await git(['worktree', 'add', worktreePath, '-b', branch, startPoint], repoPath);
  }
}

/** 移除一个 worktree（成员移除 / 显式清理）。绝不删除仓库本身。 */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(['worktree', 'remove', '--force', worktreePath], repoPath);
}

/** 本地分支短名；仓库没有提交时返回空数组。 */
export async function listBranches(repoPath: string): Promise<string[]> {
  try {
    const out = await git(['branch', '--format=%(refname:short)'], repoPath);
    return out === '' ? [] : out.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** worktree 当前检出的分支（detached 时返回 'HEAD'）。 */
export async function currentBranch(worktreePath: string): Promise<string> {
  return git(['branch', '--show-current'], worktreePath);
}

/** 从 `startPoint` 创建分支 `branch`，且不检出到任何地方。 */
export async function createBranch(repoPath: string, branch: string, startPoint: string): Promise<void> {
  await git(['branch', assertSafeRef(branch), assertSafeRef(startPoint, 'start point')], repoPath);
}

/** 在成员的 worktree 内检出已存在的分支。 */
export async function checkout(worktreePath: string, branch: string): Promise<void> {
  await git(['checkout', assertSafeRef(branch)], worktreePath);
}

/**
 * 把 `source` 合并进 `target`。集成检出（repoPath）通常停在基础分支上；
 * 目标不是基础分支时，我们临时切过去、合并完再恢复基础分支。
 *
 * `strategy` 控制合并提交的形状：
 *  - `no-ff`（默认，历史行为）—— 带两个父提交的合并提交；
 *  - `squash` —— 一个容纳整个差异的提交，让 `target` 保持线性、可独立回滚
 *    （AgentDeploy 规则）；
 *  - `merge` —— 不强制 `--no-ff` 的快进或合并提交。
 */
export async function mergeBranch(
  repoPath: string,
  source: string,
  target: string,
  baseBranch: string,
  message?: string,
  strategy: MergeStrategy = 'no-ff',
): Promise<void> {
  const safeSource = assertSafeRef(source, 'source branch');
  const safeTarget = assertSafeRef(target, 'target branch');
  const restore = safeTarget !== baseBranch;
  if (restore) await git(['checkout', safeTarget], repoPath);
  try {
    if (strategy === 'squash') {
      // --squash 暂存整个差异但不创建合并提交；随后我们用插件身份提交它，
      // 这样基础分支保持线性。
      await git(['merge', '--squash', safeSource], repoPath);
      await git(
        [...COMMITTER, 'commit', '-m', message ?? `merge: ${safeSource} into ${safeTarget}`],
        repoPath,
      ).catch(() => {
        // 没有暂存的变更（已合并 / 空差异）—— 无需提交。
      });
    } else if (strategy === 'merge') {
      await git(
        [...COMMITTER, 'merge', '-m', message ?? `merge: ${safeSource} into ${safeTarget}`, safeSource],
        repoPath,
      );
    } else {
      await git(
        [
          ...COMMITTER,
          'merge',
          '--no-ff',
          '-m',
          message ?? `merge: ${safeSource} into ${safeTarget}`,
          safeSource,
        ],
        repoPath,
      );
    }
  } finally {
    if (restore) await git(['checkout', baseBranch], repoPath);
  }
}

/** 硬删除一个本地分支（用于清理已结束的任务分支）。 */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await git(['branch', '-D', assertSafeRef(branch)], repoPath);
}

/**
 * 暂存 `pathspecs` 下的所有内容并以插件身份提交。
 * 没有可提交内容时是空操作。这样能让集成检出在任务契约重写
 *（.tasks/*.md、_board.md）后保持干净。
 *
 * 复数形式是必需的：draft→正式区的升格是**一次**跨越两个路径的提交（draft 被删 +
 * 正式文件新增），拆成两次提交会留下一个「两份文档同时存在」或「一份都没有」的中间态。
 */
export async function commitAll(repoPath: string, pathspecs: readonly string[], message: string): Promise<void> {
  await git(['add', '-A', '--', ...pathspecs], repoPath);
  await git([...COMMITTER, 'commit', '-m', message, '--', ...pathspecs], repoPath).catch((error: unknown) => {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    if (!/nothing to commit|no changes added/i.test(stderr)) throw error;
  });
}

// ── 远端操作 ───────────────────────────────────────────────────────────────

/**
 * 为带鉴权的远端操作构造环境。SSH 私钥以值的形式经临时文件传入
 *（mode 0600，由调用方的 finally 删除）—— 密钥内容绝不接触仓库或配置。
 */
export async function sshEnvForKey(keyValue: string): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ai-team-key-'));
  const keyPath = join(dir, 'id_key');
  await writeFile(keyPath, keyValue, { mode: 0o600 });
  return {
    env: {
      GIT_SSH_COMMAND: `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
    },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 把 `url` 克隆到 `dest`。支持空仓库：克隆后检出可能是 unborn 状态，
 * 此时我们用一次初始空提交创建基础分支，让 worktree 可以从中 fork。
 */
export async function cloneRemote(
  url: string,
  dest: string,
  baseBranch: string,
  env?: Record<string, string>,
): Promise<void> {
  await mkdir(dest, { recursive: true });
  try {
    await git(['clone', '--origin', 'origin', url, dest], dest, { env });
  } catch (error) {
    // 克隆空远端时大多数 git 版本会带 warning 成功，
    // 但旧版本在创建目录后会以非零退出。
    if (!(await isRepo(dest))) throw error;
  }
  if (!(await hasCommits(dest))) {
    await git(['checkout', '-b', baseBranch], dest).catch(async () => {
      await git(['symbolic-ref', 'HEAD', `refs/heads/${baseBranch}`], dest);
    });
    await git([...COMMITTER, 'commit', '--allow-empty', '-m', 'chore: initial commit'], dest);
    await git(['push', '-u', 'origin', baseBranch], dest, { env }).catch(() => {
      // The remote may be read-only during tests; bootstrap reports it later.
    });
  }
}

/** `url` 是否为 SSH 远端（git@host:path 或 ssh://）。 */
export function isSshRemote(url: string): boolean {
  return url.startsWith('git@') || url.startsWith('ssh://');
}

/** 从 origin 抓取所有引用。 */
export async function fetchRemote(repoPath: string, env?: Record<string, string>): Promise<void> {
  await git(['fetch', 'origin', '--prune'], repoPath, { env });
}

/**
 * 把 `branch` 推到 origin，内置规范 §4.5.5 的安全规则：
 *  - 强制推送只允许发生在任务分支上，且只能用 --force-with-lease；
 *  - 其它一律是普通快进推送。
 */
export async function pushBranch(
  repoPath: string,
  branch: string,
  options?: { env?: Record<string, string>; forceWithLease?: boolean },
): Promise<void> {
  const safeBranch = assertSafeRef(branch);
  const args = ['push', 'origin'];
  if (options?.forceWithLease === true) {
    if (!safeBranch.startsWith('task/') && !safeBranch.startsWith('member/') && !safeBranch.startsWith('agent/')) {
      throw new GitError(
        `refusing to force-push shared branch "${safeBranch}"; only task/member/agent branches may use --force-with-lease`,
        '',
      );
    }
    args.push(`--force-with-lease=refs/heads/${safeBranch}`);
  }
  args.push(`refs/heads/${safeBranch}:refs/heads/${safeBranch}`);
  await git(args, repoPath, { env: options?.env });
}

/** 解析一个（可能为远端的）引用的 sha；不存在时返回 null。 */
export async function resolveRef(repoPath: string, ref: string): Promise<string | null> {
  try {
    return await git(['rev-parse', '--verify', ref], repoPath);
  } catch {
    return null;
  }
}

/** 列出两个引用之间变更的文件（diff --name-only）。 */
export async function changedFiles(repoPath: string, fromRef: string, toRef: string): Promise<string[]> {
  const out = await git(['diff', '--name-only', fromRef, toRef], repoPath);
  return out === '' ? [] : out.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** 一次 `base..head` 改动的规模（评审前的体量门用它）。 */
export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * `fromRef..toRef` 的行级改动量（git diff --shortstat）。
 * 解析不出短统计时返回全 0 —— 体量门把"未知"当作"不拦"，
 * 绝不允许 git 输出格式的变化把既有评审流程卡死。
 */
export async function diffShortstat(repoPath: string, fromRef: string, toRef: string): Promise<DiffStat> {
  try {
    const out = await git(['diff', '--shortstat', fromRef, toRef], repoPath);
    const count = (pattern: RegExp): number => Number.parseInt(pattern.exec(out)?.[1] ?? '0', 10) || 0;
    return {
      files: count(/(\d+) files? changed/),
      insertions: count(/(\d+) insertions?\(\+\)/),
      deletions: count(/(\d+) deletions?\(-\)/),
    };
  } catch {
    return { files: 0, insertions: 0, deletions: 0 };
  }
}

/** `branch` 上从 `sinceRef` 不可达的提交数（git 活动探针）。 */
export async function countNewCommits(repoPath: string, branch: string, sinceRef: string): Promise<number> {
  try {
    const out = await git(['rev-list', '--count', `${sinceRef}..${branch}`], repoPath);
    return Number.parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

/** 某个引用上最新提交的 Unix 时间戳；无提交时返回 null。 */
export async function lastCommitAt(repoPath: string, ref: string): Promise<number | null> {
  try {
    const out = await git(['log', '-1', '--format=%ct', ref], repoPath);
    const seconds = Number.parseInt(out, 10);
    return Number.isNaN(seconds) ? null : seconds * 1000;
  } catch {
    return null;
  }
}
