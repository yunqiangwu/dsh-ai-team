/**
 * 人工决策闭环（.tasks/INT-2.md 场景一/二/三/四/五/六/七）。
 *
 * 这组测试锁的是「AI 问人」这件事的形状，而不是实现细节：
 * - 问卷是独立实体：开了问卷 ≠ 任务坏了（不打 needs-human、不进升级直方图、不记教训）；
 * - 答案要结构化地落进文档并跟着代码进 git，不能只活在 state.json 里；
 * - 「人批过了」必须是不可伪造的事实：审批码只出现在工单页 / 邮件里，
 *   落盘前还要重新比对 sha256（防「批 A 合 B」）。
 * 等待期不被判成 task-stuck 那条断言在 test-unattended.ts（契约 §6.5 要求）。
 */
import { describe, expect, it } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../src/service.js';
import { TICKET_PATH_PREFIX, TicketHandler, TicketServer, type TicketStore } from '../src/ticket-handler.js';
import { ticketFieldsOf } from '../src/questionnaire.js';
import type { QuestionnaireRecord } from '../src/questionnaire.js';
import { hashBody, parseDoc, renderDoc } from '../src/docdraft.js';
import type { ContractDraft } from '../src/service/contracts.js';
import type { AutopilotOptions } from '../src/service/options.js';
import type { Question, QuestionType } from '../src/view.js';
import { gitTest, makeFixture, testOptions, writeContract } from './helpers.js';
import type { Fixture } from './helpers.js';

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

/** 测试自己的工单凭据：真实 token 的铸造与比对由 test-ticket-http.ts 锁。 */
const TEST_TICKET_TOKEN = 'test-ticket-token-00000000000000000000000000';

