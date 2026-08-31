/**
 * Multi-cycle development (docs/design-cycles.md) 增量规划环（CYC-2）：
 * cycle_plan plans ONLY the next cycle, cycle_approve starts it mechanically (no
 * approval step), dispatch narrows to the active cycle, and cycle boundaries are
 * gated by the per-cycle `checkpoint` field decided by the leader (CYC-7).
 */
import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../../../src/service.js';
import { makeFixture, seedTeam, testOptions } from '../../helpers.js';

/** cyclePlan 需要的契约至少得有 owner / touches / body，否则整批被写前校验拒掉。 */
function cycleContract(id: string, title: string, extra: { dependsOn?: string[]; touches?: string[] } = {}) {
  return {
    id,
    title,
    owner: 'developer',
    touches: extra.touches ?? ['src/'],
    body: '```gherkin\nGiven the repository\nWhen the task is implemented\nThen it works\n```',
    ...(extra.dependsOn === undefined ? {} : { dependsOn: extra.dependsOn }),
  };
}

describe('cycles: incremental planning (CYC-2)', () => {
  it('cycle_plan writes exactly one planned cycle plus its tagged contracts', async () => {
    const fixture = await makeFixture('cycle-plan');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      const team = await seedTeam(service, { name: 'cycles-team' });
      const result = await service.cyclePlan({
        teamId: team.id,
        cycleName: 'M2',
        goal: 'Ship auth v2',
        scope: ['server/auth/'],
        contracts: [
          cycleContract('AUTH-10', 'oauth login', { touches: ['server/auth/'] }),
          cycleContract('AUTH-11', 'token refresh', { dependsOn: ['AUTH-10'], touches: ['server/auth/'] }),
        ],
      });

      // 一张 planned 的周期记录，任务 id 落在里面。
      expect(result.cycle.status).toBe('planned');
      expect(result.cycle.name).toBe('M2');
      expect(result.cycle.goal).toBe('Ship auth v2');
      expect(result.cycle.taskIds.toSorted()).toEqual(['AUTH-10', 'AUTH-11']);

      // 契约带 `cycle: M2` frontmatter，且只有下一期这批（增量不变量：绝不顺带拆更远期）。
      const contract = await readFile(join(team.repoPath, '.tasks', 'AUTH-10.md'), 'utf8');
      expect(contract).toMatch(/^cycle: M2$/m);
      const files = await readdir(join(team.repoPath, '.tasks'));
      expect(files).toContain('AUTH-11.md');
      expect(files).not.toContain('AUTH-20.md');

      // 同一周期重复规划被拒：重排会复制任务。
      await expect(
        service.cyclePlan({
          teamId: team.id,
          cycleName: 'M2',
          goal: 'again',
          scope: [],
          contracts: [cycleContract('AUTH-12', 'dup')],
        }),
      ).rejects.toThrow(/already planned/);
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('cycle_plan reuses contract_create pre-write validation and refuses the whole batch', async () => {
    const fixture = await makeFixture('cycle-plan-invalid');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      const team = await seedTeam(service, { name: 'cycles-team' });
      await expect(
        service.cyclePlan({
          teamId: team.id,
          cycleName: 'M2',
          goal: 'g',
          scope: [],
          contracts: [
            cycleContract('A-1', 'ok'),
            cycleContract('A-2', 'dangling dep', { dependsOn: ['GHOST-1'] }),
          ],
        }),
      ).rejects.toThrow(/GHOST-1/);

      // 整批拒绝：没有半成品落盘，也没有周期记录。
      const files = await readdir(join(team.repoPath, '.tasks')).catch(() => []);
      expect(files.filter((file) => /^A-\d+\.md$/.test(file))).toHaveLength(0);
      expect(service.teamView(team.id).cycles).toHaveLength(0);
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('cycle_approve starts a planned cycle immediately (mechanical, no approval step)', async () => {
    const fixture = await makeFixture('cycle-approve-auto');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      const team = await seedTeam(service, { name: 'cycles-team' });
      await service.cyclePlan({
        teamId: team.id,
        cycleName: 'M1',
        goal: 'g',
        scope: [],
        contracts: [cycleContract('A-1', 'first')],
      });
      const result = await service.cycleApprove({ teamId: team.id, cycleName: 'M1' });
      expect(result.status).toBe('in_progress');
      expect(service.teamView(team.id).cycles?.[0]?.status).toBe('in_progress');
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('cycle_plan checkpoint: true records the boundary field on the CycleRecord', async () => {
    const fixture = await makeFixture('cycle-checkpoint-field');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      const team = await seedTeam(service, { name: 'cycles-team' });
      // 组长声明边界检查点 → CycleRecord 落 checkpoint 字段；缺省 → 不落。
      const gated = await service.cyclePlan({
        teamId: team.id,
        cycleName: 'M1',
        goal: 'g',
        scope: [],
        checkpoint: true,
        contracts: [cycleContract('A-1', 'first')],
      });
      expect(gated.cycle.checkpoint).toBe(true);
      const open = await service.cyclePlan({
        teamId: team.id,
        cycleName: 'M2',
        goal: 'g',
        scope: [],
        contracts: [cycleContract('A-2', 'second')],
      });
      expect(open.cycle.checkpoint).toBeUndefined();
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('dispatch narrows to the active cycle: planned-cycle tasks stay pending until the cycle starts', async () => {
    const fixture = await makeFixture('cycle-dispatch');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      const team = await seedTeam(service, {
        name: 'cycles-team',
        members: [{ role: 'developer' }, { role: 'reviewer' }],
      });
      // M1 当前活跃；M3 是未来周期，已排期但未开工。
      await service.cyclePlan({
        teamId: team.id,
        cycleName: 'M1',
        goal: 'g1',
        scope: [],
        contracts: [cycleContract('A-1', 'active', { touches: ['a/'] })],
      });
      await service.cyclePlan({
        teamId: team.id,
        cycleName: 'M3',
        goal: 'g3',
        scope: [],
        contracts: [cycleContract('A-3', 'future', { touches: ['a/'] })],
      });
      await service.cycleApprove({ teamId: team.id, cycleName: 'M1' });

      const tick = await service.tickOnce();
      const view = service.teamView(team.id);
      const active = view.tasks.find((task) => task.contractId === 'A-1');
      const future = view.tasks.find((task) => task.contractId === 'A-3');
      expect(active?.status).toBe('in_progress');
      expect(future?.status).toBe('pending');
      expect(tick.dispatched).not.toContain(future?.id);
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('contracts without a cycle field still dispatch when the team has no cycle records (no regression)', async () => {
    const fixture = await makeFixture('cycle-no-regression');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      const team = await seedTeam(service, {
        name: 'cycles-team',
        contracts: [
          { id: 'X-1', title: 'plain', touches: ['x/'] },
          { id: 'X-2', title: 'plain 2', dependsOn: ['X-1'], touches: ['x/'] },
        ],
        members: [{ role: 'developer' }, { role: 'reviewer' }],
      });
      const tick = await service.tickOnce();
      expect(tick.dispatched).toHaveLength(1);
      const view = service.teamView(team.id);
      expect(view.tasks.find((task) => task.contractId === 'X-1')?.status).toBe('in_progress');
      expect(view.tasks.find((task) => task.contractId === 'X-2')?.status).toBe('pending');
    } finally {
      await service.dispose();
    }
  }, 60_000);
});