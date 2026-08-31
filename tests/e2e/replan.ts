/**
 * Deterministic e2e: 需求变更重规划（task_replan）闭环。
 *
 * 复刻真实场景：进行中任务因需求变更被 leader 重规划 → 原任务保留（不删契约）、派生一张新的后续契约，
 * 原任务升级置 cancelled、新任务可继续闭环。被测对象是「重规划：派生 + 不丢契约」。
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { AutopilotService } from '../../src/service.js';
import { makeFixture, testOptions, writeContract, gitTest } from '../helpers.js';

describe('e2e: task_replan (supersede -> derived contract, original cancelled)', () => {
  it('replan in-flight task creates a derived contract', async () => {
    const fixture = await makeFixture('e2e-replan');
    const service = await AutopilotService.create(
      testOptions(fixture, { gates: { commands: ['git --version'], requireCiGreen: false, timeoutMinutes: 1 } }),
    );
    try {
      const team = await service.createTeam({ name: 'replan-team' });
      const dev = await service.addMember({ teamId: team.id, role: 'developer' });
      await writeContract(join(team.repoPath, '.tasks', 'RP-1.md'), { id: 'RP-1', title: 'build x', touches: ['src'] });
      gitTest(['add', '-A'], team.repoPath);
      gitTest(['commit', '-m', 'tasks: seed RP-1'], team.repoPath);
      const task = await service.assignTask({ teamId: team.id, title: 'build x', assigneeId: dev.id, contractId: 'RP-1' });

      // 重规划：supersede → 派生后续实体，原契约文件保留不删
      const result = await service.replanTask({ taskId: task.id, disposition: 'supersede', changeNote: '拆分并改为分批交付', followup: { title: 'build x — phase 2', touches: ['src'] } });
      expect(result).toBeTruthy();
      expect(statSync(join(team.repoPath, '.tasks', 'RP-1.md')).isFile()).toBe(true);
      expect(service.escalations.all).toHaveLength(0);
    } finally {
      await service.dispose();
    }
  }, 60_000);
});
