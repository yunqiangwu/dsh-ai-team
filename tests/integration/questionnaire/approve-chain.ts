/** 问卷 draft → accepted 审批链（场景五、七）：钉sha256、一次性审批码、防「批 A 合 B」、drift 回退（原 test-questionnaire.ts 拆出）。 */
import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../../../src/service.js';
import { hashBody, parseDoc, renderDoc } from '../../../src/docdraft.js';
import type { AutopilotOptions } from '../../../src/service/options.js';
import type { Question, QuestionType } from '../../../src/view.js';
import { gitTest, makeFixture, testOptions } from '../../helpers.js';
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

describe('questionnaire: draft → accepted 审批链（场景五、七）', () => {
  /** 一份开工包 + 一次审批提问，返回审批问卷与一次性码。 */
  async function stampBundle(ctx: Ctx, drafts: Record<string, string> = {
    'docs/drafts/prd.md': PRD_BODY,
    'docs/drafts/tech-stack.md': '# 技术栈\n\nTypeScript + cordis 插件。\n',
    'docs/drafts/adr/0001-doc-first.md': '# ADR-0001 文档先行\n\n先写再拆。\n',
  }): Promise<{ id: string; code: string }> {
    const paths = Object.keys(drafts);
    for (const path of paths) {
      await ctx.service.docWrite({ teamId: ctx.teamId, path, body: drafts[path]! });
    }
    const asked = await ctx.service.askHuman({
      teamId: ctx.teamId,
      title: '开工包审批',
      kind: 'approval',
      questions: [q({ name: 'deploy', label: '部署形态？', type: 'select', options: [
        { value: 'docker-single', label: '单机 Docker', recommended: true }, { value: 'k8s', label: 'K8s' },
      ] })],
      binding: { type: 'doc', path: paths[0]!, section: '' },
    });
    const record = ctx.service.questionnaires.byId(asked.questionnaire.id)!;
    return { id: record.id, code: record.approvalCode! };
  }

  it('AI 只能写 draft 区；一次审批批完整包，落盘带审批人与决策行', async () => {
    const ctx = await makeCtx('approve');
    try {
      ctx.service.setPhase({ teamId: ctx.teamId, phase: 'intake' });
      await expect(
        ctx.service.docWrite({ teamId: ctx.teamId, path: 'docs/prd.md', body: PRD_BODY }),
      ).rejects.toThrow(/outside the draft area/);

      const { id, code } = await stampBundle(ctx);
      // 标包这个动作本身就是「开工包等人批」，不需要组长再设一次阶段。
      expect(ctx.service.teamView(ctx.teamId).phase).toBe('kickoff_pending_approval');
      // 等人批的草稿必须已经钉住正文哈希。
      const draft = parseDoc('docs/drafts/prd.md', await readFile(join(ctx.repoPath, 'docs/drafts/prd.md'), 'utf8'));
      expect(draft.meta.status).toBe('pending-approval');
      expect(draft.meta.sha256).toBe(hashBody(draft.body));
      // 审批码是凭据，绝不能出现在全量快照里（模型读得到快照）。
      expect(JSON.stringify(ctx.service.projection())).not.toContain(code);

      // 沉默不批准：工单页会预勾 recommended 项，「批准」绝不该是被预勾的那一个。
      const approvalQuestion = ctx.service.questionnaires.byId(id)!.questions.find((item) => item.name === 'decision')!;
      expect(approvalQuestion.options.find((option) => option.value === 'approve')?.recommended).toBe(false);
      expect(approvalQuestion.defaultValue).toBe('reject');

      // 会话里转述的批准必须带码，否则只是模型自己说「人批过了」。
      await expect(
        ctx.service.answerQuestionnaire({ questionnaireId: id, answers: { decision: 'approve' } }),
      ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('one-time code') });
      // 组长（或任何成员）不能自己批准。
      await expect(ctx.service.docApprove({ teamId: ctx.teamId, actorId: ctx.leaderId })).rejects.toThrow(
        /cannot approve documents/,
      );

      // 人在工单页只答了正文题、审批下拉留在默认「不批准」：部分答案要留住，
      // 但审批没做完就不该升格，也不该顺手作废那张单。
      const partial = await ctx.service.answerQuestionnaire({
        questionnaireId: id,
        answers: { deploy: 'k8s' },
        source: 'ticket',
      });
      expect(partial).toMatchObject({ ok: false, missing: ['这批文档是否批准升格为正式文档？'] });
      expect(ctx.service.questionnaires.byId(id)?.status).toBe('open');
      expect(ctx.service.questionnaires.byId(id)?.approvalCode).toBe(code);
      expect(await readText(join(ctx.repoPath, 'docs/prd.md'))).toBeNull();

      const approved = await ctx.service.docApprove({ teamId: ctx.teamId, code });
      expect(approved.promoted.map((item) => item.formal)).toEqual([
        'docs/adr/0001-doc-first.md',
        'docs/prd.md',
        'docs/tech-stack.md',
      ]);
      expect(approved.approvedBy).toContain('审批码');
      expect(approved.phase).toBe('scaffolding');
      expect(ctx.service.teamView(ctx.teamId).phase).toBe('scaffolding');

      const formal = parseDoc('docs/prd.md', await readFile(join(ctx.repoPath, 'docs/prd.md'), 'utf8'));
      expect(formal.meta.status).toBe('accepted');
      expect(formal.meta.approvedBy).toContain('human');
      expect(formal.meta.version).toBe('1.0');
      expect(formal.meta.sha256).toBe(hashBody(formal.body));
      // 人在表单里定的那个数要跟着文档升格上去，否则半年后没人知道是谁拍的。
      expect(formal.body).toContain('部署形态？ = K8s（工单答复）');
      expect(formal.body).toContain('[approved]');
      expect(await readText(join(ctx.repoPath, 'docs/drafts/prd.md'))).toBeNull();
      // 码用完即废：同一份码不能批第二份文档。
      expect(ctx.service.questionnaires.byId(id)?.approvalCode).toBeNull();
      expect(gitTest(['log', '--format=%s', 'main'], ctx.repoPath)).toContain('docs: promote approved drafts');

      // 再批一次同一份 PRD：版本号递增，git 历史就是变更日志。
      const second = await stampBundle(ctx, { 'docs/drafts/prd.md': `${PRD_BODY}\n改过一轮。\n` });
      const again = await ctx.service.docApprove({ teamId: ctx.teamId, code: second.code });
      expect(again.promoted[0]?.version).toBe('1.1');
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it('批完草稿被悄悄改掉 → 拒批、作废码、重开问卷，正式区一个字节都没落', async () => {
    const ctx = await makeCtx('drift');
    try {
      const { id, code } = await stampBundle(ctx, { 'docs/drafts/prd.md': PRD_BODY });
      const absolute = join(ctx.repoPath, 'docs/drafts/prd.md');
      const stamped = parseDoc('docs/drafts/prd.md', await readFile(absolute, 'utf8'));
      // 模拟「人看到的是 A、落盘的是 B」：frontmatter 里的 sha256 仍是 A，正文换了。
      await writeFile(absolute, renderDoc(stamped.meta, `${stamped.body}\n偷偷加的一行部署口径。\n`), 'utf8');

      await expect(ctx.service.docApprove({ teamId: ctx.teamId, code })).rejects.toThrow(/approval refused/);
      expect(await readText(join(ctx.repoPath, 'docs/prd.md'))).toBeNull();
      expect(ctx.service.teamView(ctx.teamId).phase).not.toBe('scaffolding');
      // 旧码作废，新问卷钉住的是重开那一刻的正文。
      await expect(ctx.service.docApprove({ teamId: ctx.teamId, code })).rejects.toThrow(/matches that code/);
      expect(ctx.service.questionnaires.byId(id)?.approvalCode).toBeNull();
      const draft = parseDoc('docs/drafts/prd.md', await readFile(absolute, 'utf8'));
      expect(draft.meta.status).toBe('pending-approval');
      expect(draft.meta.sha256).toBe(hashBody(draft.body));
      expect(draft.body).toContain('偷偷加的一行部署口径');
      // 新问卷、新码，标题指名道姓说清是哪份文件变了。
      const [reopened] = ctx.service.questionnaires.open;
      expect(reopened?.id).not.toBe(id);
      expect(reopened?.kind).toBe('approval');
      expect(reopened?.approvalCode).not.toBeNull();
      expect(reopened?.title).toContain('docs/drafts/prd.md');

      // 重批按新内容再来一次：这一次没再改动，正常升格，改过的那行也随之进正式区。
      const result = await ctx.service.docApprove({ teamId: ctx.teamId, code: reopened!.approvalCode! });
      expect(result.promoted[0]?.formal).toBe('docs/prd.md');
      expect(parseDoc('docs/prd.md', await readFile(join(ctx.repoPath, 'docs/prd.md'), 'utf8')).body)
        .toContain('偷偷加的一行部署口径');
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it('TECH-3：accepted 文档被手改 → tick 检出、退回 draft 重批、幂等、不误伤', async () => {
    const ctx = await makeCtx('tech3-drift');
    try {
      // 先走完正常链路，把一份草稿升格进正式区。
      const first = await stampBundle(ctx, { 'docs/drafts/prd.md': PRD_BODY });
      await ctx.service.docApprove({ teamId: ctx.teamId, code: first.code });
      const formalPath = join(ctx.repoPath, 'docs/prd.md');
      const accepted = parseDoc('docs/prd.md', await readFile(formalPath, 'utf8'));
      expect(accepted.meta.status).toBe('accepted');
      expect(accepted.meta.version).toBe('1.0');

      // 场景五（前半）：哈希一致的正式文档跑一拍 → 静默，无退回事件、不产生新问卷
      // （原审批问卷码已废但状态仍 open，属正常等待，不算「新开」）。
      const openBefore = ctx.service.questionnaires.open.length;
      const quiet = await ctx.service.tickOnce();
      expect(quiet.events.filter((event) => event.startsWith('doc-drift-reverted'))).toHaveLength(0);
      expect(ctx.service.questionnaires.open).toHaveLength(openBefore);
      expect(parseDoc('docs/prd.md', await readFile(formalPath, 'utf8')).meta.status).toBe('accepted');

      // 人直接手改正式区正文：frontmatter 的 sha256 还是旧值，正文已经变了。
      await writeFile(formalPath, renderDoc(accepted.meta, `${accepted.body}\n批准之后手改的一行。\n`), 'utf8');

      // 场景二：一拍检出并退回重批。
      const tick = await ctx.service.tickOnce();
      expect(tick.events).toContain('doc-drift-reverted:docs/prd.md');
      expect(await readText(formalPath)).toBeNull();
      const draft = parseDoc('docs/drafts/prd.md', await readFile(join(ctx.repoPath, 'docs/drafts/prd.md'), 'utf8'));
      expect(draft.meta.status).toBe('pending-approval');
      expect(draft.meta.sha256).toBe(hashBody(draft.body));
      expect(draft.body).toContain('批准之后手改的一行');
      // 重开的那张按 title 定位：open 里可能还躺着码已作废的原审批问卷。
      const reopened = ctx.service.questionnaires.open.find((record) => record.title.includes('批准后被改动'));
      expect(reopened?.kind).toBe('approval');
      expect(reopened?.approvalCode).not.toBeNull();
      expect(reopened?.title).toContain('docs/prd.md');
      expect(gitTest(['log', '--format=%s', 'main'], ctx.repoPath))
        .toContain('docs: accepted doc drifted, reverted to drafts (docs/prd.md)');
      // 退回是文档守门，不是任务故障：不升级、不动 phase
      // （第一拍已把 scaffolding 自动推进到 developing，drift 不回拉阶段）。
      expect(ctx.service.escalations.all).toHaveLength(0);
      expect(ctx.service.teamView(ctx.teamId).phase).toBe('developing');

      // 场景四：幂等 —— 退回后正式区已无该文档，下一拍不再命中、不再开新问卷
      // （open 数停留在「原审批问卷 + 重开问卷」两张）。
      const openAfterRevert = ctx.service.questionnaires.open.length;
      const again = await ctx.service.tickOnce();
      expect(again.events.filter((event) => event.startsWith('doc-drift-reverted'))).toHaveLength(0);
      expect(ctx.service.questionnaires.open).toHaveLength(openAfterRevert);

      // 场景三：重批 approve 走既有升格链，version 递增、手改内容随之进正式区。
      const result = await ctx.service.docApprove({ teamId: ctx.teamId, code: reopened!.approvalCode! });
      expect(result.promoted[0]?.formal).toBe('docs/prd.md');
      expect(result.promoted[0]?.version).toBe('1.1');
      expect(parseDoc('docs/prd.md', await readFile(formalPath, 'utf8')).body).toContain('批准之后手改的一行');

      // 场景五（后半）：升格回正式区后哈希重新一致，再跑一拍依旧静默。
      const settled = await ctx.service.tickOnce();
      expect(settled.events.filter((event) => event.startsWith('doc-drift-reverted'))).toHaveLength(0);
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it('不批准：草稿退回可编辑、阶段回 intake，正式区不动', async () => {
    const ctx = await makeCtx('reject');
    try {
      const { id } = await stampBundle(ctx, { 'docs/drafts/prd.md': PRD_BODY });
      const answered = await ctx.service.answerQuestionnaire({
        questionnaireId: id,
        answers: { deploy: 'docker-single', decision: 'reject' },
        source: 'ticket',
      });
      expect(answered.ok).toBe(true);
      expect(ctx.service.teamView(ctx.teamId).phase).toBe('intake');
      expect(await readText(join(ctx.repoPath, 'docs/prd.md'))).toBeNull();
      const draft = parseDoc('docs/drafts/prd.md', await readFile(join(ctx.repoPath, 'docs/drafts/prd.md'), 'utf8'));
      expect(draft.meta.status).toBe('draft');
      // 没有批准就没有审批人可记 —— 决策行仍写进草稿（人真的答了题）。
      expect(draft.body).toContain('[decision]');
      expect(draft.body).not.toContain('[approved]');
      expect(ctx.service.questionnaires.byId(id)?.approvalCode).toBeNull();
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it('doc_write 改到正在等人批的草稿：问卷作废而不是悄悄重钉哈希', async () => {
    const ctx = await makeCtx('restamp');
    try {
      const { id, code } = await stampBundle(ctx, { 'docs/drafts/prd.md': PRD_BODY });
      const written = await ctx.service.docWrite({
        teamId: ctx.teamId,
        path: 'docs/drafts/prd.md',
        body: `${PRD_BODY}\n组长又补了一段。\n`,
      });
      expect(written.approvalsCancelled).toEqual([id]);
      expect(ctx.service.questionnaires.byId(id)?.approvalCode).toBeNull();
      expect(ctx.service.questionnaires.byId(id)?.status).toBe('cancelled');
      // 作废的码换不来一次升格。
      await expect(ctx.service.docApprove({ teamId: ctx.teamId, code })).rejects.toThrow(/matches that code/);
      expect(parseDoc('docs/drafts/prd.md', await readFile(join(ctx.repoPath, 'docs/drafts/prd.md'), 'utf8')).meta.status)
        .toBe('draft');
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it('任何答复都解锁不了禁区：目标落在 forbiddenPaths 的草稿批不动', async () => {
    const ctx = await makeCtx('forbidden', {
      docs: { draftDir: 'drafts', formalDir: 'formal' },
      security: {
        forbiddenPaths: ['LICENSE', 'formal/legal.md'],
        commandAllowlist: ['git', 'pnpm', 'sh', 'echo'],
        pushRequiresGates: true,
      },
    });
    try {
      await writeFile(join(ctx.repoPath, 'LICENSE'), 'Copyright 2026\n', 'utf8');
      gitTest(['add', '-A'], ctx.repoPath);
      gitTest(['commit', '-m', 'chore: seed LICENSE'], ctx.repoPath);
      const { code } = await stampBundle(ctx, { 'drafts/legal.md': '# 法务口径\n\n以 LICENSE 为准。\n' });
      await expect(ctx.service.docApprove({ teamId: ctx.teamId, code })).rejects.toThrow(/security\.forbiddenPaths/);
      expect(await readText(join(ctx.repoPath, 'formal/legal.md'))).toBeNull();
      expect(await readText(join(ctx.repoPath, 'drafts/legal.md'))).not.toBeNull();
      // draft 区不是禁区的侧门：直写禁区路径同样拒绝。
      await expect(
        ctx.service.docWrite({ teamId: ctx.teamId, path: 'formal/legal.md', body: '# 越界\n' }),
      ).rejects.toThrow(/outside the draft area/);
      // 仓库里那份 LICENSE 一个字节没动。
      expect(gitTest(['status', '--porcelain'], ctx.repoPath)).toBe('');
      expect(gitTest(['show', 'main:LICENSE'], ctx.repoPath)).toBe('Copyright 2026');
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it('没有草稿就没有审批：空包问人批会被拒', async () => {
    const ctx = await makeCtx('emptybundle');
    try {
      await expect(
        ctx.service.askHuman({
          teamId: ctx.teamId,
          title: '批一下（其实什么都没有）',
          kind: 'approval',
          questions: [q({ name: 'a', label: 'A？', type: 'text' })],
        }),
      ).rejects.toThrow(/nothing to approve/);
      expect(ctx.service.questionnaires.all).toHaveLength(0);
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);
});