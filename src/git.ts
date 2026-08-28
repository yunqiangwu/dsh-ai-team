/**
 * Thin promisified wrapper around the `git` CLI. All repository topology of
 * dsh-ai-team is built on top of these primitives:
 *
 *   <rootDir>/<teamId>/repo                 shared repository (integration
 *                                           checkout, always on baseBranch)
 *   <rootDir>/<teamId>/workspaces/<memberId> one isolated git worktree per
 *                                           member, sharing the same object
 *                                           store — branch collaboration for
 *                                           free, directory isolation by
 *                                           construction.
 *
 * Processes are short-lived `execFile` calls, so there is nothing to clean
 * up per call; callers that allocate long-lived resources must register them
 * with ctx.effect themselves.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'

const execFileAsync = promisify(execFile)

/** Identity used for commits the plugin itself creates (init, merges). */
const COMMITTER = ['-c', 'user.name=dsh-ai-team', '-c', 'user.email=dsh-ai-team@localhost']

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

/** Run git in `cwd`, returning trimmed stdout. Throws GitError on failure. */
export async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout.trim()
  } catch (error) {
    const err = error as { stderr?: string; message?: string }
    const stderr = (err.stderr ?? '').trim()
    throw new GitError(
      `git ${args.join(' ')} failed (cwd: ${cwd})${stderr ? `: ${stderr}` : ''}`,
      stderr,
    )
  }
}

async function isRepo(path: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--is-inside-work-tree'], path)
    return true
  } catch {
    return false
  }
}

async function hasCommits(path: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', 'HEAD'], path)
    return true
  } catch {
    return false
  }
}

/**
 * Ensure `path` is a git repository on `baseBranch` with at least one commit
 * (worktrees and merges need a HEAD to fork from).
 */
export async function ensureRepo(path: string, baseBranch: string): Promise<void> {
  await mkdir(path, { recursive: true })
  if (!(await isRepo(path))) {
    await git(['init', '-b', baseBranch], path)
  }
  if (!(await hasCommits(path))) {
    await git([...COMMITTER, 'commit', '--allow-empty', '-m', 'chore: initial commit'], path)
  }
}

/** Create branch `branch` from `startPoint` and check it out in a new worktree. */
export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  startPoint: string,
): Promise<void> {
  await mkdir(worktreePath, { recursive: true })
  const branches = await listBranches(repoPath)
  if (branches.includes(branch)) {
    await git(['worktree', 'add', worktreePath, branch], repoPath)
  } else {
    await git(['worktree', 'add', worktreePath, '-b', branch, startPoint], repoPath)
  }
}

/** Remove a worktree (member removal / explicit cleanup). Never deletes the repo. */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(['worktree', 'remove', '--force', worktreePath], repoPath)
}

/** Local branch short names; empty array on a repo without commits. */
export async function listBranches(repoPath: string): Promise<string[]> {
  try {
    const out = await git(['branch', '--format=%(refname:short)'], repoPath)
    return out === '' ? [] : out.split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/** Branch currently checked out in a worktree ('HEAD' when detached). */
export async function currentBranch(worktreePath: string): Promise<string> {
  return git(['branch', '--show-current'], worktreePath)
}

/** Create `branch` from `startPoint` without checking it out anywhere. */
export async function createBranch(
  repoPath: string,
  branch: string,
  startPoint: string,
): Promise<void> {
  await git(['branch', branch, startPoint], repoPath)
}

/** Check out an existing branch inside a member's worktree. */
export async function checkout(worktreePath: string, branch: string): Promise<void> {
  await git(['checkout', branch], worktreePath)
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
  const restore = target !== baseBranch
  if (restore) await git(['checkout', target], repoPath)
  try {
    await git(
      [...COMMITTER, 'merge', '--no-ff', '-m', message ?? `merge: ${source} into ${target}`, source],
      repoPath,
    )
  } finally {
    if (restore) await git(['checkout', baseBranch], repoPath)
  }
}

/** Hard-delete a local branch (used when pruning finished task branches). */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await git(['branch', '-D', branch], repoPath)
}
