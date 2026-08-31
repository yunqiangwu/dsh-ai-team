/**
 * Multi-cycle development (docs/design-cycles.md) 无人值守推进环（CYC-3）：
 * 完成语义按周期（直通下一期 / wait-plan 问卷 / checkpoint 批准点），
 * 周期验收门生成小结并入 completion.md，checkpoint 由组长声明（CYC-7）。
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../../../src/service.js';
import { makeFixture, seedTeam, testOptions, commitInWorktree } from '../../helpers.js';

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

/** 把已派发的契约任务推到 done（提交 → in_review → 门 → approve 合入）。 */
async function driveTaskToDone(service: AutopilotService, teamId: string, contractId: string): Promise<void> {
  const team = service.teamView(teamId);
  const task = team.tasks.find((candidate) => candidate.contractId === contractId)!;
  const dev = team.members.find((member) => member.id === task.assigneeId)!;
  const reviewer = team.members.find((member) => member.role === 'reviewer')!;
  // 同一 worktree 里多个任务都要提交时，内容必须随任务变化，否则第二次 commit 会
  // 因「nothing to commit」失败（git 对空提交报错）。
  commitInWorktree(dev.workspacePath, 'work.ts', `export const x = 1; // ${contractId}\n`, `feat: ${contractId}`);
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

  it('等规划：checkpoint 未设且下一期未预排 → 落问卷不静默空转，cycle_plan 后自动继续', async () => {
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

  it('检查点：checkpoint=true → 周期停在 in_review 等点头，批准后才 done', async () => {
    const fixture = await makeFixture('cycle-advance-checkpoint');
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
        checkpoint: true,
        contracts: [cycleContract('A-1', 'first', { touches: ['a/'] })],
      });
      await service.cycleApprove({ teamId: team.id, cycleName: 'M1' });
      await service.tickOnce();
      await driveTaskToDone(service, team.id, 'A-1');

      const tick = await service.tickOnce();
      const view = service.teamView(team.id);
      // 组长声明检查点：验收通过但没人点头 → 停在 in_review，落「批准推进」问卷。
      // （checkpoint 是内部决策字段、不进视图，其落盘已在「记录边界字段」用例直接断言 cyclePlan 返回值。）
      expect(view.cycles![0]!.status).toBe('in_review');
      expect(tick.completed).toBe(false);
      const openCycles = service.projection().questionnaires.filter(
        (q) => q.teamId === team.id && q.kind === 'cycle' && q.status === 'open',
      );
      expect(openCycles).toHaveLength(1);
      // checkpoint 问卷是「继续 / 结束」两选（docs/design-cycles.md §6.3；P1 删掉了
      // 「暂缓」死选项）—— 两个选项都能落地，防死锁回归。
      expect(openCycles[0]!.questions[0]!.options.map((option) => option.value)).toEqual(['continue', 'finish']);

      // 等人答（工单页亲手点的才算人）：批准 → 周期 done；没有下一期 → 走完即 completed。
      const questionnaire = openCycles[0]!;
      const answered = await service.answerQuestionnaire({
        questionnaireId: questionnaire.id,
        answers: { advance: 'continue' },
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

  it('检查点 + 下一期已预排：批准后才 done 并启动下一期（不提前 completed）', async () => {
    const fixture = await makeFixture('cycle-checkpoint-next');
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
        checkpoint: true,
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

      await service.tickOnce();
      let view = service.teamView(team.id);
      // checkpoint 周期验收后停在 in_review，即使下一期已预排也不直通。
      expect(view.cycles![0]!.status).toBe('in_review');
      expect(view.cycles![1]!.status).toBe('planned');
      const openCycles = service.projection().questionnaires.filter(
        (q) => q.teamId === team.id && q.kind === 'cycle' && q.status === 'open',
      );
      expect(openCycles).toHaveLength(1);

      // 人批「推进」→ M1 done、M2 机械开工，不提前 completed。
      await service.answerQuestionnaire({
        questionnaireId: openCycles[0]!.id,
        answers: { advance: 'continue' },
        source: 'ticket',
      });
      view = service.teamView(team.id);
      expect(view.cycles![0]!.status).toBe('done');
      expect(view.cycles![1]!.status).toBe('in_progress');
      const tick = await service.tickOnce();
      expect(tick.completed).toBe(false);
      expect(service.teamView(team.id).tasks.find((task) => task.contractId === 'A-2')?.status).toBe('in_progress');
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('checkpoint 边界人答「结束项目」→ 周期 done 且整队 completed（不依赖 roadmap 自然跑完）', async () => {
    const fixture = await makeFixture('cycle-checkpoint-finish');
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
        checkpoint: true,
        contracts: [cycleContract('A-1', 'first', { touches: ['a/'] })],
      });
      await service.cycleApprove({ teamId: team.id, cycleName: 'M1' });
      await service.tickOnce();
      await driveTaskToDone(service, team.id, 'A-1');
      await service.tickOnce(); // M1 验收 → checkpoint → 停在 in_review
      let view = service.teamView(team.id);
      expect(view.cycles![0]!.status).toBe('in_review');

      // 边界拍板「结束」→ 周期 done、整队 completed，写完成报告。
      const openCycles = service.projection().questionnaires.filter(
        (q) => q.teamId === team.id && q.kind === 'cycle' && q.status === 'open',
      );
      expect(openCycles).toHaveLength(1);
      const answered = await service.answerQuestionnaire({
        questionnaireId: openCycles[0]!.id,
        answers: { advance: 'finish' },
        source: 'ticket',
      });
      expect(answered.ok).toBe(true);
      view = service.teamView(team.id);
      expect(view.cycles![0]!.status).toBe('done');
      expect(service.getLoopState()).toBe('completed');
      const report = await readFile(join(fixture.stateDir, 'completion.md'), 'utf8');
      expect(report).toContain('### cycle M1');
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('checkpoint 周期停在 in_review 等点头时，cycle_plan 新周期不自动开工（保持 planned）', async () => {
    const fixture = await makeFixture('cycle-checkpoint-no-autostart');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      const team = await seedTeam(service, {
        name: 'cycles-team',
        members: [{ role: 'developer' }, { role: 'reviewer' }],
      });
      // M1 无 checkpoint → 验收后直通 M2 开工；M2 有 checkpoint → 验收后停在 in_review。
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
        checkpoint: true,
        contracts: [cycleContract('A-2', 'second', { touches: ['a/'] })],
      });
      await service.cycleApprove({ teamId: team.id, cycleName: 'M1' });
      await service.tickOnce(); // 派发 A-1
      await driveTaskToDone(service, team.id, 'A-1');
      await service.tickOnce(); // M1 验收 → 直通 M2 开工
      await service.tickOnce(); // M2 派发 A-2
      await driveTaskToDone(service, team.id, 'A-2');
      await service.tickOnce(); // M2 验收 → checkpoint → 停在 in_review 等人点头
      let view = service.teamView(team.id);
      expect(view.cycles![0]!.status).toBe('done');
      expect(view.cycles![1]!.status).toBe('in_review');

      // P3：M2 还没批「推进」，组长此刻 cycle_plan M3 → M3 不得自动开工（保持 planned）、
      // A-3 不得派发 —— 否则用户还在被问「批准推进吗」，下一期却已经在跑。
      await service.cyclePlan({
        teamId: team.id,
        cycleName: 'M3',
        goal: 'g3',
        scope: [],
        contracts: [cycleContract('A-3', 'third', { touches: ['a/'] })],
      });
      await service.tickOnce(); // 新契约经 syncContracts 进看板
      view = service.teamView(team.id);
      expect(view.cycles![2]!.status).toBe('planned');
      expect(view.tasks.find((task) => task.contractId === 'A-3')?.status).toBe('pending');
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

  it('CYC-4：派发的周期任务描述注入所属周期上下文', async () => {
    const fixture = await makeFixture('cycle-context-inject');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      const team = await seedTeam(service, {
        name: 'cycles-team',
        members: [{ role: 'developer' }, { role: 'reviewer' }],
      });
      await service.cyclePlan({
        teamId: team.id,
        cycleName: 'M1',
        goal: 'Ship auth v2',
        scope: ['server/auth/'],
        contracts: [cycleContract('A-1', 'oauth login', { touches: ['server/auth/'] })],
      });
      await service.cycleApprove({ teamId: team.id, cycleName: 'M1' });
      await service.tickOnce();
      const task = service.teamView(team.id).tasks.find((t) => t.contractId === 'A-1')!;
      expect(task.status).toBe('in_progress');
      // 契约带 `cycle: M1` → 派发重建描述时注入周期目标与范围。
      expect(task.description).toContain('## 周期 M1');
      expect(task.description).toContain('目标：Ship auth v2');
      expect(task.description).toContain('范围：server/auth/');
    } finally {
      await service.dispose();
    }
  }, 60_000);
});