/** 真实 HTTP 工单端点：数据源指向服务侧记录，作答走 submitTicketAnswer 同一条漏斗。 */
async function serveTickets(service: AutopilotService): Promise<{
  base: string;
  token: string;
  close: () => Promise<void>;
}> {
  const store: TicketStore = {
    renderTicket: async (id) => {
      const record = service.questionnaires.byId(id);
      if (record === undefined) return null;
      const { notice, fields } = ticketFieldsOf(record);
      return { title: `等你决策：${record.title}`, notice, fields };
    },
    handleSubmit: (id, answers) => service.submitTicketAnswer(id, answers),
    hasTicket: (id) => service.questionnaires.byId(id) !== undefined,
  };
  const server = new TicketServer({
    host: '127.0.0.1',
    port: 0,
    handler: new TicketHandler({
      basePath: TICKET_PATH_PREFIX,
      store,
      trust: 'token-only',
      // 与生产同形：只有还开着的单子有凭据，答完即失效。
      tokenOf: (id) => (service.questionnaires.byId(id)?.status === 'open' ? TEST_TICKET_TOKEN : undefined),
    }),
  });
  await server.start();
  const bound = server.address!;
  return {
    base: `http://${bound.host}:${bound.port}`,
    token: TEST_TICKET_TOKEN,
    close: () => server.close(),
  };
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

describe('questionnaire: 工单表单（场景二）', () => {
  it('select 预选推荐项并带代价副文案，multiselect 渲染成复选框组，漏答必填返回 400 并重述', async () => {
    const ctx = await makeCtx('ticket');
    const tickets = await serveTickets(ctx.service);
    try {
      const asked = await ctx.service.askHuman({
        teamId: ctx.teamId,
        title: '开工包定稿',
        questions: [
          q({ name: 'platform', label: '部署形态？', type: 'select', options: [
            { value: 'docker-single', label: '单机 Docker', impact: '一台机器搞定，扩容要重写部署', recommended: true },
            { value: 'k8s', label: 'K8s 集群', impact: '运维成本高' },
          ] }),
          q({ name: 'secrets', label: '哪些密钥交给环境变量？', type: 'multiselect', options: [
            { value: 'ssh-key', label: 'SSH 私钥', impact: '不落盘，只引用', recommended: true },
            { value: 'api-token', label: '平台 token', impact: '需要新建一个' },
          ] }),
          q({ name: 'rollback', label: '回滚策略？', type: 'select', options: [
            { value: 'auto', label: '自动回滚' }, { value: 'manual', label: '人工回滚' },
          ] }),
          q({ name: 'note', label: '还有什么要交代？', type: 'textarea', required: false }),
        ],
      });
      const id = asked.questionnaire.id;

      const page = await fetch(`${tickets.base}/ticket/${id}?t=${tickets.token}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('AI 团队需要你做一个决策');
      expect(html).toContain('<select class="field" name="platform" id="platform" required>');
      // 推荐项预选，代价作为选项文案的一部分 —— 让人在看得到后果的地方做选择。
      expect(html).toContain('<option value="docker-single" selected>单机 Docker — 一台机器搞定，扩容要重写部署</option>');
      expect(html).toContain('<input type="checkbox" class="field--inline" name="secrets" value="ssh-key" checked required />');
      expect(html).toContain('<em>需要新建一个</em>');
      // 没有推荐项的下拉框必须补一个空的「请选择」，否则 required 形同虚设。
      expect(html).toContain('<option value="">请选择…</option>');
      // 不做条件分段：四道题平铺，没有 depends-on 之类的隐藏结构。
      expect((html.match(/<fieldset/g) ?? [])).toHaveLength(1);

      const partial = await fetch(`${tickets.base}/ticket/${id}?t=${tickets.token}`, {
        method: 'POST',
        body: 'platform=docker-single',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(partial.status).toBe(400);
      const complaint = await partial.text();
      expect(complaint).toContain('还有必填项没有作答');
      expect(complaint).toContain('哪些密钥交给环境变量？');
      expect(complaint).toContain('回滚策略？');
      // 部分答案保留：人下次不必从第一题重答。
      const half = ctx.service.questionnaires.byId(id)!;
      expect(half.status).toBe('open');
      expect(half.answers.platform?.value).toBe('docker-single');
      // 无凭据必须与"未知 id"逐字节相同（此时单子还开着，404 只可能是凭据挡的）：
      // 响应差别一旦不同，工单号就能被枚举出来。
      const withoutToken = await fetch(`${tickets.base}/ticket/${id}`);
      expect(withoutToken.status).toBe(404);
      expect(await withoutToken.text()).toBe('ticket not found');

      const full = await fetch(`${tickets.base}/ticket/${id}?t=${tickets.token}`, {
        method: 'POST',
        body: 'secrets=ssh-key&secrets=ssh-key&secrets=api-token&rollback=auto&note=%E6%97%A0',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(full.status).toBe(200);
      expect(await full.text()).toContain('感谢');
      const done = ctx.service.questionnaires.byId(id)!;
      expect(done.status).toBe('answered');
      // 复选框组同名重复项合并去重，仍是「一个答案」。
      expect(done.answers.secrets?.value).toBe('ssh-key, api-token');
      expect(done.answers.secrets?.source).toBe('ticket');
      expect(done.answers.note?.value).toBe('无');

      await expect(fetch(`${tickets.base}/ticket/qn_nope`)).resolves.toMatchObject({ status: 404 });
    } finally {
      await tickets.close();
      await ctx.cleanup();
    }
  }, 60_000);

  it('审批题预选「不批准」：闭着眼睛点提交不等于授权', async () => {
    const ctx = await makeCtx('ticket-approval');
    const tickets = await serveTickets(ctx.service);
    try {
      await ctx.service.docWrite({ teamId: ctx.teamId, path: 'docs/drafts/prd.md', body: PRD_BODY });
      const asked = await ctx.service.askHuman({ teamId: ctx.teamId, title: '开工包批不批', kind: 'approval', questions: [] });
      const page = await fetch(`${tickets.base}/ticket/${asked.questionnaire.id}?t=${tickets.token}`);
      const html = await page.text();
      expect(html).toContain('<option value="reject" selected>不批准：退回继续改草稿 — 阶段回到 intake，团队不开工');
      expect(html).not.toContain('<option value="approve" selected');
    } finally {
      await tickets.close();
      await ctx.cleanup();
    }
  }, 60_000);
});

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

describe('contract_create: 写前校验（场景六）', () => {
  const valid: ContractDraft = {
    id: 'CORE-1',
    title: '核心骨架',
    owner: 'developer',
    touches: ['server/core/'],
    body: '```gherkin\nGiven 仓库\nWhen 实现\nThen 验收通过\n```',
  };
  const contractDraft = (overrides: Partial<ContractDraft>): ContractDraft => ({ ...valid, ...overrides });

  it('悬空依赖 / 非法 id / touches 撞禁区 / 成环 / 跨域超限一律拒绝且不留文件', async () => {
    const ctx = await makeCtx('contract');
    try {
      await writeContract(join(ctx.repoPath, '.tasks', 'Q-1.md'), { id: 'Q-1', title: '已有的单子', touches: ['app/'] });
      gitTest(['add', '-A'], ctx.repoPath);
      gitTest(['commit', '-m', 'tasks: seed'], ctx.repoPath);

      const cases: { name: string; contract: ContractDraft; expect: RegExp }[] = [
        { name: 'dangling dep', contract: contractDraft({ dependsOn: ['NOPE-9'] }), expect: /depends_on "NOPE-9" does not exist/ },
        { name: 'bad id', contract: contractDraft({ id: 'core-1' }), expect: /must match <DOMAIN>-<number>/ },
        { name: 'duplicate id', contract: contractDraft({ id: 'Q-1' }), expect: /already exists on disk/ },
        { name: 'self dep', contract: contractDraft({ dependsOn: ['CORE-1'] }), expect: /includes itself/ },
        { name: 'no owner', contract: contractDraft({ owner: '' }), expect: /owner is required/ },
        { name: 'no touches', contract: contractDraft({ touches: [] }), expect: /touches is required/ },
        { name: 'no body', contract: contractDraft({ body: ' ' }), expect: /body is required/ },
        { name: 'bad status', contract: contractDraft({ status: 'done' }), expect: /cannot be created/ },
        { name: 'self forbidden', contract: contractDraft({ touches: ['docs/'], forbidden: ['docs/'] }), expect: /forbidden by this contract itself/ },
        { name: 'global forbidden', contract: contractDraft({ touches: ['LICENSE'] }), expect: /security\.forbiddenPaths/ },
        { name: 'too many domains', contract: contractDraft({ touches: ['a/', 'b/', 'c/', 'd/'] }), expect: /distinct domains/ },
      ];
      for (const item of cases) {
        const error = await ctx.service
          .contractCreate({ teamId: ctx.teamId, contracts: [item.contract] })
          .then(() => null, (caught: unknown) => caught as Error);
        expect(error?.message, item.name).toMatch(item.expect);
        expect(error?.message).toContain('nothing was written');
      }
      // 批量依赖成环：前置允许指向同批兄弟，但不允许闭环。
      const cycle = await ctx.service
        .contractCreate({
          teamId: ctx.teamId,
          contracts: [
            contractDraft({ id: 'A-1', touches: ['a/'], dependsOn: ['A-2'] }),
            contractDraft({ id: 'A-2', touches: ['b/'], dependsOn: ['A-1'] }),
          ],
        })
        .then(() => null, (caught: unknown) => caught as Error);
      expect(cycle?.message).toMatch(/dependency cycle: A-1 → A-2 → A-1/);

      // 「绝不留半个文件」的证据：盘上还是只有那张种下的契约，工作区干净。
      expect(await readdir(join(ctx.repoPath, '.tasks'))).toEqual(['Q-1.md']);
      expect(gitTest(['status', '--porcelain'], ctx.repoPath)).toBe('');
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it('合法契约写盘后被 syncContracts 收养，无需第二次人工动作', async () => {
    const ctx = await makeCtx('adopt', {}, [{ role: 'leader' }, { role: 'developer' }, { role: 'developer' }]);
    try {
      const created = await ctx.service.contractCreate({
        teamId: ctx.teamId,
        contracts: [valid, contractDraft({ id: 'CORE-2', title: '扩展', touches: ['server/ext/'], dependsOn: ['CORE-1'] })],
      });
      expect(created.created.map((item) => item.path)).toEqual(['.tasks/CORE-1.md', '.tasks/CORE-2.md']);
      const file = await readFile(join(ctx.repoPath, '.tasks', 'CORE-1.md'), 'utf8');
      expect(file).toContain('id: CORE-1');
      expect(file).toContain('status: pending');
      expect(file).toContain('- server/core/');
      expect(gitTest(['log', '--format=%s', 'main'], ctx.repoPath)).toContain('tasks: create CORE-1, CORE-2');

      const tick = await ctx.service.tickOnce();
      const team = ctx.service.teamView(ctx.teamId);
      const core1 = team.tasks.find((task) => task.contractId === 'CORE-1');
      expect(core1?.status).toBe('in_progress');
      expect(tick.dispatched).toContain(core1?.id);
      // CORE-2 前置未完 → 仍在 pending，说明契约是被正常解析而不是被忽略。
      expect(team.tasks.find((task) => task.contractId === 'CORE-2')?.status).toBe('pending');
      expect(await readText(join(ctx.repoPath, '.tasks', '_board.md'))).toContain('CORE-1');
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
