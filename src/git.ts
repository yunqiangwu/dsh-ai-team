// Git backend abstraction.
//
// The plugin models "one shared repository + N isolated agent workspaces" using
// git worktrees: a single repository holds the objects and refs, and each member
// gets its own working directory (a worktree) on its own branch. Worktrees
// share the same `.git`, so branches, merges and history are visible across all
// members while their working trees stay isolated.
//
// `GitBackend` is an interface so the service can be tested with an in-memory
// fake instead of a real git binary (see test/team-service.test.ts).

import { execFile } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileP = promisify(execFile);

export interface GitBackend {
  init(repoPath: string): Promise<void>;
  addWorktree(repoPath: string, path: string, branch: string): Promise<void>;
  checkout(path: string, branch: string): Promise<void>;
  createBranch(path: string, branch: string): Promise<void>;
  merge(path: string, source: string): Promise<{ conflict: boolean }>;
  status(path: string): Promise<{ branch: string; dirty: boolean }>;
  diffStat(path: string, base: string, head?: string): Promise<{ files: number; insertions: number; deletions: number }>;
  listBranches(repoPath: string): Promise<string[]>;
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, signal, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/**
 * Real git implementation backed by the `git` CLI available on the host.
 */
export class CliGit implements GitBackend {
  async init(repoPath: string): Promise<void> {
    await mkdir(repoPath, { recursive: true });
    await git(repoPath, ['init', '-q']);
    // Worktrees require at least one commit on the default branch.
    const readme = join(repoPath, 'README.md');
    await writeFile(readme, `# ${repoPath}\n\nShared repository for dsh-ai-team.\n`, 'utf8');
    await git(repoPath, ['add', 'README.md']);
    await git(repoPath, ['commit', '-q', '-m', 'chore: bootstrap shared repository']);
  }

  async addWorktree(repoPath: string, path: string, branch: string): Promise<void> {
    await mkdir(path, { recursive: true });
    // `-b <branch>` creates the branch if it does not exist yet.
    await git(repoPath, ['worktree', 'add', '-b', branch, path]);
  }

  async checkout(path: string, branch: string): Promise<void> {
    await git(path, ['checkout', '-q', branch]);
  }

  async createBranch(path: string, branch: string): Promise<void> {
    await git(path, ['checkout', '-q', '-b', branch]);
  }

  async merge(path: string, source: string): Promise<{ conflict: boolean }> {
    try {
      await git(path, ['merge', '--no-edit', source]);
      return { conflict: false };
    } catch {
      // A non-zero exit from `git merge` may indicate conflicts.
      const out = await git(path, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
      return { conflict: out.trim().length > 0 };
    }
  }

  async status(path: string): Promise<{ branch: string; dirty: boolean }> {
    const branch = (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const porcelain = (await git(path, ['status', '--porcelain'])).trim();
    return { branch, dirty: porcelain.length > 0 };
  }

  async diffStat(path: string, base: string, head?: string): Promise<{ files: number; insertions: number; deletions: number }> {
    const range = head ? `${base}...${head}` : base;
    const out = (await git(path, ['diff', '--shortstat', range])).trim();
    // Example: " 3 files changed, 12 insertions(+), 4 deletions(-)"
    const files = Number(out.match(/(\d+)\s+files? changed/)?.at(1) ?? 0);
    const insertions = Number(out.match(/(\d+)\s+insertions?\(\+\)/)?.at(1) ?? 0);
    const deletions = Number(out.match(/(\d+)\s+deletions?\(-\)/)?.at(1) ?? 0);
    return { files, insertions, deletions };
  }

  async listBranches(repoPath: string): Promise<string[]> {
    const out = (await git(repoPath, ['branch', '--format=%(refname:short)'])).trim();
    return out.length ? out.split('\n').map((b) => b.trim()).filter(Boolean) : [];
  }
}

/** Recursively remove a worktree and its branch (best-effort, used in tests/cleanup). */
export async function removeWorktree(repoPath: string, path: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', path, '--force']).catch(() => {});
  await rm(path, { recursive: true, force: true });
}
