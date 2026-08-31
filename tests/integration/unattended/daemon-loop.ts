/**
 * Unattended-operation test: the daemon loop dispatch / dependency + domain
 * locks, stuck detection, wall-clock budget, run metrics and the review-round
 * ceiling, plus the blocked-dependency escalation from the INT-1 scenarios.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../../../src/service.js';
import {
  makeFixture,
  seedTeam,
  testOptions,
  commitInWorktree,
} from '../../helpers.js';
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

/** 真实等待：卡死豁免这类断言要越过 daemon.stuckMinutes 的时间窗，没法用假计时器。 */
const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
};

describe('unattended: daemon loop', () => {
  it('dispatches pending contracts respecting depends_on and domain locks', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('dispatch', [
      { id: 'CORE-1', title: 'core', touches: ['server/core/'] },
      { id: 'CORE-2', title: 'core extension', dependsOn: ['CORE-1'], touches: ['server/core/ext/'] },
      { id: 'FE-1', title: 'ui', touches: ['app/'] },
    ]);
    try {
      const tick1 = await service.tickOnce();
      // CORE-1 and FE-1 dispatched (disjoint domains, deps satisfied);
      // CORE-2 waits on CORE-1.
      expect(tick1.dispatched).toHaveLength(2);
      const team = service.teamView(teamId);
      const core2 = team.tasks.find((task) => task.contractId === 'CORE-2');
      expect(core2?.status).toBe('pending');
      // The two dispatched tasks sit with the two idle developers.
      const busyDevs = team.members.filter((member) => member.role === 'developer' && member.status === 'working');
      expect(busyDevs).toHaveLength(2);

      // Finish CORE-1 through the gated review flow.
      const core1 = team.tasks.find((task) => task.contractId === 'CORE-1');
      expect(core1).toBeDefined();
      const dev = team.members.find((member) => member.id === core1?.assigneeId);
      const reviewer = team.members.find((member) => member.role === 'reviewer');
      commitInWorktree(dev!.workspacePath, 'server/core/index.ts', 'export {};\n', 'feat: core');
      await service.updateTask({ taskId: core1!.id, status: 'in_review' });
      await service.runGatesForTask({ taskId: core1!.id });
      await service.review({ taskId: core1!.id, reviewerId: reviewer!.id, verdict: 'approve' });

      // Next tick: CORE-2's dependency is done → dispatched to the freed dev.
      const tick2 = await service.tickOnce();
      expect(tick2.dispatched).toContain(core2?.id ?? 'CORE-2');
      const after = service.teamView(teamId);
      expect(after.tasks.find((task) => task.contractId === 'CORE-2')?.status).toBe('in_progress');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('domain lock blocks overlapping touches', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('domainlock', [
      { id: 'A-1', title: 'first', touches: ['server/db/'] },
      { id: 'A-2', title: 'overlapping', touches: ['server/db/schema/'] },
    ]);
    try {
      const tick = await service.tickOnce();
      expect(tick.dispatched).toHaveLength(1);
      const team = service.teamView(teamId);
      const locked = team.tasks.find((task) => task.status === 'pending');
      expect(locked?.contractId).toBe('A-2');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('TECH-2：域锁推迟但不空转、跳过可见 —— 高优先级被锁时派别的并记事件', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('tech2-defer', [
      // W-1 优先级最高、先派出并锁住 src/；H-1 次高但 touches 被锁；L-1 最低且在锁外域。
      { id: 'W-1', title: 'in flight', touches: ['src/'], priority: 10 },
      { id: 'H-1', title: 'high but locked', touches: ['src/'], priority: 5 },
      { id: 'L-1', title: 'low but free', touches: ['docs/'] },
    ]);
    try {
      const tick = await service.tickOnce();
      const byContract = (id: string) => service.teamView(teamId).tasks.find((task) => task.contractId === id)!;
      const dispatchedContracts = tick.dispatched.map(
        (id) => service.teamView(teamId).tasks.find((task) => task.id === id)?.contractId,
      );
      // 场景一：被锁的 H-1 推迟（保持 pending、不升级），派发继续走锁外的 L-1。
      expect(dispatchedContracts).toEqual(['W-1', 'L-1']);
      expect(byContract('H-1').status).toBe('pending');
      // 场景二：跳过要出声——事件里能看到 H-1 在等域锁；且这只是等待，不是升级。
      expect(tick.events).toContain(`deferred-domain-lock:${byContract('H-1').id}`);
      expect(tick.escalated).toEqual([]);
      expect(service.escalations.all).toHaveLength(0);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('stuck tasks escalate and pause at task granularity', async () => {
    const { service, cleanup } = await serviceWithContracts(
      'stuck',
      [{ id: 'S-1', title: 'will stall' }],
      { daemon: { maxReviewRounds: 3, stuckMinutes: 0, pollIntervalSeconds: 1 } },
    );
    try {
      const tick1 = await service.tickOnce(); // dispatch S-1
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      const tick2 = await service.tickOnce(); // stuckMinutes: 0 → immediately stale
      // stuckMinutes: 0 makes the task stale the moment it is dispatched, so
      // the escalation lands on the dispatch tick or the next one.
      expect(tick1.escalated.length + tick2.escalated.length).toBeGreaterThan(0);
      expect(
        service.escalations.all.some((record) => record.reason === 'task-stuck'),
      ).toBe(true);
      // pauseOnEscalation: task → loop itself stays runnable.
      expect(service.getLoopState()).not.toBe('escalated');
      const projection = service.projection();
      expect(projection.blocked.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('等人回答的任务豁免 stuckMinutes，答完之后才照判（§6.5）', async () => {
    // 0.02 分钟 = 1.2 秒：派发拍绝不会判死，等人期间才越线。
    const { service, teamId, cleanup } = await serviceWithContracts(
      'awaiting',
      [{ id: 'H-1', title: 'asks a human' }],
      { daemon: { maxReviewRounds: 3, stuckMinutes: 0.02, pollIntervalSeconds: 1 } },
    );
    const taskOf = () => service.teamView(teamId).tasks.find((candidate) => candidate.contractId === 'H-1')!;
    try {
      await service.tickOnce(); // 派发 H-1
      const asked = await service.askHuman({
        teamId,
        taskId: taskOf().id,
        title: '跨域阈值按哪个数算',
        questions: [{ name: 'threshold', label: '按契约数还是提交数？', type: 'text', options: [], required: true, defaultValue: '' }],
      });
      await sleep(1400); // 越过一次卡死窗口

      // 窗口已经过了，豁免必须真的挡住它：一次合法的追问不该变成 needs-human、
      // 直方图里的一条计数，更不该喂给模型一条根本不存在的教训。
      expect((await service.tickOnce()).escalated).toEqual([]);
      expect(taskOf().status).toBe('in_progress');
      expect(service.escalations.all.some((record) => record.reason === 'task-stuck')).toBe(false);
      expect(service.teamView(teamId).metrics.escalations['task-stuck']).toBeUndefined();

      const before = taskOf().lastActivityAt;
      const answered = await service.answerQuestionnaire({
        questionnaireId: asked.questionnaire.id,
        answers: { threshold: '按契约数' },
      });
      expect(answered.ok).toBe(true);
      // 答案本身算一次活动：否则人想了 40 分钟，组长一回来任务就被判「40 分钟没动静」。
      expect(taskOf().lastActivityAt).toBeGreaterThanOrEqual(before);

      // 豁免不是免死金牌：答完之后再越线，就该照常升级。
      await sleep(1400);
      const after = await service.tickOnce();
      expect(after.escalated).toContain(taskOf().id);
      expect(service.escalations.all.some((record) => record.reason === 'task-stuck')).toBe(true);
      expect(service.teamView(teamId).metrics.escalations['task-stuck']).toBe(1);
      expect(taskOf().status).toBe('needs-human');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('wall-clock budget escalates a long-running task as budget-exceeded', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts(
      'budget',
      [{ id: 'B-1', title: 'spins forever' }],
      // 1/3_600_000 h = 1 ms：派发后第一个 tick 即超预算（testOptions 直构
      // options，绕过 zod 的 min 约束，所以小数小时合法）。
      { daemon: { maxReviewRounds: 3, stuckMinutes: 45, pollIntervalSeconds: 1, maxTaskHours: 1 / 3_600_000 } },
    );
    try {
      const tick1 = await service.tickOnce(); // dispatch B-1
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      const tick2 = await service.tickOnce();
      // 与 stuck 用例同理：升级落在派发拍或下一拍。
      expect(tick1.escalated.length + tick2.escalated.length).toBeGreaterThan(0);
      expect(
        service.escalations.all.some((record) => record.reason === 'budget-exceeded'),
      ).toBe(true);
      const view = service.teamView(teamId);
      expect(view.tasks[0]?.status).toBe('needs-human');
      // 直方图在 escalateTask 内累加，checkBudget 不重复计。
      expect(view.metrics.escalations['budget-exceeded']).toBe(1);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('run metrics accumulate across the gated review flow', async () => {
    const { service, teamId, fixture, cleanup } = await serviceWithContracts('metrics', [
      { id: 'M-1', title: 'counted' },
    ]);
    try {
      await service.tickOnce(); // dispatch
      let view = service.teamView(teamId);
      expect(view.metrics.dispatched).toBe(1);
      const task = view.tasks[0]!;
      const dev = view.members.find((member) => member.id === task.assigneeId)!;
      const reviewer = view.members.find((member) => member.role === 'reviewer')!;
      commitInWorktree(dev.workspacePath, 'm.ts', 'export {};\n', 'feat: m');
      await service.updateTask({ taskId: task.id, status: 'in_review' });
      await service.runGatesForTask({ taskId: task.id }); // 门第 1 跑（绿）
      await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'request_changes', comments: 'redo' });
      commitInWorktree(dev.workspacePath, 'm.ts', 'export const two = 2;\n', 'feat: m2');
      await service.updateTask({ taskId: task.id, status: 'in_review' });
      await service.runGatesForTask({ taskId: task.id }); // 门第 2 跑
      await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' });

      view = service.teamView(teamId);
      expect(view.metrics).toEqual({
        dispatched: 1,
        completed: 1,
        reviewRounds: 1,
        gateRuns: 2,
        gateFailures: 0,
        deploys: 0,
        rollbacks: 0,
        escalations: {},
      });
      expect(view.tasks[0]?.status).toBe('done');

      // 完成（唯一任务 done → 下一拍写报告），报告里带指标段与耗时行。
      await service.tickOnce();
      const report = await readFile(join(fixture.stateDir, 'completion.md'), 'utf8');
      expect(report).toContain('## run metrics');
      expect(report).toContain('- dispatched 1 / completed 1 / review rounds 1');
      expect(report).toMatch(/- task durations \(dispatch → done\)/);
      expect(report).toContain('M-1:');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('review-round ceiling escalates after maxReviewRounds', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts(
      'rounds',
      [{ id: 'R-1', title: 'rework-prone' }],
      { daemon: { maxReviewRounds: 2, stuckMinutes: 45, pollIntervalSeconds: 1 } },
    );
    try {
      await service.tickOnce(); // dispatch
      const team = service.teamView(teamId);
      const task = team.tasks.find((candidate) => candidate.contractId === 'R-1');
      const reviewer = team.members.find((member) => member.role === 'reviewer');
      // Two rounds of request_changes hit the ceiling of 2.
      await service.updateTask({ taskId: task!.id, status: 'in_review' });
      await service.review({ taskId: task!.id, reviewerId: reviewer!.id, verdict: 'request_changes', comments: 'fix' });
      await service.updateTask({ taskId: task!.id, status: 'in_review' });
      await service.review({ taskId: task!.id, reviewerId: reviewer!.id, verdict: 'request_changes', comments: 'again' });
      const tick = await service.tickOnce();
      expect(tick.escalated).toContain(task!.id);
      expect(
        service.escalations.all.some((record) => record.reason === 'review-rounds-exceeded'),
      ).toBe(true);
      expect(service.teamView(teamId).tasks.find((candidate) => candidate.contractId === 'R-1')?.status).toBe(
        'needs-human',
      );
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('依赖死锁：查无此 id 的前置升级 blocked-dependency，而"还没完成"照常安静等待', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('blocked-dep', [
      { id: 'D-1', title: 'base', touches: ['base/'] },
      { id: 'D-2', title: 'waits', dependsOn: ['D-1'], touches: ['waits/'] },
      { id: 'D-3', title: 'typo', dependsOn: ['GHOST-9'], touches: ['ghost/'] },
    ]);
    try {
      const report = await service.tickOnce();
      // 每次都现取视图：teamView 返回的是当拍快照，跨拍复用会把断言变成读旧状态。
      const byContract = (id: string) =>
        service.teamView(teamId).tasks.find((task) => task.contractId === id)!;
      expect(byContract('D-3').status).toBe('needs-human');
      // D-1 派出去了，D-2 的前置只是"还没完成"：既不能派发，也不能升级。
      expect(byContract('D-1').status).toBe('in_progress');
      expect(byContract('D-2').status).toBe('pending');
      const escalation = service.projection().escalations.find((item) => item.taskId === byContract('D-3').id);
      expect(escalation?.reason).toBe('blocked-dependency');
      expect(escalation?.message).toContain('GHOST-9');
      expect(report.events).toContain(`blocked-dependency:${byContract('D-3').id}`);
      expect(service.projection().escalations.filter((item) => item.taskId === byContract('D-2').id)).toEqual([]);

      // 前置被人工挂起后，下游同拍就该升级：链上每一跳都要一拍到底，否则三跳依赖
      // 要等三拍才有人看见，而完成报告在这期间一直是"永不达标"。
      await service.escalateTask({
        taskId: byContract('D-1').id,
        reason: 'manual',
        message: 'base is stuck',
        suggestion: 'triage it',
      });
      const cascaded = await service.tickOnce();
      expect(byContract('D-2').status).toBe('needs-human');
      expect(cascaded.events).toContain(`blocked-dependency:${byContract('D-2').id}`);
      expect(service.teamView(teamId).metrics.escalations['blocked-dependency']).toBe(2);
    } finally {
      await cleanup();
    }
  }, 60_000);
});