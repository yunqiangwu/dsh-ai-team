/**
 * Integration test: the full unattended lifecycle against REAL git
 * repositories (a local bare repo plays the remote — no git mocking):
 *
 *   init (clone) → team → contract-driven assign → develop → gates →
 *   gated review → merge --no-ff → push to remote → pr_sync guards →
 *   deploy (mocked HTTP health check only) → status.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../src/service.js';
import { autopilotProjectionSchema } from '../src/schema.js';
import { gitTest, makeFixture, seedRemote, testOptions, writeContract, commitInWorktree } from './helpers.js';

describe('integration: full lifecycle', () => {
  it('clone → team → assign → gates → review → merge → remote push', async () => {
    const fixture = await makeFixture('lifecycle');
    await seedRemote(fixture, [{ id: 'CORE-1', title: 'set up core module', touches: ['server/core/'] }]);
    const service = await AutopilotService.create(
      testOptions(fixture, {
        remote: { url: fixture.remotePath, sshKeyEnv: 'AUTOPILOT_TEST_GIT_KEY', platform: 'generic' },
      }),
    );
    try {
      // 1. autopilot_init clones the remote into the team repo.
      const init = await service.initAutopilot('lifecycle-team');
      expect(init.teamId).toMatch(/^team_/);
      const team = service.teamView(init.teamId);
      expect(team.members).toHaveLength(1);
      expect(team.members[0]?.role).toBe('leader');
      // The cloned repo carries the seeded contract.
      const contract = await readFile(join(team.repoPath, '.tasks', 'CORE-1.md'), 'utf8');
      expect(contract).toContain('id: CORE-1');

      // 2. Roster: exactly one leader; dev + reviewer + operator join.
      await expect(service.addMember({ teamId: team.id, role: 'leader' })).rejects.toThrow(/already has a leader/);
      const dev = await service.addMember({ teamId: team.id, role: 'developer' });
      const reviewer = await service.addMember({ teamId: team.id, role: 'reviewer' });
      const ops = await service.addMember({ teamId: team.id, role: 'operator' });
      expect(dev.workspacePath).toContain('workspaces');
      expect(ops.role).toBe('operator');

      // 3. Contract-bound assignment: branch task/CORE-1 checked out in the
      //    dev worktree; contract patched to in_progress.
      const task = await service.assignTask({
        teamId: team.id,
        title: 'set up core module',
        assigneeId: dev.id,
        contractId: 'CORE-1',
      });
      expect(task.branch).toBe('task/CORE-1');
      expect(task.status).toBe('in_progress');
      expect(task.touches).toEqual(['server/core/']);
      const patched = await readFile(join(team.repoPath, '.tasks', 'CORE-1.md'), 'utf8');
      expect(patched).toContain('status: in_progress');
      // Assigning the same contract again is rejected.
      await expect(
        service.assignTask({ teamId: team.id, title: 'dup', assigneeId: dev.id, contractId: 'CORE-1' }),
      ).rejects.toThrow();

      // 4. Developer output on the task branch.
      commitInWorktree(dev.workspacePath, 'server/core/index.ts', 'export const core = true;\n', 'feat: core module');

      // 5. Review flow: approve is REJECTED before gates run green.
      await service.updateTask({ taskId: task.id, status: 'in_review' });
      await expect(
        service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' }),
      ).rejects.toThrow(/gates/i);
      // Reviewers cannot be assigned code tasks; devs cannot review.
      await expect(
        service.assignTask({ teamId: team.id, title: 'x', assigneeId: reviewer.id }),
      ).rejects.toThrow(/reviewer/);
      await expect(
        service.review({ taskId: task.id, reviewerId: dev.id, verdict: 'approve' }),
      ).rejects.toThrow(/developers cannot review/);

      // 6. gates_run: allowlisted command passes, summary stored on the task.
      const gates = await service.runGatesForTask({ taskId: task.id });
      expect(gates.allPassed).toBe(true);
      expect(gates.results[0]?.command).toBe('git --version');

      // 7. Approve → --no-ff merge into main, task done, contract done,
      //    board regenerated, base pushed to the remote.
      const verdict = await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' });
      expect(verdict.merged).toBe(true);
      expect(verdict.task.status).toBe('done');
      const merged = gitTest(['log', '--format=%s', 'main'], team.repoPath);
      expect(merged).toContain('merge: task/CORE-1');
      const fileOnMain = gitTest(['show', 'main:server/core/index.ts'], team.repoPath);
      expect(fileOnMain).toContain('core = true');
      const doneContract = await readFile(join(team.repoPath, '.tasks', 'CORE-1.md'), 'utf8');
      expect(doneContract).toContain('status: done');
      const board = await readFile(join(team.repoPath, '.tasks', '_board.md'), 'utf8');
      expect(board).toContain('CORE-1');
      // Remote received the merged base branch.
      const remoteMain = gitTest(['log', '--format=%s', 'main'], fixture.remotePath);
      expect(remoteMain).toContain('merge: task/CORE-1');

      // 8. Task branch pruned after merge.
      await service.pruneTaskBranch(task.id);
      expect(service.teamView(team.id).branches).not.toContain('task/CORE-1');
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('pr_sync enforces gates and forbidden paths against a real remote', async () => {
    const fixture = await makeFixture('prsync');
    await seedRemote(fixture, []);
    const service = await AutopilotService.create(
      testOptions(fixture, {
        remote: { url: fixture.remotePath, sshKeyEnv: 'AUTOPILOT_TEST_GIT_KEY', platform: 'generic' },
        // `.github/` 自 2026-08-29 起不在默认禁区里（默认只剩 LICENSE）：这里显式配回来，
        // 顺带锁住「需要保护 CI 配置的项目自己加 forbiddenPaths」这条出路真的有效。
        security: {
          forbiddenPaths: ['.github/'],
          commandAllowlist: ['git', 'pnpm', 'sh', 'echo'],
          pushRequiresGates: true,
        },
      }),
    );
    try {
      const team = await service.createTeam({ name: 'pr-team', cloneRemote: true });
      const dev = await service.addMember({ teamId: team.id, role: 'developer' });
      const task = await service.assignTask({ teamId: team.id, title: 'feature work', assigneeId: dev.id });

      // Gates red → push blocked (pushRequiresGates).
      await expect(service.prSync({ taskId: task.id })).rejects.toThrow(/pushRequiresGates|gates/i);

      // Forbidden path in the branch diff → blocked + escalated.
      await service.runGatesForTask({ taskId: task.id });
      commitInWorktree(dev.workspacePath, '.github/workflows/ci.yml', 'on: push\n', 'ci: add workflow');
      await expect(service.prSync({ taskId: task.id })).rejects.toThrow(/forbidden paths/);
      const escalations = service.escalations.all;
      expect(escalations.some((record) => record.reason === 'forbidden-paths')).toBe(true);

      // Remove the forbidden commit, push succeeds, branch lands on remote.
      // (The escalation switched the worktree back to the member branch.)
      gitTest(['checkout', task.branch], dev.workspacePath);
      gitTest(['reset', '--hard', 'HEAD~1'], dev.workspacePath);
      commitInWorktree(dev.workspacePath, 'src/feature.ts', 'export {};\n', 'feat: real work');
      const synced = await service.prSync({ taskId: task.id });
      expect(synced.pushed).toBe(true);
      const remoteBranch = gitTest(['branch', '-a'], fixture.remotePath);
      expect(remoteBranch).toContain(task.branch);
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('deploy_run: healthy deploy, rollback on failed health check, escalation', async () => {
    const fixture = await makeFixture('deploy');
    const service = await AutopilotService.create(
      testOptions(fixture, {
        deploy: {
          enabled: true,
          command: 'git --version',
          healthCheckUrl: 'http://health.local/check',
          rollbackCommand: 'git --version',
          secretsEnv: [],
        },
        // Only the HTTP health check is mocked; everything else is real.
        fetchFn: (() => Promise.resolve(new Response('ok', { status: 200 }))) as typeof fetch,
      }),
    );
    try {
      const team = await service.createTeam({ name: 'deploy-team' });
      // Healthy: the health endpoint answers 200.
      const healthy = await service.deployRun(team.id);
      expect(healthy.status).toBe('healthy');
      // 部署记录归属触发它的团队（TECH-4：面板按 teamId 过滤部署历史）。
      expect(healthy.teamId).toBe(team.id);
      expect(autopilotProjectionSchema.parse(service.projection()).deploys[0]?.teamId).toBe(team.id);

      // Unhealthy: 3 failed probes → rollback runs → rolled-back + escalation.
      const service2 = await AutopilotService.create(
        testOptions(fixture, {
          stateDir: join(fixture.root, 'state2'),
          deploy: {
            enabled: true,
            command: 'git --version',
            healthCheckUrl: 'http://health.local/check',
            rollbackCommand: 'git --version',
            secretsEnv: [],
          },
          fetchFn: (() => Promise.resolve(new Response('down', { status: 503 }))) as typeof fetch,
        }),
      );
      try {
        const team2 = await service2.createTeam({ name: 'deploy-team-2' });
        const failed = await service2.deployRun(team2.id);
        expect(failed.status).toBe('rolled-back');
        expect(
          service2.escalations.all.some((record) => record.reason === 'deploy-failed'),
        ).toBe(true);
      } finally {
        await service2.dispose();
      }
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('approve refuses to merge forbidden-path changes even with green gates', async () => {
    const fixture = await makeFixture('approve-forbidden');
    await seedRemote(fixture, [{ id: 'CORE-9', title: 'core work', touches: ['server/core/'] }]);
    const service = await AutopilotService.create(
      testOptions(fixture, {
        remote: { url: fixture.remotePath, sshKeyEnv: 'AUTOPILOT_TEST_GIT_KEY', platform: 'generic' },
      }),
    );
    try {
      const team = await service.createTeam({ name: 'guard-team', cloneRemote: true });
      const dev = await service.addMember({ teamId: team.id, role: 'developer' });
      const reviewer = await service.addMember({ teamId: team.id, role: 'reviewer' });
      const task = await service.assignTask({
        teamId: team.id,
        title: 'core work',
        assigneeId: dev.id,
        contractId: 'CORE-9',
      });
      // 开发者把改动写进了禁区（LICENSE 是默认 security.forbiddenPaths 里唯一剩下的路径）。
      commitInWorktree(dev.workspacePath, 'server/core/index.ts', 'export const core = 1;\n', 'feat: core');
      commitInWorktree(dev.workspacePath, 'LICENSE', 'rewritten by the agent\n', 'docs: rewrite license');
      await service.updateTask({ taskId: task.id, status: 'in_review' });
      const gates = await service.runGatesForTask({ taskId: task.id });
      expect(gates.allPassed).toBe(true);

      // 门全绿也不能成为绕过禁区的理由：此前 assertBranchDiffAllowed 只挂在
      // pr_sync 上，approve 直接 merge + push base，禁区改动就这么进了主干。
      await expect(
        service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' }),
      ).rejects.toThrow(/forbidden/i);
      // 触及禁区按设计要升级并挂起任务（不是留在 in_review 等着被重试）。
      expect(service.teamView(team.id).tasks.find((t) => t.id === task.id)?.status).toBe('needs-human');
      expect(service.escalations.all.some((record) => record.reason === 'forbidden-paths')).toBe(true);
      // base 与远端都不能出现那份改写（用 ls-tree：文件不存在时 git show 会非零退出）。
      expect(gitTest(['ls-tree', '-r', '--name-only', 'main'], team.repoPath)).not.toContain('LICENSE');
      expect(gitTest(['ls-tree', '-r', '--name-only', 'main'], fixture.remotePath)).not.toContain('LICENSE');
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('a failing rollback is reported as rollback-failed, not rolled-back', async () => {
    const fixture = await makeFixture('rollback-failed');
    const service = await AutopilotService.create(
      testOptions(fixture, {
        deploy: {
          enabled: true,
          command: 'git --version',
          healthCheckUrl: 'http://health.local/check',
          // 健康检查失败后跑这条回滚命令，它以 7 退出。
          rollbackCommand: 'sh -c "exit 7"',
          secretsEnv: [],
        },
        // 健康探测恒 503 → 必定走到回滚分支。
        fetchFn: (() => Promise.resolve(new Response('down', { status: 503 }))) as typeof fetch,
      }),
    );
    try {
      const team = await service.createTeam({ name: 'rollback-team' });
      const view = await service.deployRun(team.id);
      // 今天 rollback.exitCode 被读出来就丢掉，无条件置 rolled-back：
      // 人看到"已回滚"就不会去救火，而线上其实是坏的。
      expect(view.status).toBe('rollback-failed');
      expect(view.logTail).toContain('[rollback]');
      const escalated = service.escalations.all.filter((record) => record.reason === 'deploy-failed');
      expect(escalated.length).toBeGreaterThan(0);
      expect(escalated[escalated.length - 1]?.message).toMatch(/rollback/i);
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('task contracts on an empty remote drive the board end to end', async () => {
    const fixture = await makeFixture('empty-remote');
    // Empty bare remote: clone must still yield a working base branch.
    const service = await AutopilotService.create(
      testOptions(fixture, {
        remote: { url: fixture.remotePath, sshKeyEnv: 'AUTOPILOT_TEST_GIT_KEY', platform: 'generic' },
      }),
    );
    try {
      const init = await service.initAutopilot('empty-remote-team');
      const team = service.teamView(init.teamId);
      expect(team.branches).toContain('main');
      // The remote now has the initial commit pushed by cloneRemote.
      const remoteLog = gitTest(['log', '--format=%s'], fixture.remotePath);
      expect(remoteLog).toContain('initial commit');
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('writes contracts through the full assign → done cycle (no remote)', async () => {
    const fixture = await makeFixture('local-only');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      const team = await service.createTeam({ name: 'local-team' });
      await writeContract(join(team.repoPath, '.tasks', 'FE-1.md'), { id: 'FE-1', title: 'build ui shell' });
      gitTest(['add', '-A'], team.repoPath);
      gitTest(['commit', '-m', 'tasks: add FE-1'], team.repoPath);
      const dev = await service.addMember({ teamId: team.id, role: 'developer' });
      const reviewer = await service.addMember({ teamId: team.id, role: 'reviewer' });
      const task = await service.assignTask({
        teamId: team.id,
        title: 'build ui shell',
        assigneeId: dev.id,
        contractId: 'FE-1',
      });
      commitInWorktree(dev.workspacePath, 'app/shell.ts', 'export {};\n', 'feat: shell');
      await service.updateTask({ taskId: task.id, status: 'in_review' });
      await service.runGatesForTask({ taskId: task.id });
      const verdict = await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' });
      expect(verdict.merged).toBe(true);
      const status = (await service.status()) as { teams: unknown[]; loopState: string };
      expect(status.loopState).toBe('stopped');
      expect(status.teams).toHaveLength(1);
    } finally {
      await service.dispose();
    }
  }, 60_000);
});
