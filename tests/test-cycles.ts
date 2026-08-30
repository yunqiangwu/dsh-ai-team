/**
 * Multi-cycle development (docs/design-cycles.md, CYC-2): the incremental
 * planning loop — cycle_plan plans ONLY the next cycle, cycle_approve gates
 * the start (configurable), and dispatch narrows to the active cycle so
 * future-cycle contracts stay pending until their cycle actually starts.
 */
import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../src/service.js';
import { makeFixture, seedTeam, testOptions } from './helpers.js';

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

  it('cycle_approve starts a planned cycle immediately when requireApproval is false (unattended)', async () => {
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
      expect(result.questionnaire).toBeUndefined();
      expect(service.teamView(team.id).cycles?.[0]?.status).toBe('in_progress');
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('cycle_approve with requireApproval true opens a cycle questionnaire and starts only after human approval', async () => {
    const fixture = await makeFixture('cycle-approve-gated');
    const service = await AutopilotService.create(
      testOptions(fixture, { cycles: { roadmapPath: 'docs/ROADMAP.md', requireApproval: true, autoAdvance: true } }),
    );
    try {
      const team = await seedTeam(service, { name: 'cycles-team' });
      await service.cyclePlan({
        teamId: team.id,
        cycleName: 'M1',
        goal: 'g',
        scope: [],
        contracts: [cycleContract('A-1', 'first')],
      });

      // 落一张 cycle 问卷，批之前周期保持 planned。
      const first = await service.cycleApprove({ teamId: team.id, cycleName: 'M1', mode: 'async' });
      expect(first.status).toBe('planned');
      expect(first.questionnaire?.kind).toBe('cycle');

      // 拒绝 → 保持 planned。
      const rejected = await service.answerQuestionnaire({
        questionnaireId: first.questionnaire!.id,
        answers: { decision: 'reject' },
        source: 'ticket',
      });
      expect(rejected.ok).toBe(true);
      expect(service.teamView(team.id).cycles?.[0]?.status).toBe('planned');

      // 再问一次，人批了才开工。
      const second = await service.cycleApprove({ teamId: team.id, cycleName: 'M1', mode: 'async' });
      expect(second.status).toBe('planned');
      const approved = await service.answerQuestionnaire({
        questionnaireId: second.questionnaire!.id,
        answers: { decision: 'approve' },
        source: 'ticket',
      });
      expect(approved.ok).toBe(true);
      expect(service.teamView(team.id).cycles?.[0]?.status).toBe('in_progress');
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
