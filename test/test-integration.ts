// Integration scenario: simulate a multi-agent software team collaborating on a
// shared repository.
//
//   pnpm test:integration
//
// Uses the REAL git CLI (git worktrees) when `git` is on PATH, otherwise falls
// back to an in-memory fake so the scenario still runs in CI without git.

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamService } from '../src/service.js';
import { CliGit, type GitBackend } from '../src/git.js';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function commit(workspacePath: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: workspacePath, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: workspacePath, stdio: 'ignore' });
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-team-int-'));
  const git: GitBackend = hasGit() ? new CliGit() : (await import('./fake-git.js')).FakeGit;
  const service = new TeamService({ stateDir: dir, git });

  console.log('🚀 Scenario: a leader spins up an AI dev team\n');

  // 1. Leader creates the team.
  const team = await service.createTeam({
    name: 'Checkout Service',
    members: [
      { role: 'leader', name: 'Ada' },
      { role: 'developer', name: 'Bot-Dev-1' },
      { role: 'developer', name: 'Bot-Dev-2' },
      { role: 'reviewer', name: 'Bot-Rev' },
    ],
  });
  console.log(`  • Team "${team.name}" created with ${team.members.length} members (leader=${team.leaderId?.slice(0, 8)}).`);
  console.log(`  • Shared repository: ${team.repositoryPath}`);

  // 2. Leader assigns tasks to developers.
  const dev1 = team.members.find((m) => m.name === 'Bot-Dev-1')!;
  const task = await service.assignTask(team.id, {
    title: 'Implement login endpoint',
    description: 'Add POST /login with JWT issuance.',
    assigneeId: dev1.id,
    priority: 'high',
    branch: 'feature/login',
  });
  console.log(`  • Task "${task.title}" assigned to ${dev1.name} (status=${task.status}).`);

  // 3. Developer creates a branch and "writes code".
  await service.createBranch(team.id, dev1.id, 'feature/login');
  if (hasGit()) {
    await writeFile(join(dev1.workspacePath, 'login.ts'), 'export const login = () => "ok";\n', 'utf8');
    commit(dev1.workspacePath, 'feat: implement login endpoint');
  }
  console.log(`  • ${dev1.name} created branch "feature/login" and pushed a commit.`);

  // 4. Reviewer reviews the branch (base = the repo's default branch).
  const defaultBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: team.repositoryPath,
  })
    .toString()
    .trim();
  const review = await service.reviewCode(team.id, { branch: 'feature/login', base: defaultBranch });
  console.log(`  • Review of "feature/login": ${review.approved ? 'APPROVED' : 'CHANGES REQUESTED'} (${review.diffStat.files} files, +${review.diffStat.insertions}/-${review.diffStat.deletions}).`);
  for (const c of review.comments) console.log(`      [${c.severity}] ${c.message}`);

  // 5. Leader merges the feature branch into the reviewer's workspace (shared repo).
  const reviewer = team.members.find((m) => m.role === 'reviewer')!;
  const merge = await service.mergeBranch(team.id, reviewer.id, 'feature/login');
  console.log(`  • Merged "feature/login" → ${reviewer.name}'s workspace. conflict=${merge.conflict}.`);

  // 6. Final snapshot.
  const snap = service.snapshot();
  console.log(`\n✅ Done. Teams: ${snap.teams.length}, members: ${snap.teams[0].members.length}, tasks: ${snap.teams[0].tasks.length}.`);

  await service.disposeTeam(team.id);
  await rm(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('Integration scenario failed:', err);
  process.exit(1);
});
