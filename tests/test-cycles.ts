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
import { makeFixture, seedTeam, testOptions, commitInWorktree } from './helpers.js';

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

// ── CYC-3：周期验收门与无人值守推进 ─────────────────────────────────────────

/** 把已派发的契约任务推到 done（提交 → in_review → 门 → approve 合入）。 */
async function driveTaskToDone(service: AutopilotService, teamId: string, contractId: string): Promise<void> {
  const team = service.teamView(teamId);
  const task = team.tasks.find((candidate) => candidate.contractId === contractId)!;
  const dev = team.members.find((member) => member.id === task.assigneeId)!;
  const reviewer = team.members.find((member) => member.role === 'reviewer')!;
  commitInWorktree(dev.workspacePath, 'work.ts', 'export const x = 1;\n', `feat: ${contractId}`);
  await service.updateTask({ taskId: task.id, status: 'in_review' });
  await service.runGatesForTask({ taskId: task.id });
  await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' });
}

describe('cycles: unattended advancement (CYC-3)', () => {
  it('完成语义按周期：M1 全部完成且 M2 已预排 → 直通 M2 开工，不提前 completed', async () => {
    const fixture = await makeFixture('cycle-advance-direct');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      const team = await seedTeam(service, {
        name: 'cycles-team',
        members: [{ role: 'developer' }, { role: 'reviewer' }],
      });
      await service.cyclePlan({
        teamId: team.id,
        cycleName: 'M1',
        goal: 'g1',
        scope: [],
        contracts: [cycleContract('A-1', 'first', { touches: ['a/'] })],
      });
      await service.cyclePlan({
        teamId: team.id,
        cycleName: 'M2',
        goal: 'g2',
        scope: [],
        contracts: [cycleContract('A-2', 'second', { touches: ['a/'] })],
      });
      await service.cycleApprove({ teamId: team.id, cycleName: 'M1' });
      await service.tickOnce();
      await driveTaskToDone(service, team.id, 'A-1');

      const tick = await service.tickOnce();
      const view = service.teamView(team.id);
      const [m1, m2] = view.cycles!;
      expect(m1.status).toBe('done');
      expect(m2.status).toBe('in_progress');
      // 一个周期完成 ≠ 项目完成：不置 completed、不写「全部完成」报告。
      expect(tick.completed).toBe(false);
      expect(service.getLoopState()).not.toBe('completed');
      // 周期小结并入 completion.md（场景二：周期验收门生成小结）。
      const report = await readFile(join(fixture.stateDir, 'completion.md'), 'utf8');
      expect(report).toContain('## cycles');
      expect(report).toContain('### cycle M1');
      expect(report).toContain('- tasks: 1/1 done or cancelled');
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('等规划：autoAdvance 且下一期未预排 → 落问卷不静默空转，cycle_plan 后自动继续', async () => {
    const fixture = await makeFixture('cycle-advance-wait-plan');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      const team = await seedTeam(service, {
        name: 'cycles-team',
        members: [{ role: 'developer' }, { role: 'reviewer' }],
      });
      await service.cyclePlan({
        teamId: team.id,
        cycleName: 'M1',
        goal: 'g1',
        scope: [],
        contracts: [cycleContract('A-1', 'first', { touches: ['a/'] })],
      });
      await service.cycleApprove({ teamId: team.id, cycleName: 'M1' });
      await service.tickOnce();
      await driveTaskToDone(service, team.id, 'A-1');

      const tick = await service.tickOnce();
      let view = service.teamView(team.id);
      expect(view.cycles![0]!.status).toBe('done');
      expect(tick.completed).toBe(false);
      // 下一期未预排 → 落一张「请规划下一期」的 cycle 问卷（wait-plan，不静默空转）。
      const openCycles = service.projection().questionnaires.filter(
        (q) => q.teamId === team.id && q.kind === 'cycle' && q.status === 'open',
      );
      expect(openCycles).toHaveLength(1);

      // 组长下一轮 cycle_plan 满足这张问卷：无人值守自动开工，问卷取消。
      await service.cyclePlan({
        teamId: team.id,
        cycleName: 'M2',
        goal: 'g2',
        scope: [],
        contracts: [cycleContract('A-2', 'second', { touches: ['a/'] })],
      });
      view = service.teamView(team.id);
      expect(view.cycles![1]!.status).toBe('in_progress');
      expect(
        service
          .projection()
          .questionnaires.filter((q) => q.teamId === team.id && q.kind === 'cycle' && q.status === 'open'),
      ).toHaveLength(0);
      const nextTick = await service.tickOnce();
      expect(nextTick.dispatched).toHaveLength(1);
      expect(service.teamView(team.id).tasks.find((task) => task.contractId === 'A-2')?.status).toBe('in_progress');
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('人工检查点：autoAdvance=false → 周期停在 in_review 等点头，批准后才 done', async () => {
    const fixture = await makeFixture('cycle-advance-checkpoint');
    const service = await AutopilotService.create(
      testOptions(fixture, { cycles: { roadmapPath: 'docs/ROADMAP.md', requireApproval: false, autoAdvance: false } }),
    );
    try {
      const team = await seedTeam(service, {
        name: 'cycles-team',
        members: [{ role: 'developer' }, { role: 'reviewer' }],
      });
      await service.cyclePlan({
        teamId: team.id,
        cycleName: 'M1',
        goal: 'g1',
        scope: [],
        contracts: [cycleContract('A-1', 'first', { touches: ['a/'] })],
      });
      await service.cycleApprove({ teamId: team.id, cycleName: 'M1' });
      await service.tickOnce();
      await driveTaskToDone(service, team.id, 'A-1');

      const tick = await service.tickOnce();
      const view = service.teamView(team.id);
      // 验收通过但没人点头：周期停在 in_review，落「批准推进」问卷。
      expect(view.cycles![0]!.status).toBe('in_review');
      expect(tick.completed).toBe(false);
      const openCycles = service.projection().questionnaires.filter(
        (q) => q.teamId === team.id && q.kind === 'cycle' && q.status === 'open',
      );
      expect(openCycles).toHaveLength(1);

      // 等人答（工单页亲手点的才算人）：批准 → 周期 done；没有下一期 → 走完即 completed。
      const questionnaire = openCycles[0]!;
      const answered = await service.answerQuestionnaire({
        questionnaireId: questionnaire.id,
        answers: { advance: 'approve' },
        source: 'ticket',
      });
      expect(answered.ok).toBe(true);
      expect(service.teamView(team.id).cycles![0]!.status).toBe('done');

      const finalTick = await service.tickOnce();
      expect(finalTick.completed).toBe(true);
      expect(service.getLoopState()).toBe('completed');
      const report = await readFile(join(fixture.stateDir, 'completion.md'), 'utf8');
      expect(report).toContain('### cycle M1');
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('wait-plan 问卷答「结束项目」→ 周期全 done 且无挂起问卷 → completed', async () => {
    const fixture = await makeFixture('cycle-advance-finish');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      const team = await seedTeam(service, {
        name: 'cycles-team',
        members: [{ role: 'developer' }, { role: 'reviewer' }],
      });
      await service.cyclePlan({
        teamId: team.id,
        cycleName: 'M1',
        goal: 'g1',
        scope: [],
        contracts: [cycleContract('A-1', 'first', { touches: ['a/'] })],
      });
      await service.cycleApprove({ teamId: team.id, cycleName: 'M1' });
      await service.tickOnce();
      await driveTaskToDone(service, team.id, 'A-1');
      await service.tickOnce();

      const openCycles = service.projection().questionnaires.filter(
        (q) => q.teamId === team.id && q.kind === 'cycle' && q.status === 'open',
      );
      const questionnaire = openCycles[0]!;
      // roadmap 已无下一期 → 人答「结束项目」→ 写完成报告并停机。
      const answered = await service.answerQuestionnaire({
        questionnaireId: questionnaire.id,
        answers: { roadmap_done: 'finish' },
        source: 'ticket',
      });
      expect(answered.ok).toBe(true);
      expect(service.getLoopState()).toBe('completed');
      const report = await readFile(join(fixture.stateDir, 'completion.md'), 'utf8');
      expect(report).toContain('## cycles');
      expect(report).toContain('### cycle M1');
    } finally {
      await service.dispose();
    }
  }, 60_000);
});
