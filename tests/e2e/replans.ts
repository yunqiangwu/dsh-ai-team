/**
 * Deterministic e2e: replan(supersede) → 派生契约 → 二次派发 → 完整闭环。
 *
 * 复刻真实场景：在途任务因需求变更被 `task_replan(supersede)` 重规划 → 派生承接契约（如 RP-2）落盘
 * → 原任务照常落地（land as-is 合并）→ 之后把派生契约重新派发给开发 → 门禁 → 评审 → 合并。
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { AutopilotService } from '../../src/service.js';
import { makeFixture, testOptions, writeContract, gitTest, commitInWorktree } from '../helpers.js';

describe('e2e: replan supersede -> derived contract re-dispatched -> full loop', () => {
  it('replan in-flight -> derived RP-2 -> original lands -> repeat-dispatch RP-2 -> merge', async () => {
    const fixture = await makeFixture('e2e-replans');
    const service = await AutopilotService.create(
      testOptions(fixture, { gates: { commands: ['git --version'], requireCiGreen: false, timeoutMinutes: 1 } }),
    );
    try {
      const team = await service.createTeam({ name: 'replans-team' });
      const dev = await service.addMember({ teamId: team.id, role: 'developer' });
      const reviewer = await service.addMember({ teamId: team.id, role: 'reviewer' });
      await writeContract(join(team.repoPath, '.tasks', 'RP-1.md'), { id: 'RP-1', title: 'build base', touches: ['src'] });
      gitTest(['add', '-A'], team.repoPath);
      gitTest(['commit', '-m', 'tasks: seed RP-1'], team.repoPath);
      const task = await service.assignTask({ teamId: team.id, title: 'build base', assigneeId: dev.id, contractId: 'RP-1' });

      // 在途 replan：supersede → 派生承接契约落盘
      const result = await service.replanTask({
        taskId: task.id,
        disposition: 'supersede',
        changeNote: '改为分批交付，第 2 批补渲染',
        followup: { title: 'build base — phase 2', touches: ['src'] },
      });
      expect(result.disposition).toBe('supersede');
      const followupId = result.followup!.id;
      expect(followupId).toBe('RP-2');
      expect(statSync(join(team.repoPath, '.tasks', 'RP-2.md')).isFile()).toBe(true);

      // 原任务照常落地（land as-is 合并，释放 developer）
      commitInWorktree(dev.workspacePath, 'src/base.ts', 'export const base = 1;\n', 'feat: base');
      await service.updateTask({ taskId: task.id, status: 'in_review' });
      const g1 = await service.runGatesForTask({ taskId: task.id });
      expect(g1.allPassed).toBe(true);
      const v1 = await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' });
      expect(v1.merged).toBe(true);
      expect(service.teamView(team.id).tasks.find((t) => t.contractId === 'RP-1')?.status).toBe('done');

      // 二次派发承接契约并闭环
      const task2 = await service.assignTask({ teamId: team.id, title: 'build base — phase 2', assigneeId: dev.id, contractId: followupId });
      commitInWorktree(dev.workspacePath, 'src/base2.ts', 'export const base2 = 1;\n', 'feat: base2');
      await service.updateTask({ taskId: task2.id, status: 'in_review' });
      const g2 = await service.runGatesForTask({ taskId: task2.id });
      expect(g2.allPassed).toBe(true);
      const v2 = await service.review({ taskId: task2.id, reviewerId: reviewer.id, verdict: 'approve' });
      expect(v2.merged).toBe(true);
      expect(service.teamView(team.id).tasks.find((t) => t.contractId === followupId)?.status).toBe('done');
      expect(service.escalations.all).toHaveLength(0);
    } finally {
      await service.dispose();
    }
  }, 60_000);
});
