/**
 * Shared test fixtures: temp directories, REAL git repositories (a local
 * bare repo plays the remote — git behavior is never mocked), task-contract
 * writers, and a fast AutopilotOptions factory.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutopilotOptions } from '../src/service/options.js';
import { defaultProfile } from '../src/profile.js';
import { DEFAULT_LEARNINGS } from '../src/learnings.js';

export function sh(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    .toString()
    .trim();
}

export function gitTest(args: string[], cwd: string): string {
  return sh('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', ...args], cwd);
}

export interface Fixture {
  root: string;
  stateDir: string;
  /** Local bare repo playing the role of the remote. */
  remotePath: string;
}

export async function makeFixture(prefix: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `dsh-ai-team-${prefix}-`));
  const stateDir = join(root, 'state');
  const remotePath = join(root, 'remote.git');
  await mkdir(stateDir, { recursive: true });
  gitTest(['init', '--bare', '-b', 'main', remotePath], root);
  return { root, stateDir, remotePath };
}

/** Seed the bare remote with one commit containing .tasks contracts. */
export async function seedRemote(
  fixture: Fixture,
  contracts: { id: string; title: string; dependsOn?: string[]; touches?: string[] }[],
): Promise<void> {
  const work = join(fixture.root, 'seed-work');
  gitTest(['clone', fixture.remotePath, work], fixture.root);
  await mkdir(join(work, '.tasks'), { recursive: true });
  for (const contract of contracts) {
    await writeContract(join(work, '.tasks', `${contract.id}.md`), contract);
  }
  await writeFile(join(work, 'README.md'), '# seeded project\n', 'utf8');
  gitTest(['add', '-A'], work);
  gitTest(['commit', '-m', 'chore: seed'], work);
  gitTest(['push', 'origin', 'main'], work);
}

export async function writeContract(
  path: string,
  contract: { id: string; title: string; dependsOn?: string[]; touches?: string[]; forbidden?: string[] },
): Promise<void> {
  const depends = (contract.dependsOn ?? []).map((dep) => `  - ${dep}`).join('\n');
  const touches = (contract.touches ?? []).map((dir) => `  - ${dir}`).join('\n');
  const forbidden = (contract.forbidden ?? []).map((dir) => `  - ${dir}`).join('\n');
  const content = [
    '---',
    `id: ${contract.id}`,
    `title: ${contract.title}`,
    'status: pending',
    ...(depends === '' ? [] : ['depends_on:', depends]),
    ...(touches === '' ? [] : ['touches:', touches]),
    ...(forbidden === '' ? [] : ['forbidden:', forbidden]),
    '---',
    '',
    `# ${contract.title}`,
    '',
    '```gherkin',
    'Given the repository',
    'When the task is implemented',
    'Then the acceptance criterion holds',
    '```',
    '',
  ].join('\n');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

export function testOptions(fixture: Fixture, overrides: Partial<AutopilotOptions> = {}): AutopilotOptions {
  return {
    rootDir: join(fixture.root, 'autopilot'),
    stateDir: fixture.stateDir,
    baseBranch: 'main',
    maxMembers: 8,
    maxTasks: 512,
    remote: { url: '', sshKeyEnv: 'AUTOPILOT_TEST_GIT_KEY', platform: 'generic' },
    bootstrap: { enabled: false, toolchain: [], setupCommand: '', verifyCommand: '' },
    gates: {
      commands: ['git --version'],
      requireCiGreen: false,
      timeoutMinutes: 1,
    },
    daemon: {
      maxReviewRounds: 3,
      stuckMinutes: 45,
      pollIntervalSeconds: 1,
      // 0 = 关闭评审体量门：既有断言 approve 成功的用例行为保持不变。
      maxDiffLines: 0,
      maxDiffFiles: 0,
    },
    escalation: { label: 'needs-human', pauseOnEscalation: 'task' },
    deploy: { enabled: false, secretsEnv: [], skipTasksOnlyCommits: true },
    learnings: { ...DEFAULT_LEARNINGS },
    security: {
      forbiddenPaths: ['.github/', 'AGENTS.md', 'LICENSE'],
      commandAllowlist: ['git', 'pnpm', 'sh', 'echo'],
      pushRequiresGates: true,
    },
    // Legacy default profile: historical behavior (task/<id>, no-ff, gates
    // fall back to gates.commands above). Override per-test via `profile`.
    profile: defaultProfile(),
    tickSleepMs: 20,
    ...overrides,
  };
}

/** Commit a file inside a member worktree (simulates developer output). */
export function commitInWorktree(worktreePath: string, relativePath: string, content: string, message: string): void {
  execFileSync('mkdir', ['-p', join(relativePath, '..')], { cwd: worktreePath });
  execFileSync('sh', ['-c', `printf '%s' "$CONTENT" > "$FILE"`], {
    cwd: worktreePath,
    env: { ...process.env, CONTENT: content, FILE: relativePath },
  });
  gitTest(['add', '-A'], worktreePath);
  gitTest(['commit', '-m', message], worktreePath);
}
