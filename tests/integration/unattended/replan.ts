/**
 * Unattended-operation test: change requests & replanning (M3 / INT-4) —
 * cancel (cancel ≠ delete), abort before/after human approval, supersede and
 * continue, priority only among satisfiable deps, and the replan rate ceiling.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../../../src/service.js';
import { gitTest, makeFixture, seedTeam, testOptions, commitInWorktree } from '../../helpers.js';
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

describe('unattended: 需求变更与重规划（M3 / INT-4）', () => {
  it('场景一：废弃不是删除 —— task_cancel 保留契约文件、看板出废弃分区、下游不再静默阻塞', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('m3-cancel', [
      { id: 'CORE-1', title: 'base work', touches: ['server/core/'] },
      { id: 'CORE-2', title: 'will be dropped', dependsOn: ['CORE-1'], touches: ['server/core/ext/'] },
      { id: 'CORE-3', title: 'waits on dropped', dependsOn: ['CORE-2'], touches: ['server/core/ui/'] },
    ]);
    try {
      const repoPath = service.teamView(teamId).repoPath;
      await service.tickOnce(); // CORE-1 派发；CORE-2 等前置；CORE-3 等 CORE-2
      expect(service.teamView(teamId).tasks.find((task) => task.contractId === 'CORE-1')?.status).toBe('in_progress');

      // 自主档：取消未派发的 pending，不产生升级、不发通知。
      await service.taskCancel({ taskId: service.teamView(teamId).tasks.find((task) => task.contractId === 'CORE-2')!.id, reason: '需求砍掉了这个功能' });
      expect(service.escalations.all).toEqual([]);
      expect(service.teamView(teamId).metrics.escalations).toEqual({});

      // 契约文件保留在 .tasks/ 且已提交进 git 历史（废弃可追溯，绝不删文件）。
      const contractPath = join(repoPath, '.tasks', 'CORE-2.md');
      expect(await readFile(contractPath, 'utf8')).toContain('status: cancelled');
      gitTest(['cat-file', '-e', `HEAD:.tasks/CORE-2.md`], repoPath);
      // 看板出现废弃分区（§6.1「_board.md 加列/分区」）。
      const board = await readFile(join(repoPath, '.tasks', '_board.md'), 'utf8');
      expect(board).toContain('## 已废弃');
      expect(board).toContain('CORE-2 will be dropped — cancelled');

      // 下游不再无限静默阻塞：CORE-3 的前置已废弃 → 一拍内响亮升级 blocked-dependency。
      const tick = await service.tickOnce();
      const core3 = service.teamView(teamId).tasks.find((task) => task.contractId === 'CORE-3')!;
      expect(core3.status).toBe('needs-human');
      expect(tick.events).toContain(`blocked-dependency:${core3.id}`);
      const escalation = service.escalations.all.find((item) => item.taskId === core3.id);
      expect(escalation?.reason).toBe('blocked-dependency');
      expect(escalation?.message).toContain('CORE-2');
      expect(escalation?.message).toContain('cancelled');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('场景二：abort 人批之前不落盘，批了才丢分支；驳回则原样继续', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('m3-abort', [
      { id: 'W-1', title: 'in flight', touches: ['w1/'] },
      { id: 'W-2', title: 'in flight too', touches: ['w2/'] },
    ]);
    try {
      await service.tickOnce(); // 两个任务各自派发
      const byContract = (id: string) => service.teamView(teamId).tasks.find((task) => task.contractId === id)!;

      // 提问这一刻什么都不动：任务还在途、分支还在。
      const asked = await service.replanTask({
        taskId: byContract('W-1').id,
        disposition: 'abort',
        changeNote: '这条产品线砍掉了',
      });
      expect(asked.questionnaire?.kind).toBe('replan');
      expect(byContract('W-1').status).toBe('in_progress');
      expect(service.teamView(teamId).branches).toContain(byContract('W-1').branch);

      // 人驳回：任务照常继续。
      await service.answerQuestionnaire({ questionnaireId: asked.questionnaire!.id, answers: { abort: 'reject' } });
      expect(byContract('W-1').status).toBe('in_progress');

      // 人批准：任务废弃、分支删除、接手者释放，契约文件以 cancelled 保留。
      const asked2 = await service.replanTask({
        taskId: byContract('W-2').id,
        disposition: 'abort',
        changeNote: '需求变更，这份工作不要了',
      });
      await service.answerQuestionnaire({ questionnaireId: asked2.questionnaire!.id, answers: { abort: 'approve' } });
      const aborted = service.teamView(teamId);
      expect(aborted.tasks.find((task) => task.contractId === 'W-2')?.status).toBe('cancelled');
      expect(aborted.branches).not.toContain(byContract('W-2').branch);
      const assignee = aborted.members.find((member) => member.id === byContract('W-2').assigneeId)!;
      expect(assignee.status).toBe('idle');
      expect(assignee.currentTaskId).toBeNull();
      const repoPath = aborted.repoPath;
      expect(await readFile(join(repoPath, '.tasks', 'W-2.md'), 'utf8')).toContain('status: cancelled');
      // 放弃在途工作不记成故障：没有升级、没有直方图计数。
      expect(service.escalations.all).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('场景二：越级改验收/PRD 的路径不存在 —— doc_write 只收 draft 区；supersede 派生新契约而不改旧验收', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('m3-tiering', [
      { id: 'S-1', title: 'original', touches: ['s1/'] },
    ]);
    try {
      await service.tickOnce();
      const task = service.teamView(teamId).tasks.find((candidate) => candidate.contractId === 'S-1')!;
      const repoPath = service.teamView(teamId).repoPath;

      // 契约正文与正式 PRD 都没有任何工具能改：两条路都必须被拒。
      await expect(service.docWrite({ teamId, path: '.tasks/S-1.md', body: '把验收数值改成 42' })).rejects.toThrow(
        /outside the draft area/,
      );
      await expect(service.docWrite({ teamId, path: 'docs/prd.md', body: '直接改 PRD' })).rejects.toThrow(
        /outside the draft area/,
      );
      expect(await readFile(join(repoPath, '.tasks', 'S-1.md'), 'utf8')).not.toContain('42');

      // 合法路径：supersede 留下原任务照常合入，修正落在派生的新契约里。
      const result = await service.replanTask({
        taskId: task.id,
        disposition: 'supersede',
        changeNote: '验收阈值从 10 改成 42（新契约承接）',
        followup: { title: 'supersede 修正', body: '```gherkin\nThen the threshold is 42\n```' },
      });
      expect(result.followup?.id).toBe('S-2');
      const followup = await readFile(join(repoPath, '.tasks', 'S-2.md'), 'utf8');
      expect(followup).toContain('depends_on: [S-1]');
      expect(await readFile(join(repoPath, '.tasks', 'S-1.md'), 'utf8')).toContain('[replan]');
      // 原任务分毫未动，且没有升级/通知（自主档）。
      expect(service.teamView(teamId).tasks.find((candidate) => candidate.contractId === 'S-1')?.status).toBe('in_progress');
      expect(service.escalations.all).toEqual([]);

      // continue 同样派生，但不阻塞在原任务后面。
      const continueResult = await service.replanTask({
        taskId: task.id,
        disposition: 'continue',
        changeNote: '增量需求另开一张',
        followup: { body: '```gherkin\nThen the increment lands\n```' },
      });
      expect(continueResult.followup?.id).toBe('S-3');
      expect(await readFile(join(repoPath, '.tasks', 'S-3.md'), 'utf8')).toContain('depends_on: []');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('场景四：优先级只在依赖条件相同时生效 —— 高优先级不越过依赖未满足的任务', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('m3-priority', [
      { id: 'I-1', title: 'no priority', touches: ['i1/'] },
      { id: 'I-2', title: 'no priority either', touches: ['i2/'] },
      { id: 'I-3', title: 'explicit priority', touches: ['i3/'], priority: 8 },
      { id: 'I-4', title: 'high but blocked', dependsOn: ['I-1'], touches: ['i4/'], priority: 100 },
    ]);
    try {
      // 第一拍：I-3（priority 8）先于 I-1（0）派出 —— 打破插入顺序；I-4 虽是 100
      // 但前置未满足，绝不动；I-2 与 I-1 同优先级，保持插入顺序排队等空闲开发者。
      const tick1 = await service.tickOnce();
      const byContract = (id: string) => service.teamView(teamId).tasks.find((task) => task.contractId === id)!;
      // dispatched 里是任务 id；映射回契约 id 才好断言顺序。
      const dispatchedContracts = (tick: { dispatched: string[] }) =>
        tick.dispatched.map((id) => service.teamView(teamId).tasks.find((task) => task.id === id)?.contractId);
      expect(dispatchedContracts(tick1)).toEqual(['I-3', 'I-1']);
      expect(byContract('I-4').status).toBe('pending');
      expect(byContract('I-2').status).toBe('pending');

      // 调优先级（自主档）：I-2 提到最前。I-1 完成后下一拍 I-4（100）压过 I-2。
      await service.updateTask({ taskId: byContract('I-2').id, priority: 3 });
      expect(await readFile(join(service.teamView(teamId).repoPath, '.tasks', 'I-2.md'), 'utf8')).toContain('priority: 3');
      const view = service.teamView(teamId);
      const i1 = view.tasks.find((candidate) => candidate.contractId === 'I-1')!;
      const dev = view.members.find((member) => member.id === i1.assigneeId)!;
      const reviewer = view.members.find((member) => member.role === 'reviewer')!;
      commitInWorktree(dev.workspacePath, 'i1/index.ts', 'export {};\n', 'feat: i1');
      await service.updateTask({ taskId: i1.id, status: 'in_review' });
      await service.runGatesForTask({ taskId: i1.id });
      await service.review({ taskId: i1.id, reviewerId: reviewer.id, verdict: 'approve' });

      const tick2 = await service.tickOnce();
      expect(dispatchedContracts(tick2)).toEqual(['I-4']);
      expect(byContract('I-2').status).toBe('pending');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('场景五：replan 调用超 replan.maxPerHour 即拒绝并说明原因；重规划不续命墙钟预算', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts(
      'm3-limit',
      [
        { id: 'L-1', title: 'burning budget', touches: ['l1/'] },
        { id: 'L-2', title: 'pending two', dependsOn: ['L-1'], touches: ['l2/'] },
        { id: 'L-3', title: 'pending three', dependsOn: ['L-1'], touches: ['l3/'] },
        { id: 'L-4', title: 'pending four', dependsOn: ['L-1'], touches: ['l4/'] },
      ],
      // 1ms 的墙钟预算：只要重规划没把计时重置，下一拍必然超限。
      { replan: { maxPerHour: 2 }, daemon: { maxReviewRounds: 3, stuckMinutes: 45, pollIntervalSeconds: 1, maxTaskHours: 1 / 3_600_000 } },
    );
    try {
      await service.tickOnce(); // L-1 派发，预算开跑；L-2/3/4 等前置，保持 pending
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));

      // 前两次自主取消放行；第三次被频率上限拒绝，且拒绝理由说明了限额本身。
      const byContract = (id: string) => service.teamView(teamId).tasks.find((task) => task.contractId === id)!;
      await service.taskCancel({ taskId: byContract('L-2').id });
      await service.taskCancel({ taskId: byContract('L-3').id });
      await expect(service.taskCancel({ taskId: byContract('L-4').id })).rejects.toThrow(/rate limit.*max 2/);
      expect(byContract('L-4').status).toBe('pending');

      // 重规划调用没有给 L-1 续命：派发后 1ms 的预算早已烧完，循环照常升级
      // budget-exceeded（升级落在派发拍或下一拍，与卡死用例同一口径）。
      await service.tickOnce();
      expect(byContract('L-1').status).toBe('needs-human');
      expect(service.escalations.all.some((record) => record.reason === 'budget-exceeded')).toBe(true);
      // 自主取消从未产生过升级：两张废弃任务没有各自的升级记录，
      // 直方图里也没有「取消」这个原因。
      for (const id of [byContract('L-2').id, byContract('L-3').id]) {
        expect(service.escalations.all.some((record) => record.taskId === id)).toBe(false);
      }
      expect(service.teamView(teamId).metrics.escalations['task-cancelled']).toBeUndefined();
    } finally {
      await cleanup();
    }
  }, 60_000);
});