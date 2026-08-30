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
import type { TeamRecord } from '../src/service/state.js';
import type { AutopilotService } from '../src/service.js';
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
  contract: { id: string; title: string; dependsOn?: string[]; touches?: string[]; forbidden?: string[]; priority?: number },
): Promise<void> {
  const depends = (contract.dependsOn ?? []).map((dep) => `  - ${dep}`).join('\n');
  const touches = (contract.touches ?? []).map((dir) => `  - ${dir}`).join('\n');
  const forbidden = (contract.forbidden ?? []).map((dir) => `  - ${dir}`).join('\n');
  const content = [
    '---',
    `id: ${contract.id}`,
    `title: ${contract.title}`,
    'status: pending',
    ...(contract.priority === undefined ? [] : [`priority: ${contract.priority}`]),
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
      // 0 = 关闭墙钟预算：既有用例不受派发时长影响。
      maxTaskHours: 0,
      // 0 = 关闭评审体量门：既有断言 approve 成功的用例行为保持不变。
      maxDiffLines: 0,
      maxDiffFiles: 0,
    },
    escalation: { label: 'needs-human', pauseOnEscalation: 'task' },
    // 用例默认 async：interactive 的 ask_human 会真的等人答复，忘了作答就是挂满超时。
    // 交互等待路径由 test-questionnaire.ts 显式覆盖 mode 后单独验证。
    questionnaire: { mode: 'async', timeoutMinutes: 60 },
    // 重规划护栏默认给一个宽裕值：个别用例（频率上限）自己 override 成小值。
    replan: { maxPerHour: 10 },
    docs: { draftDir: 'docs/drafts', formalDir: 'docs' },
    // 多周期开发：规模判断与边界请示是组长 AI 决策，配置只剩 roadmapPath。
    cycles: { roadmapPath: 'docs/ROADMAP.md' },
    deploy: { enabled: false, secretsEnv: [], skipTasksOnlyCommits: true },
    learnings: { ...DEFAULT_LEARNINGS },
    security: {
      forbiddenPaths: ['LICENSE'],
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

/** seedTeam 的契约形状（与 writeContract 一致）。 */
export interface SeedContract {
  id: string;
  title: string;
  dependsOn?: string[];
  touches?: string[];
  forbidden?: string[];
  priority?: number;
}

/**
 * 建团队 → 把契约写进集成检出并提交 → 逐个补成员。
 *
 * test-unattended 里曾长出两个几乎同构的本地 helper（serviceWithContracts /
 * seedTeamWithContract），questionnaire 与 integration 又各有第三、第四份变体
 * —— 这条链是每个循环用例的公共前缀，上收到这里避免继续分叉。
 * `cloneRemote: true` 让 repo 带上 origin（hasRemote 为真时 approve 的最后一步
 * push 才能真正走通）。
 */
export async function seedTeam(
  service: AutopilotService,
  input: {
    name: string;
    cloneRemote?: boolean;
    contracts?: SeedContract[];
    members?: { role: 'leader' | 'developer' | 'reviewer' | 'operator' }[];
  },
): Promise<TeamRecord> {
  const team = await service.createTeam({
    name: input.name,
    ...(input.cloneRemote === true ? { cloneRemote: true } : {}),
  });
  if ((input.contracts ?? []).length > 0) {
    for (const contract of input.contracts ?? []) {
      await writeContract(join(team.repoPath, '.tasks', `${contract.id}.md`), contract);
    }
    gitTest(['add', '-A'], team.repoPath);
    gitTest(['commit', '-m', 'tasks: seed contracts'], team.repoPath);
  }
  for (const member of input.members ?? []) {
    await service.addMember({ teamId: team.id, role: member.role });
  }
  return team;
}
