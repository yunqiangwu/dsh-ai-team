/** 问卷独立实体（场景一）与持久化（原 test-questionnaire.ts 拆出）。 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AutopilotService } from '../../../src/service.js';
import type { AutopilotOptions } from '../../../src/service/options.js';
import type { Question, QuestionType } from '../../../src/view.js';
import { gitTest, makeFixture, testOptions, writeContract } from '../../helpers.js';
import type { Fixture } from '../../helpers.js';

interface Ctx {
  service: AutopilotService;
  fixture: Fixture;
  teamId: string;
  repoPath: string;
  leaderId: string;
  cleanup: () => Promise<void>;
}

async function makeCtx(
  prefix: string,
  overrides: Partial<AutopilotOptions> = {},
  members: { role: 'leader' | 'developer' | 'reviewer' }[] = [{ role: 'leader' }, { role: 'developer' }],
): Promise<Ctx> {
  const fixture = await makeFixture(prefix);
  const service = await AutopilotService.create(testOptions(fixture, overrides));
  const team = await service.createTeam({ name: `${prefix}-team`, members });
  const [leader] = team.members.filter((member) => member.role === 'leader');
  return {
    service,
    fixture,
    teamId: team.id,
    repoPath: team.repoPath,
    leaderId: leader!.id,
    cleanup: () => service.dispose(),
  };
}

/** 题目构造器：视图类型要求 options/required/defaultValue 都在，测试里不必每次写全。 */
function q(input: {
  name: string;
  label: string;
  type: QuestionType;
  options?: { value: string; label: string; impact?: string; recommended?: boolean }[];
  required?: boolean;
  defaultValue?: string;
}): Question {
  return {
    name: input.name,
    label: input.label,
    type: input.type,
    options: (input.options ?? []).map((option) => ({
      value: option.value,
      label: option.label,
      impact: option.impact ?? '',
      recommended: option.recommended ?? false,
    })),
    required: input.required ?? true,
    defaultValue: input.defaultValue ?? '',
  };
}

/** 等问卷登记完成（ask_human 建记录之后还要走完投递才进入 await）。 */
async function settle(ms = 20): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

