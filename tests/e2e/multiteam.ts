/**
 * Deterministic e2e: 多团队并行。
 *
 * 复刻真实场景：同一个插件进程里两个团队（team-a / team-b）各自独立工作区，并行各自走完
 * 「契约 → 派发 → 门禁 → 评审 → 合并」闭环，互不干扰。
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AutopilotService } from '../../src/service.js';
import { makeFixture, testOptions, writeContract, gitTest, commitInWorktree } from '../helpers.js';

describe('e2e: multi-team parallel (two teams both close their loop)', () => {
  it('team A and team B each complete a task concurrently', async () => {
    const fixture = await makeFixture('e2e-multi');
    const service = await AutopilotService.create(
      testOptions(fixture, { gates: { commands: ['git --version'], requireCiGreen: false, timeoutMinutes: 1 } }),
    );
    try {
      const [teamA, teamB] = await Promise.all([
        service.createTeam({ name: 'team-a' }),
        service.createTeam({ name: 'team-b' }),
      ]);
      expect(teamA.id).not.toBe(teamB.id);
      const devA = await service.addMember({ teamId: teamA.id, role: 'developer' });
      const devB = await service.addMember({ teamId: teamB.id, role: 'developer' });
      const revA = await service.addMember({ teamId: teamA.id, role: 'reviewer' });
      const revB = await service.addMember({ teamId: teamB.id, role: 'reviewer' });

      await Promise.all([
        writeContract(join(teamA.repoPath, '.tasks', 'MA-1.md'), { id: 'MA-1', title: 'module a', touches: ['a/'] }),
        writeContract(join(teamB.repoPath, '.tasks', 'MB-1.md'), { id: 'MB-1', title: 'module b', touches: ['b/'] }),
      ]);
      gitTest(['add', '-A'], teamA.repoPath);
      gitTest(['add', '-A'], teamB.repoPath);
      gitTest(['commit', '-m', 'tasks: seed MA-1'], teamA.repoPath);
      gitTest(['commit', '-m', 'tasks: seed MB-1'], teamB.repoPath);

      const [taskA, taskB] = await Promise.all([
        service.assignTask({ teamId: teamA.id, title: 'module a', assigneeId: devA.id, contractId: 'MA-1' }),
        service.assignTask({ teamId: teamB.id, title: 'module b', assigneeId: devB.id, contractId: 'MB-1' }),
      ]);
      commitInWorktree(devA.workspacePath, 'a/index.ts', 'export const a = 1;\n', 'feat: a');
      commitInWorktree(devB.workspacePath, 'b/index.ts', 'export const b = 1;\n', 'feat: b');
      await Promise.all([
        service.updateTask({ taskId: taskA.id, status: 'in_review' }),
        service.updateTask({ taskId: taskB.id, status: 'in_review' }),
      ]);
      const [gatesA, gatesB] = await Promise.all([
        service.runGatesForTask({ taskId: taskA.id }),
        service.runGatesForTask({ taskId: taskB.id }),
      ]);
      expect(gatesA.allPassed).toBe(true);
      expect(gatesB.allPassed).toBe(true);
      const [verdictA, verdictB] = await Promise.all([
        service.review({ taskId: taskA.id, reviewerId: revA.id, verdict: 'approve' }),
        service.review({ taskId: taskB.id, reviewerId: revB.id, verdict: 'approve' }),
      ]);
      expect(verdictA.merged).toBe(true);
      expect(verdictB.merged).toBe(true);
      expect(service.teamView(teamA.id).tasks.find((t) => t.contractId === 'MA-1')?.status).toBe('done');
      expect(service.teamView(teamB.id).tasks.find((t) => t.contractId === 'MB-1')?.status).toBe('done');
      expect(service.escalations.all).toHaveLength(0);
    } finally {
      await service.dispose();
    }
  }, 60_000);
});
