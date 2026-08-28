/**
 * Thin promisified wrapper around the `git` CLI. Repository topology:
 *
 *   <rootDir>/<teamId>/repo                 shared repository (integration
 *                                           checkout, always on baseBranch)
 *   <rootDir>/<teamId>/workspaces/<memberId> one isolated git worktree per
 *                                           member, sharing the same object
 *                                           store.
 *
 * This module adds the remote side: clone of a (possibly empty) remote,
 * authenticated push via GIT_SSH_COMMAND built from an env-var reference,
 * and the push safety rules of spec §4.5.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 * Ensure `path` is a git repository on `baseBranch` with at least one commit
 * (worktrees and merges need a HEAD to fork from).
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

/** Create branch `branch` from `startPoint` and check it out in a new worktree. */
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

/** Remove a worktree (member removal / explicit cleanup). Never deletes the repo. */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(['worktree', 'remove', '--force', worktreePath], repoPath);
}

/** Local branch short names; empty array on a repo without commits. */
export async function listBranches(repoPath: string): Promise<string[]> {
  try {
    const out = await git(['branch', '--format=%(refname:short)'], repoPath);
    return out === '' ? [] : out.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Branch currently checked out in a worktree ('HEAD' when detached). */
export async function currentBranch(worktreePath: string): Promise<string> {
  return git(['branch', '--show-current'], worktreePath);
}

/** Create `branch` from `startPoint` without checking it out anywhere. */
export async function createBranch(repoPath: string, branch: string, startPoint: string): Promise<void> {
  await git(['branch', branch, startPoint], repoPath);
}

/** Check out an existing branch inside a member's worktree. */
export async function checkout(worktreePath: string, branch: string): Promise<void> {
  await git(['checkout', branch], worktreePath);
}

/**
 * Merge `source` into `target`. The integration checkout (repoPath) normally
 * sits on the base branch; for a non-base target we temporarily check it out
 * there and restore the base branch afterwards.
 */
export async function mergeBranch(
  repoPath: string,
  source: string,
  target: string,
  baseBranch: string,
  message?: string,
): Promise<void> {
  const restore = target !== baseBranch;
  if (restore) await git(['checkout', target], repoPath);
  try {
    await git(
      [...COMMITTER, 'merge', '--no-ff', '-m', message ?? `merge: ${source} into ${target}`, source],
      repoPath,
    );
  } finally {
    if (restore) await git(['checkout', baseBranch], repoPath);
  }
}

/** Hard-delete a local branch (used when pruning finished task branches). */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await git(['branch', '-D', branch], repoPath);
}

/**
 * Stage everything under `pathspec` and commit with the plugin identity.
 * No-op when there is nothing to commit. Keeps the integration checkout
 * clean after task-contract rewrites (.tasks/*.md, _board.md).
 */
export async function commitAll(repoPath: string, pathspec: string, message: string): Promise<void> {
  await git(['add', '--', pathspec], repoPath);
  await git([...COMMITTER, 'commit', '-m', message, '--', pathspec], repoPath).catch((error: unknown) => {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    if (!/nothing to commit|no changes added/i.test(stderr)) throw error;
  });
}

// ── remote operations ───────────────────────────────────────────────────────

/**
 * Build the environment for authenticated remote operations. The SSH private
 * key is passed by VALUE through a temp file (mode 0600, removed by the
 * caller's finally) — the key material never touches the repo or the config.
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
 * Clone `url` into `dest`. Works for empty repositories: after the clone the
 * checkout may be unborn, in which case we create the base branch with an
 * initial empty commit so worktrees can fork from it.
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
    // Cloning an empty remote succeeds with a warning on most git versions,
    // but older versions exit non-zero after creating the directory.
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

/** True when `url` looks like an SSH remote (git@host:path or ssh://). */
export function isSshRemote(url: string): boolean {
  return url.startsWith('git@') || url.startsWith('ssh://');
}

/** Fetch all refs from origin. */
export async function fetchRemote(repoPath: string, env?: Record<string, string>): Promise<void> {
  await git(['fetch', 'origin', '--prune'], repoPath, { env });
}

/**
 * Push `branch` to origin with the safety rules of spec §4.5.5 baked in:
 *  - force push is only ever allowed on task branches, and only as
 *    --force-with-lease;
 *  - everything else is a plain fast-forward push.
 */
export async function pushBranch(
  repoPath: string,
  branch: string,
  options?: { env?: Record<string, string>; forceWithLease?: boolean },
): Promise<void> {
  const args = ['push', 'origin'];
  if (options?.forceWithLease === true) {
    if (!branch.startsWith('task/') && !branch.startsWith('member/')) {
      throw new GitError(
        `refusing to force-push shared branch "${branch}"; only task/member branches may use --force-with-lease`,
        '',
      );
    }
    args.push(`--force-with-lease=refs/heads/${branch}`);
  }
  args.push(`refs/heads/${branch}:refs/heads/${branch}`);
  await git(args, repoPath, { env: options?.env });
}

/** Resolve the sha of a (possibly remote) ref; null when it does not exist. */
export async function resolveRef(repoPath: string, ref: string): Promise<string | null> {
  try {
    return await git(['rev-parse', '--verify', ref], repoPath);
  } catch {
    return null;
  }
}

/** List files changed between two refs (diff --name-only). */
export async function changedFiles(repoPath: string, fromRef: string, toRef: string): Promise<string[]> {
  const out = await git(['diff', '--name-only', fromRef, toRef], repoPath);
  return out === '' ? [] : out.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * Pre-push guard (spec §4.5.3): reject when any path changed between
 * `fromRef..toRef` matches a forbidden prefix (human-only zone).
 * Returns the offending paths (empty array = clean).
 */
export async function forbiddenPathViolations(
  repoPath: string,
  fromRef: string,
  toRef: string,
  forbiddenPaths: readonly string[],
): Promise<string[]> {
  const files = await changedFiles(repoPath, fromRef, toRef);
  return files.filter((file) => forbiddenPaths.some((prefix) => file.startsWith(prefix) || file === prefix.replace(/\/$/, '')));
}

/** Number of commits on `branch` not reachable from `sinceRef` (git activity probe). */
export async function countNewCommits(repoPath: string, branch: string, sinceRef: string): Promise<number> {
  try {
    const out = await git(['rev-list', '--count', `${sinceRef}..${branch}`], repoPath);
    return Number.parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

/** Unix timestamp of the latest commit on a ref; null when none. */
export async function lastCommitAt(repoPath: string, ref: string): Promise<number | null> {
  try {
    const out = await git(['log', '-1', '--format=%ct', ref], repoPath);
    const seconds = Number.parseInt(out, 10);
    return Number.isNaN(seconds) ? null : seconds * 1000;
  } catch {
    return null;
  }
}
