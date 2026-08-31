/**
 * Unattended-operation test: the security hard rules — command allowlist,
 * secret redaction, ref-name validation, and the requireCiGreen CI gate.
 */
import { describe, expect, it } from 'vitest';
import { AutopilotService } from '../../../src/service.js';
import { CommandNotAllowedError, runGateCommand } from '../../../src/gates.js';
import { SecretRedactor } from '../../../src/secrets.js';
import { gitTest, makeFixture, seedTeam, testOptions, commitInWorktree } from '../../helpers.js';
import type { Fixture, SeedContract } from '../../helpers.js';

async function serviceWithContracts(
  prefix: string,
  contracts: SeedContract[],
  overrides: Parameters<typeof testOptions>[1] = {},
): Promise<{ service: AutopilotService; teamId: string; fixture: Fixture; cleanup: () => Promise<void> }> {
  const fixture = await makeFixture(prefix);
  const service = await AutopilotService.create(testOptions(fixture, overrides));
  const team = await seedTeam(service, {
    name: `${prefix}-team`,
    contracts,
    members: [{ role: 'developer' }, { role: 'developer' }, { role: 'reviewer' }],
  });
  return {
    service,
    teamId: team.id,
    fixture,
    cleanup: async () => {
      await service.dispose();
    },
  };
}

/**
 * 与 serviceWithContracts 同构，但复用调用方的 service：调用方建 service 时已把
 * remote.url 指向自己 fixture 那个本地 bare 仓库，这里只补团队、契约与成员。
 */
async function seedTeamWithContract(
  service: AutopilotService,
  prefix: string,
  contracts: SeedContract[] = [{ id: 'CORE-1', title: 'core', touches: ['server/core/'] }],
): Promise<{ teamId: string; repoPath: string }> {
  const team = await seedTeam(service, {
    name: `${prefix}-team`,
    cloneRemote: true,
    contracts,
    members: [{ role: 'developer' }, { role: 'developer' }, { role: 'reviewer' }],
  });
  return { teamId: team.id, repoPath: team.repoPath };
}

/**
 * 走到达评审门槛的那几步：派发一个契约、提交改动、推到 in_review 并跑门。
 * @returns 任务与 developer / reviewer / leader 三个角色成员
 */
async function taskInReview(service: AutopilotService, teamId: string, contractId: string, file = 'work.ts') {
  await service.tickOnce();
  const team = service.teamView(teamId);
  const task = team.tasks.find((candidate) => candidate.contractId === contractId)!;
  const dev = team.members.find((member) => member.id === task.assigneeId)!;
  const reviewer = team.members.find((member) => member.role === 'reviewer')!;
  const leader = team.members.find((member) => member.role === 'leader')!;
  commitInWorktree(dev.workspacePath, file, 'export const a = 1;\n', 'feat: work');
  await service.updateTask({ taskId: task.id, status: 'in_review' });
  await service.runGatesForTask({ taskId: task.id });
  return { task, dev, reviewer, leader };
}

/**
 * approve 被挡住的可观测结果：任务没动，base 上也没长出合并提交。
 * 断言落在结果而非错误文案上 —— 临时目录名里就带着 "ci"，匹配 message 会假通过。
 */