describe('questionnaire: 独立实体（场景一）', () => {
  it('一次提问把任务留在 in_progress，不产生升级、教训或直方图计数', async () => {
    const ctx = await makeCtx('entity');
    try {
      await writeContract(join(ctx.repoPath, '.tasks', 'Q-1.md'), { id: 'Q-1', title: 'needs a decision', touches: ['app/'] });
      gitTest(['add', '-A'], ctx.repoPath);
      gitTest(['commit', '-m', 'tasks: seed'], ctx.repoPath);
      await ctx.service.tickOnce(); // 派发 Q-1
      const task = ctx.service.teamView(ctx.teamId).tasks.find((candidate) => candidate.contractId === 'Q-1')!;
      expect(task.status).toBe('in_progress');

      const result = await ctx.service.askHuman({
        teamId: ctx.teamId,
        title: '缓存用哪套',
        questions: [q({ name: 'cache', label: '缓存放哪里？', type: 'select', options: [
          { value: 'redis', label: 'Redis', impact: '多一个运维组件', recommended: true },
          { value: 'inproc', label: '进程内', impact: '多实例会各存一份' },
        ] })],
        kind: 'intake',
        taskId: task.id,
      });

      expect(result.status).toBe('open');
      expect(result.questionnaire.id).toMatch(/^qn_/);
      // 没配 notification 就别假装人已被告知：工单链接为空、邮件未送达。
      expect(result.questionnaire.ticketUrl).toBeNull();
      expect(result.questionnaire.mailDelivered).toBe(false);
      // 核心不变量：这是一次正常的提问，不是故障。
      const team = ctx.service.teamView(ctx.teamId);
      expect(team.tasks.find((candidate) => candidate.id === task.id)?.status).toBe('in_progress');
      expect(ctx.service.escalations.all).toHaveLength(0);
      expect(Object.keys(team.metrics.escalations)).toHaveLength(0);
      expect(ctx.service.learningList({ teamId: ctx.teamId }).total).toBe(0);
      // 面板与 autopilot_status 仍然看得到「在等人」。
      const projection = ctx.service.projection();
      expect(projection.questionnaires.filter((record) => record.status === 'open')).toHaveLength(1);
      expect(projection.questionnaires[0]?.taskId).toBe(task.id);
      expect(projection.blocked).not.toContain(task.id);
      const awaiting = (await ctx.service.status()).awaitingHuman as { id: string; taskId: string | null }[];
      expect(awaiting[0]?.id).toBe(result.questionnaire.id);
      expect(awaiting[0]?.taskId).toBe(task.id);
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it('题目形状不合法在创建时就拒绝，答案与题目对不上也拒绝', async () => {
    const ctx = await makeCtx('validate');
    try {
      await expect(
        ctx.service.askHuman({ teamId: ctx.teamId, title: 'bad', questions: [] }),
      ).rejects.toThrow(/at least one question/);
      await expect(
        ctx.service.askHuman({
          teamId: ctx.teamId,
          title: 'bad',
          questions: [q({ name: 'only', label: '一选一', type: 'select', options: [{ value: 'a', label: 'A' }] })],
        }),
      ).rejects.toThrow(/fewer than 2 options/);
      await expect(
        ctx.service.askHuman({
          teamId: ctx.teamId,
          title: 'bad',
          questions: [q({ name: 'comma', label: '带逗号', type: 'select', options: [
            { value: 'a,b', label: 'A' }, { value: 'c', label: 'C' },
          ] })],
        }),
      ).rejects.toThrow(/must not contain a comma/);
      const ok = await ctx.service.askHuman({
        teamId: ctx.teamId,
        title: 'fine',
        questions: [q({ name: 'mode', label: '模式', type: 'select', options: [
          { value: 'a', label: 'A' }, { value: 'b', label: 'B' },
        ] })],
      });
      expect(ok.questionnaire.questions[0]?.defaultValue).toBe('');
      await expect(
        ctx.service.answerQuestionnaire({ questionnaireId: ok.questionnaire.id, answers: { made: 'up' } }),
      ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('unknown question') });
      await expect(
        ctx.service.answerQuestionnaire({ questionnaireId: ok.questionnaire.id, answers: { mode: 'zzz' } }),
      ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('unknown option') });
      // 校验不过一条都不写：上一条非法答案不该留下任何痕迹。
      expect(ctx.service.questionnaires.byId(ok.questionnaire.id)?.answers).toEqual({});
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it('需求问卷答完自动进入 kickoff_pending_approval（组长不必自己设阶段）', async () => {
    const ctx = await makeCtx('phase');
    try {
      ctx.service.setPhase({ teamId: ctx.teamId, phase: 'intake' });
      const asked = await ctx.service.askHuman({
        teamId: ctx.teamId,
        title: '需求采集',
        kind: 'intake',
        questions: [q({ name: 'users', label: '谁是主要用户？', type: 'text' })],
      });
      expect(ctx.service.teamView(ctx.teamId).phase).toBe('intake');
      const answered = await ctx.service.answerQuestionnaire({
        questionnaireId: asked.questionnaire.id,
        answers: { users: '运维自己' },
      });
      expect(answered.ok).toBe(true);
      expect(ctx.service.teamView(ctx.teamId).phase).toBe('kickoff_pending_approval');
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);
});

/** 兜住「新格式老快照」这类回归：审批链跑完后 state.json 里确实带着问卷记录。 */
describe('questionnaire: 持久化', () => {
  it('问卷随 state.json 落盘，重载后仍在', async () => {
    const ctx = await makeCtx('persist');
    const asked = await ctx.service.askHuman({
      teamId: ctx.teamId,
      title: '重启后还等人答',
      questions: [q({ name: 'a', label: 'A？', type: 'text' })],
    });
    const id = asked.questionnaire.id;
    await settle(150); // 防抖落盘
    await ctx.cleanup();

    const revived = await AutopilotService.create(testOptions(ctx.fixture));
    try {
      const record = revived.questionnaires.byId(id);
      expect(record?.status).toBe('open');
      expect(record?.title).toBe('重启后还等人答');
      // 视图里没有审批码这一项（intake 问卷本来也没有）。
      expect(revived.projection().questionnaires[0]).not.toHaveProperty('approvalCode');
    } finally {
      await revived.dispose();
    }
  }, 60_000);
});