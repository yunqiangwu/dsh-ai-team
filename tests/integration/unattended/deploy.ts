/**
 * Unattended-operation test: deploying skips when the base branch only
 * advanced on .tasks/ commits (no code worth deploying).
 */
import { describe, expect, it } from 'vitest';
import { AutopilotService } from '../../../src/service.js';
import { DEFAULT_LEARNINGS } from '../../../src/learnings.js';
import { makeFixture, seedTeam, testOptions, commitInWorktree } from '../../helpers.js';
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

describe('unattended: knowledge loop, clarification and pre-dispatch gates', () => {
  /** 开启知识回路的覆盖项（默认关闭，所以每个用例要显式打开才有捕获）。 */
  const withLearnings = { learnings: { ...DEFAULT_LEARNINGS, enabled: true } };

  it('does not deploy when the base branch only advanced on .tasks/ commits', async () => {
    let healthChecks = 0;
    const countingFetch = (async () => {
      healthChecks += 1;
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const { service, teamId, cleanup } = await serviceWithContracts('deployskip', [{ id: 'P-1', title: 'one', touches: ['app/'] }], {
      deploy: { enabled: true, command: 'git --version', healthCheckUrl: 'http://health.local/check', secretsEnv: [] },
      fetchFn: countingFetch,
      ...withLearnings,
    });
    try {
      const { task, reviewer } = await taskInReview(service, teamId, 'P-1');
      await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' });
      await service.tickOnce();
      // 基线：代码合入 base 之后确实部署过（首拍没有历史基线可比对，必然部署一次）。
      const afterCode = service.projection().deploys.length;
      expect(afterCode).toBeGreaterThan(0);
      expect(healthChecks).toBeGreaterThan(0);

      // 接下来只有知识台账推进了 base —— 不含任何代码，不该再部署一次。
      healthChecks = 0;
      await service.learningRecord({ taskId: task.id, kind: 'manual', summary: 'a lesson worth keeping', touches: ['app/'] });
      await service.tickOnce();
      await service.tickOnce();
      expect(service.projection().deploys.length).toBe(afterCode);
      expect(healthChecks).toBe(0);
    } finally {
      await cleanup();
    }
  }, 60_000);
});