function assertNotMerged(service: AutopilotService, teamId: string, repoPath: string, taskId: string): void {
  expect(service.teamView(teamId).tasks.find((task) => task.id === taskId)?.status).toBe('in_review');
  expect(gitTest(['log', '--format=%s', 'main'], repoPath)).not.toMatch(/^merge: task\//);
}

describe('unattended: security hard rules', () => {
  it('command allowlist rejects non-allowlisted gate commands', async () => {
    const fixture = await makeFixture('allowlist');
    const redactor = new SecretRedactor();
    await expect(
      runGateCommand('rm -rf /', {
        cwd: fixture.root,
        commands: [],
        allowlist: ['git', 'pnpm'],
        timeoutMs: 5000,
        redactor,
        taskId: 't',
        branch: 'b',
      }),
    ).rejects.toThrow(CommandNotAllowedError);
    // Allowlisted prefix passes and captures output.
    const result = await runGateCommand('git --version', {
      cwd: fixture.root,
      commands: [],
      allowlist: ['git', 'pnpm'],
      timeoutMs: 5000,
      redactor,
      taskId: 't',
      branch: 'b',
    });
    expect(result.passed).toBe(true);
    expect(result.logTail).toContain('git version');
  });

  it('secrets never survive into logs (redaction)', async () => {
    process.env['AUTOPILOT_TEST_SECRET'] = 'super-secret-token-value';
    try {
      const fixture = await makeFixture('redact');
      const redactor = new SecretRedactor();
      redactor.registerEnvNames(['AUTOPILOT_TEST_SECRET']);
      const result = await runGateCommand('echo "token is $AUTOPILOT_TEST_SECRET"', {
        cwd: fixture.root,
        commands: [],
        allowlist: ['echo', 'sh', 'git'],
        timeoutMs: 5000,
        redactor,
        taskId: 't',
        branch: 'b',
      });
      expect(result.logTail).not.toContain('super-secret-token-value');
      expect(result.logTail).toContain('***');
    } finally {
      delete process.env['AUTOPILOT_TEST_SECRET'];
    }
  });

  it('escalation webhook payload is redacted and delivery failure is data', async () => {
    process.env['AUTOPILOT_TEST_WEBHOOK'] = 'http://webhook.local/notify';
    process.env['AUTOPILOT_TEST_SECRET2'] = 'another-secret-value';
    try {
      const fixture = await makeFixture('webhook');
      const bodies: string[] = [];
      const fetchFn = ((url: string, init?: RequestInit) => {
        expect(url).toBe('http://webhook.local/notify');
        bodies.push(String(init?.body ?? ''));
        return Promise.resolve(new Response('ok', { status: 200 }));
      }) as typeof fetch;
      const service = await AutopilotService.create(
        testOptions(fixture, {
          escalation: { webhookUrlEnv: 'AUTOPILOT_TEST_WEBHOOK', label: 'needs-human', pauseOnEscalation: 'task' },
          fetchFn,
        }),
      );
      try {
        service.redactor.register('another-secret-value');
        const record = await service.escalateTask({
          taskId: null,
          reason: 'manual',
          message: 'leaking another-secret-value here',
          suggestion: 'rotate keys',
        });
        expect(record.webhookDelivered).toBe(true);
        expect(record.message).not.toContain('another-secret-value');
        expect(bodies[0]).not.toContain('another-secret-value');
      } finally {
        await service.dispose();
      }
    } finally {
      delete process.env['AUTOPILOT_TEST_WEBHOOK'];
      delete process.env['AUTOPILOT_TEST_SECRET2'];
    }
  });

  it('force-push to shared branches is refused (force-with-lease only for task branches)', async () => {
    const { pushBranch } = await import('../../../src/git.js');
    const fixture = await makeFixture('forcepush');
    await expect(
      pushBranch(fixture.remotePath, 'main', { forceWithLease: true }),
    ).rejects.toThrow(/force-push/);
  });

  it('option-like branch names are refused instead of reaching git argv', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('refinject', [
      { id: 'CORE-1', title: 'core', touches: ['server/core/'] },
    ]);
    try {
      // 先建一条正常分支作为受害者：它没有被任何 worktree 检出，
      // 因此 `git branch -D <victim>` 在今天会真的执行成功。
      await service.branch({ teamId, action: 'create', branch: 'task/victim' });
      expect(service.teamView(teamId).branches).toContain('task/victim');

      // team_branch 的 branch 参数由模型自由填写：`-D` 会被拼成
      // `git branch -D task/victim`，把别人的任务分支静默删掉。
      await expect(
        service.branch({ teamId, action: 'create', branch: '-D', target: 'task/victim' }),
      ).rejects.toThrow(/invalid branch name/i);
      expect(service.teamView(teamId).branches).toContain('task/victim');

      // 其它选项注入与非法字符同样要挡住。
      await expect(
        service.branch({ teamId, action: 'merge', branch: '--abort', target: 'main' }),
      ).rejects.toThrow(/invalid branch name/i);
      await expect(
        service.branch({ teamId, action: 'create', branch: 'task/; rm -rf .' }),
      ).rejects.toThrow(/invalid branch name/i);

      // 合法名字仍然要放行（含 profile 模板渲染出的 task/<id>）。
      await service.branch({ teamId, action: 'create', branch: 'task/CORE-1_rework-2' });
      expect(service.teamView(teamId).branches).toContain('task/CORE-1_rework-2');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('requireCiGreen blocks approve when CI status was never verified', async () => {
    const fixture = await makeFixture('cinever');
    const service = await AutopilotService.create(
      testOptions(fixture, {
        remote: { url: fixture.remotePath, sshKeyEnv: 'AUTOPILOT_TEST_GIT_KEY', platform: 'github' },
        gates: { commands: ['git --version'], requireCiGreen: true, timeoutMinutes: 1 },
      }),
    );
    try {
      const { teamId, repoPath } = await seedTeamWithContract(service, 'cinever');
      const { task, reviewer } = await taskInReview(service, teamId, 'CORE-1');
      // 门全绿、契约齐备，但从未 pr_sync 过 → ciStatus 仍是 null。
      // 今天这个 null 让整条 CI 判定消失，等于 requireCiGreen 形同关闭。
      expect(service.teamView(teamId).tasks.find((t) => t.id === task.id)?.ciStatus).toBeNull();
      await expect(
        service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' }),
      ).rejects.toThrow();
      assertNotMerged(service, teamId, repoPath, task.id);
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('requireCiGreen still applies when pushRequiresGates is off', async () => {
    const fixture = await makeFixture('ciindep');
    const service = await AutopilotService.create(
      testOptions(fixture, {
        remote: { url: fixture.remotePath, sshKeyEnv: 'AUTOPILOT_TEST_GIT_KEY', platform: 'github' },
        gates: { commands: ['git --version'], requireCiGreen: true, timeoutMinutes: 1 },
        security: {
          forbiddenPaths: ['LICENSE'],
          commandAllowlist: ['git', 'pnpm', 'sh', 'echo'],
          pushRequiresGates: false,
        },
      }),
    );
    try {
      const { teamId, repoPath } = await seedTeamWithContract(service, 'ciindep');
      const { task, reviewer } = await taskInReview(service, teamId, 'CORE-1');
      // 门全绿（pushRequiresGates 关闭时不看门），但 CI 从未验证过。
      // CI 门属于远端侧约束，不该被 pushRequiresGates 这个本地开关整体短路。
      await expect(
        service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' }),
      ).rejects.toThrow();
      assertNotMerged(service, teamId, repoPath, task.id);
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('requireCiGreen does not block platforms that cannot report CI status', async () => {
    const fixture = await makeFixture('cigeneric');
    const service = await AutopilotService.create(
      testOptions(fixture, {
        remote: { url: fixture.remotePath, sshKeyEnv: 'AUTOPILOT_TEST_GIT_KEY', platform: 'generic' },
        gates: { commands: ['git --version'], requireCiGreen: true, timeoutMinutes: 1 },
      }),
    );
    try {
      const { teamId } = await seedTeamWithContract(service, 'cigeneric');
      const { task, reviewer } = await taskInReview(service, teamId, 'CORE-1');
      // 特征测试：prSync 在非 github 平台恒置 ciStatus='unknown'，若把它当
      // 「未绿」，默认配置（platform generic + requireCiGreen true）将永远无法 approve。
      const verdict = await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' });
      expect(verdict.merged).toBe(true);
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('rewriting AGENTS.md no longer trips the forbidden gate (default list is LICENSE only)', async () => {
    const fixture = await makeFixture('agents-ok');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      const { teamId, repoPath } = await seedTeamWithContract(service, 'agents-ok');
      const { task, dev, reviewer } = await taskInReview(service, teamId, 'CORE-1');
      // 2026-08-29：AGENTS.md 移出默认禁区，改它、提交它、合它都不该再被拦。
      commitInWorktree(dev.workspacePath, 'AGENTS.md', '# rewritten by the leader\n', 'docs: promote a lesson');
      const verdict = await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' });
      expect(verdict.merged).toBe(true);
      expect(gitTest(['log', '--format=%s', 'main'], repoPath)).toContain('merge: task/CORE-1');
      expect(gitTest(['show', 'main:AGENTS.md'], repoPath)).toContain('rewritten by the leader');
      expect(service.escalations.all.some((record) => record.reason === 'forbidden-paths')).toBe(false);
    } finally {
      await service.dispose();
    }
  }, 60_000);
});