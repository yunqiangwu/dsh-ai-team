/**
 * Deterministic e2e: 多开发者**并行**开发。
 *
 * 验证点：当两个任务**域不同且互不依赖**时，主循环能同时派给两个空闲 developer，
 * 两个任务处于 in_progress 并行推进（这正是「双人没并行」疑问的正面能力）。
 *
 * 用 assignTask 直接派发两个不同域任务到两个 dev，断言「两个任务同时 in_progress、
 * 两个 dev 同时 working」，然后各自走 gates → review → merge 全部 done。
 */
import { describe, expect, it } from 'vitest';
import { AutopilotService } from '../src/service.js';
import { gitTest, makeFixture, seedRemote, testOptions, commitInWorktree } from './helpers.js';

describe('e2e: parallel development across developers', () => {
  it('dispatches two different-domain tasks to two developers simultaneously', async () => {
    const fixture = await makeFixture('e2e-parallel');
    await seedRemote(fixture, [
      { id: 'PARALLEL-A', title: 'Build parser module', touches: ['parsers/'] },
      { id: 'PARALLEL-B', title: 'Build CLI runner', touches: ['cli/'] },
    ]);

    const service = await AutopilotService.create(
      testOptions(fixture, {
        remote: { url: fixture.remotePath, sshKeyEnv: 'AUTOPILOT_TEST_GIT_KEY', platform: 'generic' },
        gates: { commands: ['git --version'], requireCiGreen: false, timeoutMinutes: 1 },
      }),
    );
    try {
      const init = await service.initAutopilot('parallel-team');
      const team = service.teamView(init.teamId);
      const dev1 = await service.addMember({ teamId: team.id, role: 'developer' });
      const dev2 = await service.addMember({ teamId: team.id, role: 'developer' });
      const reviewer = await service.addMember({ teamId: team.id, role: 'reviewer' });

      const taskA = await service.assignTask({ teamId: team.id, title: 'build parsers', assigneeId: dev1.id, contractId: 'PARALLEL-A' });
      const taskB = await service.assignTask({ teamId: team.id, title: 'build cli', assigneeId: dev2.id, contractId: 'PARALLEL-B' });

      // 两个任务同时 in_progress、两个 dev 同时 working（并行）。
      expect(service.teamView(team.id).tasks.filter((t) => t.status === 'in_progress')).toHaveLength(2);
      expect(service.teamView(team.id).members.filter((m) => m.status === 'working')).toHaveLength(2);

      // 各自写产物 → 门禁 → 评审 → 合并。
      const work: Array<{ task: typeof taskA; dev: typeof dev1; file: string; msg: string }> = [
        { task: taskA, dev: dev1, file: 'parsers/index.ts', msg: 'feat(parsers): module' },
        { task: taskB, dev: dev2, file: 'cli/index.ts', msg: 'feat(cli): runner' },
      ];
      for (const item of work) {
        commitInWorktree(item.dev.workspacePath, item.file, 'export const ok = true;\n', item.msg);
        await service.updateTask({ taskId: item.task.id, status: 'in_review' });
        const gates = await service.runGatesForTask({ taskId: item.task.id });
        expect(gates.allPassed).toBe(true);
        const verdict = await service.review({ taskId: item.task.id, reviewerId: reviewer.id, verdict: 'approve' });
        expect(verdict.merged).toBe(true);
      }

      const view = service.teamView(team.id);
      expect(view.tasks.every((t) => t.status === 'done')).toBe(true);
      expect(gitTest(['show', 'main:parsers/index.ts'], team.repoPath)).toContain('ok = true');
      expect(gitTest(['show', 'main:cli/index.ts'], team.repoPath)).toContain('ok = true');
      expect(service.escalations.all).toHaveLength(0);
    } finally {
      await service.dispose();
    }
  }, 60_000);
});
