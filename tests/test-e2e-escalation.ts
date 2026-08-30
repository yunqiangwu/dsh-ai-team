/**
 * Deterministic e2e: 升级分诊闭环。
 *
 * 复刻真实场景：任务改动触及禁区（LICENSE）→ 门禁全绿仍不能合并 → 触发 `forbidden-paths`
 * 升级（任务置 needs-human）→ 人工分诊 `escalation_resolve` → 升级标记已解决、任务回到 pending
 * 可重新派发。被测对象是「升级→分诊→重回可派发」这条人工节点闭环。
 *
 * 不依赖 LLM、不联网、零 token。
 */
import { describe, expect, it } from 'vitest';
import { AutopilotService } from '../src/service.js';
import { gitTest, makeFixture, seedRemote, testOptions, commitInWorktree } from './helpers.js';

describe('e2e: escalation triage (forbidden-path -> resolve -> back to pending)', () => {
  it('forbidden diff raises needs-human + escalation; resolve returns it to pending', async () => {
    const fixture = await makeFixture('e2e-esc');
    await seedRemote(fixture, [{ id: 'ESC-1', title: 'core work', touches: ['server/core/'] }]);
    const service = await AutopilotService.create(
      testOptions(fixture, { remote: { url: fixture.remotePath, sshKeyEnv: 'AUTOPILOT_TEST_GIT_KEY', platform: 'generic' } }),
    );
    try {
      const team = await service.createTeam({ name: 'esc-team', cloneRemote: true });
      const dev = await service.addMember({ teamId: team.id, role: 'developer' });
      const reviewer = await service.addMember({ teamId: team.id, role: 'reviewer' });
      const task = await service.assignTask({ teamId: team.id, title: 'core work', assigneeId: dev.id, contractId: 'ESC-1' });

      commitInWorktree(dev.workspacePath, 'server/core/index.ts', 'export const core = 1;\n', 'feat: core');
      // 触及默认禁区 LICENSE
      commitInWorktree(dev.workspacePath, 'LICENSE', 'rewritten by agent\n', 'docs: rewrite license');
      await service.updateTask({ taskId: task.id, status: 'in_review' });
      const gates = await service.runGatesForTask({ taskId: task.id });
      expect(gates.allPassed).toBe(true);

      // 门全绿也不能合并禁区改动 → 升级 + needs-human
      await expect(
        service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' }),
      ).rejects.toThrow(/forbidden/i);
      expect(service.teamView(team.id).tasks.find((t) => t.id === task.id)?.status).toBe('needs-human');
      const escalation = service.escalations.all.find((e) => e.reason === 'forbidden-paths');
      expect(escalation).toBeDefined();

      // 人工分诊：resolve → 升级已解决、任务回 pending
      await service.resolveEscalation({ escalationId: escalation!.id });
      expect(service.escalations.all.find((e) => e.id === escalation!.id)?.resolvedAt).not.toBeNull();
      expect(service.teamView(team.id).tasks.find((t) => t.id === task.id)?.status).toBe('pending');
    } finally {
      await service.dispose();
    }
  }, 60_000);
});
