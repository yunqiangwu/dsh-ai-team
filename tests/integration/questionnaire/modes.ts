/** 问卷两种模式（场景三）interactive / 超时 / dispose 泄压（原 test-questionnaire.ts 拆出）。 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../../../src/service.js';
import type { AutopilotOptions } from '../../../src/service/options.js';
import type { Question, QuestionType } from '../../../src/view.js';
import { makeFixture, testOptions } from '../../helpers.js';
import type { Fixture } from '../../helpers.js';
import type { QuestionnaireRecord } from '../../../src/questionnaire.js';

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

/** 等问卷登记完成（ask_human 建记录之后还要走完投递才进入 await）。 */
async function settle(ms = 20): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function firstOpenQuestionnaire(service: AutopilotService): Promise<QuestionnaireRecord> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [record] = service.questionnaires.open;
    if (record !== undefined) return record;
    await settle(10);
  }
  throw new Error('no open questionnaire appeared');
}

describe('questionnaire: 两种模式（场景三）', () => {
  it('interactive 在同一次调用里 await 到答案，并带回回写结果', async () => {
    const ctx = await makeCtx('interactive');
    try {
      await ctx.service.docWrite({ teamId: ctx.teamId, path: 'docs/drafts/prd.md', body: PRD_BODY });
      const pending = ctx.service.askHuman({
        teamId: ctx.teamId,
        title: '部署形态待定',
        mode: 'interactive',
        timeoutMinutes: 0, // 不设墙钟上限：这一版就是要等到人来
        questions: [q({ name: 'deploy', label: '部署形态？', type: 'select', options: [
          { value: 'docker-single', label: '单机 Docker', recommended: true }, { value: 'k8s', label: 'K8s' },
        ] })],
        binding: { type: 'doc', path: 'docs/drafts/prd.md', section: '部署形态' },
      });
      const record = await firstOpenQuestionnaire(ctx.service);
      const answered = await ctx.service.answerQuestionnaire({
        questionnaireId: record.id,
        answers: { deploy: 'k8s' },
      });
      expect(answered.ok).toBe(true);

      const result = await pending;
      expect(result.status).toBe('answered');
      expect(result.answers).toEqual({ deploy: 'k8s' });
      expect(result.writtenTo).toBe('docs/drafts/prd.md');
      expect(result.sectionMatched).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it('interactive 超时按默认方案放行，且不往文档里写没人做过的决策', async () => {
    const ctx = await makeCtx('expire');
    try {
      await ctx.service.docWrite({ teamId: ctx.teamId, path: 'docs/drafts/prd.md', body: PRD_BODY });
      const before = await readText(join(ctx.repoPath, 'docs/drafts/prd.md'));
      const result = await ctx.service.askHuman({
        teamId: ctx.teamId,
        title: '部署形态待定',
        mode: 'interactive',
        // testOptions 直构 options，绕过 zod 的 min：10ms 的合法小数分钟。
        timeoutMinutes: 1 / 6_000,
        questions: [q({ name: 'deploy', label: '部署形态？', type: 'select', defaultValue: 'docker-single', options: [
          { value: 'docker-single', label: '单机 Docker', recommended: true }, { value: 'k8s', label: 'K8s' },
        ] })],
        binding: { type: 'doc', path: 'docs/drafts/prd.md', section: '部署形态' },
      });
      expect(result.status).toBe('expired');
      expect(result.answers).toEqual({ deploy: 'docker-single' });
      expect(result.writtenTo).toBeNull();
      expect(await readText(join(ctx.repoPath, 'docs/drafts/prd.md'))).toBe(before);
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it('dispose 唤醒还在 await 的那一轮，不留悬空 promise', async () => {
    const ctx = await makeCtx('drain');
    const pending = ctx.service.askHuman({
      teamId: ctx.teamId,
      title: '没人来得及答',
      mode: 'interactive',
      timeoutMinutes: 0,
      questions: [q({ name: 'x', label: 'X？', type: 'text' })],
    });
    await firstOpenQuestionnaire(ctx.service);
    await ctx.service.dispose();
    await expect(pending).resolves.toMatchObject({ status: 'expired' });
  }, 60_000);
});