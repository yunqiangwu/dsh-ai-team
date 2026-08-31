/** 问卷答案回写（场景四）：决策行落章节、追加文末、绑定任务、禁区绑定（原 test-questionnaire.ts 拆出）。 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../../../src/service.js';
import { hashBody, parseDoc } from '../../../src/docdraft.js';
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

const PRD_BODY = [
  '# PRD',
  '',
  '## 部署形态',
  '',
  '待定：需要人拍板单机还是集群。',
  '',
  '## 里程碑',
  '',
  'M1 能问能写。',
  '',
].join('\n');

async function readText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

describe('questionnaire: 答案回写（场景四）', () => {
  it('决策行落在绑定章节里，并跟着代码进 git', async () => {
    const ctx = await makeCtx('writeback');
    try {
      await ctx.service.docWrite({ teamId: ctx.teamId, path: 'docs/drafts/prd.md', body: PRD_BODY });
      const asked = await ctx.service.askHuman({
        teamId: ctx.teamId,
        title: '部署形态待定',
        questions: [
          q({ name: 'deploy', label: '部署形态？', type: 'select', options: [
            { value: 'docker-single', label: '单机 Docker', impact: '扩容要重写部署', recommended: true },
            { value: 'k8s', label: 'K8s 集群' },
          ] }),
          q({ name: 'budget', label: '预算上限？', type: 'text', required: false, defaultValue: '' }),
        ],
        binding: { type: 'doc', path: 'docs/drafts/prd.md', section: '部署形态' },
      });
      const answered = await ctx.service.answerQuestionnaire({
        questionnaireId: asked.questionnaire.id,
        answers: { deploy: 'k8s', budget: '' },
      });
      expect(answered.writtenTo).toBe('docs/drafts/prd.md');
      expect(answered.sectionMatched).toBe(true);

      const raw = await readFile(join(ctx.repoPath, 'docs/drafts/prd.md'), 'utf8');
      const doc = parseDoc('docs/drafts/prd.md', raw);
      const line = doc.body.split('\n').find((candidate) => candidate.includes('[decision]')) ?? '';
      expect(line).toContain('部署形态？ = K8s 集群');
      expect(line).toMatch(/> \[decision\] \d{4}-\d{2}-\d{2}T[\d:.]+Z Q1 /);
      expect(line).toContain('会话答复');
      // 写进文档的是 label，不是 `k8s`；留空的选填题不该留一行。
      expect(line).not.toContain('= k8s');
      expect(doc.body).not.toContain('预算上限？');
      // 落在章节内，而不是文末。
      expect(doc.body.indexOf('[decision]')).toBeGreaterThan(doc.body.indexOf('## 部署形态'));
      expect(doc.body.indexOf('[decision]')).toBeLessThan(doc.body.indexOf('## 里程碑'));
      // 决策依据进了 git，不是只活在 state.json。
      expect(gitTest(['log', '--format=%s', 'main'], ctx.repoPath)).toContain('docs: human decision on docs/drafts/prd.md');
      expect(doc.meta.sha256).toBe(hashBody(doc.body));
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it('章节没匹配上时追加到文末并如实报 false；绑定任务则落到契约留言', async () => {
    const ctx = await makeCtx('writeback2');
    try {
      await ctx.service.docWrite({ teamId: ctx.teamId, path: 'docs/drafts/prd.md', body: PRD_BODY });
      const stray = await ctx.service.askHuman({
        teamId: ctx.teamId,
        title: '章节不存在',
        questions: [q({ name: 'a', label: 'A？', type: 'text' })],
        binding: { type: 'doc', path: 'docs/drafts/prd.md', section: '根本没有这一节' },
      });
      const answered = await ctx.service.answerQuestionnaire({
        questionnaireId: stray.questionnaire.id,
        answers: { a: '就这样' },
        source: 'ticket',
      });
      expect(answered.sectionMatched).toBe(false);
      const doc = parseDoc('docs/drafts/prd.md', await readFile(join(ctx.repoPath, 'docs/drafts/prd.md'), 'utf8'));
      expect(doc.body).toContain('工单答复');
      expect(doc.body.indexOf('[decision]')).toBeGreaterThan(doc.body.indexOf('M1 能问能写。'));

      await writeContract(join(ctx.repoPath, '.tasks', 'W-1.md'), { id: 'W-1', title: 'bound', touches: ['app/'] });
      gitTest(['add', '-A'], ctx.repoPath);
      gitTest(['commit', '-m', 'tasks: seed'], ctx.repoPath);
      await ctx.service.tickOnce();
      const task = ctx.service.teamView(ctx.teamId).tasks.find((candidate) => candidate.contractId === 'W-1')!;
      const bound = await ctx.service.askHuman({
        teamId: ctx.teamId,
        title: '这张单子怎么切',
        taskId: task.id,
        questions: [q({ name: 'split', label: '要不要拆两张？', type: 'select', options: [
          { value: 'yes', label: '拆', recommended: true }, { value: 'no', label: '不拆' },
        ] })],
        binding: { type: 'task', contractId: 'W-1' },
      });
      const onTask = await ctx.service.answerQuestionnaire({
        questionnaireId: bound.questionnaire.id,
        answers: { split: 'yes' },
        source: 'ticket',
      });
      expect(onTask.writtenTo).toBe('.tasks/W-1.md');
      const contract = await readText(join(ctx.repoPath, '.tasks', 'W-1.md'));
      expect(contract).toContain('[decision]');
      expect(contract).toContain('要不要拆两张？ = 拆');
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it('绑定只能落在 draft 区或看板上的契约，正式文档对所有角色只读', async () => {
    const ctx = await makeCtx('binding');
    try {
      await expect(
        ctx.service.askHuman({
          teamId: ctx.teamId,
          title: '越界绑定',
          questions: [q({ name: 'a', label: 'A？', type: 'text' })],
          binding: { type: 'doc', path: 'docs/prd.md', section: '' },
        }),
      ).rejects.toThrow(/outside the draft area/);
      await expect(
        ctx.service.askHuman({
          teamId: ctx.teamId,
          title: '越界绑定',
          questions: [q({ name: 'a', label: 'A？', type: 'text' })],
          binding: { type: 'task', contractId: 'NOPE-1' },
        }),
      ).rejects.toThrow(/is not on the board/);
      // 提问时就验路径，不等答完才发现无处可去。
      expect(ctx.service.questionnaires.open).toHaveLength(0);
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);
});