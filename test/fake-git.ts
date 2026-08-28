// In-memory git backend used by the integration scenario when the `git` CLI is
// not available. Implements the same GitBackend interface as CliGit so the
// scenario runs identically (minus real on-disk worktrees).

import type { GitBackend } from '../src/git.js';

export class FakeGit implements GitBackend {
  async init(): Promise<void> {}
  async addWorktree(): Promise<void> {}
  async checkout(): Promise<void> {}
  async createBranch(): Promise<void> {}
  async merge(): Promise<{ conflict: boolean }> {
    return { conflict: false };
  }
  async status(): Promise<{ branch: string; dirty: boolean }> {
    return { branch: 'main', dirty: false };
  }
  async diffStat(_path: string, _base: string, _head?: string): Promise<{ files: number; insertions: number; deletions: number }> {
    return { files: 1, insertions: 12, deletions: 0 };
  }
  async listBranches(): Promise<string[]> {
    return ['main'];
  }
}
