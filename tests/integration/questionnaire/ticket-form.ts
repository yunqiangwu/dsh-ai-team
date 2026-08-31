/** 问卷工单表单（场景二）与 formmodel 预选语义（原 test-questionnaire.ts 拆出）。 */
import { describe, expect, it } from 'vitest';
import { AutopilotService } from '../../../src/service.js';
import { fieldsOfQuestions } from '../../../src/formmodel.js';
import { TICKET_PATH_PREFIX, TicketHandler, TicketServer, type TicketStore } from '../../../src/ticket-handler.js';
import { ticketFieldsOf } from '../../../src/questionnaire.js';
import type { AutopilotOptions } from '../../../src/service/options.js';
import type { Question, QuestionType } from '../../../src/view.js';
import { makeFixture, testOptions } from '../../helpers.js';
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

describe('formmodel: 预选语义', () => {
  const checkedOf = (name: string) => {
    const fields = fieldsOfQuestions([
      q({ name, label: '部署形态？', type: 'select', options: [
        { value: 'docker-single', label: '单机 Docker', recommended: true }, { value: 'k8s', label: 'K8s' },
      ] }),
    ]);
    return fields[0]!.options!.find((option) => option.value === 'docker-single')!.checked;
  };

  it('单选推荐项（无默认值）预勾推荐项', () => {
    expect(checkedOf('deploy')).toBe(true);
  });

  it('单选有默认值时预勾默认项；推荐与他人指向另一项时不双预勾', () => {
    const [platform] = fieldsOfQuestions([
      q({ name: 'platform', label: '部署形态？', type: 'select', defaultValue: 'k8s', options: [
        { value: 'docker-single', label: '单机 Docker', recommended: true }, { value: 'k8s', label: 'K8s' },
      ] }),
    ]);
    const fieldOptions = platform!.options!;
    expect(fieldOptions.find((option) => option.value === 'docker-single')!.checked).toBe(false);
    expect(fieldOptions.find((option) => option.value === 'k8s')!.checked).toBe(true);
    // 单选绝不双预勾：推荐项与默认项都只能有一个被选中。
    expect(fieldOptions.filter((option) => option.checked === true)).toHaveLength(1);
  });

  it('多选预勾推荐项，defaultValue 里列出的值也预勾', () => {
    const [secrets] = fieldsOfQuestions([
      q({ name: 'secrets', label: '哪些密钥？', type: 'multiselect', defaultValue: 'ssh-key, api-token', options: [
        { value: 'ssh-key', label: 'SSH 私钥', recommended: true }, { value: 'api-token', label: '平台 token' },
        { value: 'webhook', label: 'Webhook 密钥' },
      ] }),
    ]);
    const fieldOptions = secrets!.options!;
    expect(fieldOptions.find((option) => option.value === 'ssh-key')!.checked).toBe(true);
    expect(fieldOptions.find((option) => option.value === 'api-token')!.checked).toBe(true);
    expect(fieldOptions.find((option) => option.value === 'webhook')!.checked).toBe(false);
  });
});