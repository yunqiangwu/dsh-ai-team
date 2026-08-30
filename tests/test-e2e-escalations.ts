/**
 * Deterministic e2e: 门禁失败升级 & 付费依赖升级。
 *
 * 复刻真实场景：
 * - gate-failure：任务门禁红 → 不能合并 → 升级置 needs-human → 人工分诊 resolve → 回 pending。
 * - paid-dependency：任务需要付费依赖/密钥 → leader 主动升级 → needs-human → resolve → 回 pending。
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AutopilotService } from '../src/service.js';
import { makeFixture, testOptions, writeContract, gitTest, commitInWorktree } from './helpers.js';

async function setup(fixture: ReturnType<typeof makeFixture>, gatesCommands: string[]) {
  const service = await AutopilotService.create(
    testOptions(fixture, { gates: { commands: gatesCommands, requireCiGreen: false, timeoutMinutes: 1 } }),
  );
  const team = await service.createTeam({ name: 'esc2-team' });
  const dev = await service.addMember({ teamId: team.id, role: 'developer' });
  const reviewer = await service.addMember({ teamId: team.id, role: 'reviewer' });
  return { service, team, dev, reviewer };
}

describe('e2e: gate-failure & paid-dependency escalation', () => {
  it('gate red -> cannot approve -> gate-failure escalation -> resolve -> pending', async () => {
    const fixture = await makeFixture('e2e-gatefail');
    const { service, team, dev, reviewer } = await setup(fixture, ['sh -c "exit 1"']);
    try {
      await writeContract(join(team.repoPath, '.tasks', 'GF-1.md'), { id: 'GF-1', title: 'work', touches: ['src'] });
      gitTest(['add', '-A'], team.repoPath);
      gitTest(['commit', '-m', 'tasks: seed GF-1'], team.repoPath);
      const task = await service.assignTask({ teamId: team.id, title: 'work', assigneeId: dev.id, contractId: 'GF-1' });
      commitInWorktree(dev.workspacePath, 'src/gf.ts', 'export const gf = true;\n', 'feat: gf');
      await service.updateTask({ taskId: task.id, status: 'in_review' });

      const gates = await service.runGatesForTask({ taskId: task.id });
      expect(gates.allPassed).toBe(false);
      await expect(service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' })).rejects.toThrow();

      const esc = await service.escalateTask({ taskId: task.id, reason: 'gate-failure', message: 'gates red', suggestion: 'fix gates' });
      expect(service.escalations.all.some((e) => e.reason === 'gate-failure')).toBe(true);
      expect(service.teamView(team.id).tasks.find((t) => t.id === task.id)?.status).toBe('needs-human');

      await service.resolveEscalation({ escalationId: esc.id });
      expect(service.teamView(team.id).tasks.find((t) => t.id === task.id)?.status).toBe('pending');
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('paid-dependency -> escalation -> resolve -> pending', async () => {
    const fixture = await makeFixture('e2e-paiddish');
    const { service, team, dev } = await setup(fixture, ['git --version']);
    try {
      await writeContract(join(team.repoPath, '.tasks', 'PD-1.md'), { id: 'PD-1', title: 'needs paid lib', touches: ['src'] });
      gitTest(['add', '-A'], team.repoPath);
      gitTest(['commit', '-m', 'tasks: seed PD-1'], team.repoPath);
      const task = await service.assignTask({ teamId: team.id, title: 'needs paid lib', assigneeId: dev.id, contractId: 'PD-1' });

      const esc = await service.escalateTask({ taskId: task.id, reason: 'paid-dependency', message: '需要付费 SDK 密钥', suggestion: '请提供 xxxEnv 环境变量' });
      expect(service.escalations.all.some((e) => e.reason === 'paid-dependency')).toBe(true);
      expect(service.teamView(team.id).tasks.find((t) => t.id === task.id)?.status).toBe('needs-human');

      await service.resolveEscalation({ escalationId: esc.id });
      expect(service.teamView(team.id).tasks.find((t) => t.id === task.id)?.status).toBe('pending');
    } finally {
      await service.dispose();
    }
  }, 60_000);
});
