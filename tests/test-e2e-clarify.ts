/**
 * Deterministic e2e: 契约澄清（task_clarify）闭环。
 *
 * 复刻真实场景：developer 发现契约自相矛盾 → `task_clarify`（不耗返工轮、不升级）→ 任务
 * → needs-clarification、成员释放 → leader 读契约 note 并回答 → `task_update` 释放回 pending。
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AutopilotService } from '../src/service.js';
import { makeFixture, testOptions, writeContract, gitTest } from './helpers.js';

describe('e2e: task_clarify (needs clarification -> leader releases)', () => {
  it('dev clarifies -> task needs-clarification -> leader answers -> pending', async () => {
    const fixture = await makeFixture('e2e-clarify');
    const service = await AutopilotService.create(
      testOptions(fixture, { gates: { commands: ['git --version'], requireCiGreen: false, timeoutMinutes: 1 } }),
    );
    try {
      const team = await service.createTeam({ name: 'clarify-team' });
      const leader = service.teamView(team.id).members.find((m) => m.role === 'leader')!;
      const dev = await service.addMember({ teamId: team.id, role: 'developer' });
      await writeContract(join(team.repoPath, '.tasks', 'CL-1.md'), { id: 'CL-1', title: 'needs clarity', touches: ['src'] });
      gitTest(['add', '-A'], team.repoPath);
      gitTest(['commit', '-m', 'tasks: seed CL-1'], team.repoPath);
      const task = await service.assignTask({ teamId: team.id, title: 'needs clarity', assigneeId: dev.id, contractId: 'CL-1' });
      expect(task.status).toBe('in_progress');

      // dev 澄清（不返工、不升级）
      const clarified = await service.clarifyTask({
        taskId: task.id,
        memberId: dev.id,
        question: '验收标准二与三冲突？',
        ambiguousPoints: ['标准二与三互斥'],
      });
      expect(clarified.status).toBe('needs-clarification');
      expect(service.escalations.all).toHaveLength(0);

      // leader 以 note 回答并释放
      await service.updateTask({ taskId: task.id, status: 'pending', note: '以标准二为准，标准三删除', actorId: leader.id });
      expect(service.teamView(team.id).tasks.find((t) => t.id === task.id)?.status).toBe('pending');
    } finally {
      await service.dispose();
    }
  }, 60_000);
});
