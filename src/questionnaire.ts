/**
 * 问卷（questionnaire）实体 —— AI 需要人给一个**决策**才能继续时的载体
 * （docs/design-interaction.md §3）。
 *
 * 它与 escalation 是两件事，所以是两个实体、两条记录，绝不共用：升级说「我卡住了，
 * 来个人分诊」，问卷说「一切正常，只是这个选择得由人来做」。把问卷塞进升级记录会
 * 付出三重代价 —— 任务被错误打上 `needs-human`、进升级直方图、并被 captureLearning
 * 记成一条根本不存在的教训。
 *
 * 本模块只做实体：题目的合法性、答案的归一化与状态推进、以及「一张问卷画成工单
 * 长什么样」。HTTP 投递在 notification.ts，回写文档在 docdraft.ts，编排（谁在什么
 * 阶段问什么、答案落到哪儿）在 service.ts。
 */
import { randomBytes } from 'node:crypto';
import type { SecretRedactor } from './secrets.js';
import type { TicketField, TicketOption } from './notification.js';
import type {
  AnswerSource,
  Question,
  QuestionBinding,
  QuestionnaireKind,
  QuestionnaireMode,
  QuestionnaireView,
} from './view.js';

/** 多选答案的序列化分隔符：选项值本身不允许含它（创建时校验）。 */
export const MULTI_VALUE_SEP = ', ';

/** 一份问卷最多几道题。超过这个数说明该拆成几轮，而不是逼人滚着答完。 */
export const MAX_QUESTIONS = 12;

/** 问卷记录 = 对外视图 + 只留在服务侧的审批码。 */
export interface QuestionnaireRecord extends QuestionnaireView {
  /**
   * `doc_approve` 的一次性凭据。刻意**不在视图里**：全量快照会进模型读得到的
   * session 日志，写进视图等于让组长自己批准自己的文档（§8-10）。
   * 没有审批事项的问卷为 null。
   */
  approvalCode: string | null;
}

/**
 * 记录 → 对外视图。唯一被剥掉的是审批码（见上面的注释与 schema.ts 的说明）。
 * 用「复制 + delete」而不是逐字段重列：字段清单已经由 schema.ts 管着，
 * 这里再抄一份迟早和它漂移。
 */
export function questionnaireViewOf(record: QuestionnaireRecord): QuestionnaireView {
  const view = { ...record } as Partial<QuestionnaireRecord>;
  delete view.approvalCode;
  return view as QuestionnaireView;
}

export interface QuestionnaireInput {
  teamId: string;
  kind: QuestionnaireKind;
  title: string;
  mode: QuestionnaireMode;
  questions: Question[];
  /** 答案落地的位置；null 表示只回给调用方、不落文档。 */
  binding?: QuestionBinding | null;
  /** 绑定的任务（面板的「等人回答」标记与卡死豁免都靠它）。 */
  taskId?: string | null;
  /** interactive 模式的 await 上限；null / 非正 = 不过期（async 模式恒为 null）。 */
  timeoutMs?: number | null;
  /** 需要人批文档时由 service 铸造（见 newApprovalCode）。 */
  approvalCode?: string | null;
}

export interface AnswerResult {
  ok: boolean;
  message?: string;
  /** 仍未作答的必填题标签：工单页把它们重述一遍，人不必回头猜漏了哪题。 */
  missing?: string[];
  record?: QuestionnaireRecord;
}

/** 铸造一次性的文档审批码。人从工单页 / 邮件里读到它，再交给 doc_approve。 */
export function newApprovalCode(): string {
  return randomBytes(6).toString('hex').toUpperCase();
}

const splitMulti = (value: string): string[] =>
  value
    .split(MULTI_VALUE_SEP)
    .map((part) => part.trim())
    .filter((part) => part !== '');

/** 一道题的显示值：选项题回落到人看得懂的 label，而不是 `docker-single`。 */
export function displayValue(question: Question, value: string): string {
  if (question.options.length === 0) return value;
  return value
    .split(MULTI_VALUE_SEP)
    .map((part) => question.options.find((option) => option.value === part.trim())?.label ?? part.trim())
    .join(MULTI_VALUE_SEP);
}

/**
 * 题目自检：形状错的问卷宁可在**创建时**抛错，也不要等人答完才发现答案无处可去。
 * 规则都写在错误消息里，因为调用方是模型 —— 它要能照着改。
 */
export function validateQuestions(questions: Question[]): void {
  if (questions.length === 0) throw new Error('questionnaire: at least one question is required');
  if (questions.length > MAX_QUESTIONS) {
    throw new Error(`questionnaire: ${questions.length} questions is past the cap of ${MAX_QUESTIONS}; ask in rounds instead`);
  }
  const seen = new Set<string>();
  for (const [index, question] of questions.entries()) {
    const at = `question #${index + 1}`;
    if (question.name === '') throw new Error(`questionnaire: ${at} has an empty "name"`);
    if (!/^[A-Za-z][\w.-]*$/.test(question.name)) {
      throw new Error(
        `questionnaire: ${at} name "${question.name}" must match [A-Za-z][A-Za-z0-9_.-]* (it is also the form field name)`,
      );
    }
    if (seen.has(question.name)) throw new Error(`questionnaire: ${at} duplicates question name "${question.name}"`);
    seen.add(question.name);
    if (question.label === '') throw new Error(`questionnaire: ${at} (${question.name}) has an empty "label"`);
    const isChoice = question.type === 'select' || question.type === 'multiselect';
    if (isChoice && question.options.length < 2) {
      throw new Error(`questionnaire: ${at} (${question.name}) is a "${question.type}" but has fewer than 2 options`);
    }
    if (!isChoice && question.options.length > 0) {
      throw new Error(`questionnaire: ${at} (${question.name}) is "${question.type}" and must not carry options`);
    }
    const values = new Set<string>();
    for (const option of question.options) {
      if (option.value === '') {
        throw new Error(`questionnaire: ${at} (${question.name}) has an option with an empty value`);
      }
      // 答案用 `, ` 连接多个值，选项值里含逗号会让一个答案拆不出边界。
      if (option.value.includes(',')) {
        throw new Error(
          `questionnaire: ${at} (${question.name}) option value "${option.value}" must not contain a comma (answers join multi-selections with ", ")`,
        );
      }
      if (values.has(option.value)) {
        throw new Error(`questionnaire: ${at} (${question.name}) has duplicate option value "${option.value}"`);
      }
      values.add(option.value);
    }
    if (question.defaultValue !== '') {
      const wanted = question.type === 'multiselect' ? splitMulti(question.defaultValue) : [question.defaultValue];
      for (const part of wanted) {
        if (!values.has(part)) {
          throw new Error(
            `questionnaire: ${at} (${question.name}) defaultValue "${part}" is not one of its option values (${[...values].join(', ')})`,
          );
        }
      }
    }
  }
}

export class QuestionnaireManager {
  private readonly records: QuestionnaireRecord[] = [];
  private seq = 0;

  constructor(private readonly options: { redactor: SecretRedactor; maxRecords?: number }) {}

  get all(): readonly QuestionnaireRecord[] {
    return this.records;
  }

  get open(): QuestionnaireRecord[] {
    return this.records.filter((record) => record.status === 'open');
  }

  /** 崩溃恢复：老 state.json 里没有这个字段，调用方一律 `?? []` 兜底。 */
  restore(records: QuestionnaireRecord[]): void {
    this.records.length = 0;
    this.records.push(...records);
  }

  byId(id: string): QuestionnaireRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  /** 挂着 open 问卷的任务 id：checkStuck 靠它豁免「等人回答」的等待期（§6.5）。 */
  awaitingTaskIds(): string[] {
    return [...new Set(this.open.map((record) => record.taskId).filter((id): id is string => id !== null))];
  }

  /** 建一份问卷。文本一律脱敏 —— 题目里可能被转述进一句带密钥的话。 */
  create(input: QuestionnaireInput): QuestionnaireRecord {
    validateQuestions(input.questions);
    const now = Date.now();
    const redact = (text: string): string => this.options.redactor.redact(text);
    const questions = input.questions.map((question) => ({
      ...question,
      label: redact(question.label),
      defaultValue: redact(question.defaultValue),
      options: question.options.map((option) => ({
        ...option,
        label: redact(option.label),
        impact: redact(option.impact),
      })),
    }));
    const timeoutMs = input.timeoutMs ?? 0;
    const record: QuestionnaireRecord = {
      id: `qn_${now.toString(36)}_${(this.seq += 1)}`,
      teamId: input.teamId,
      kind: input.kind,
      title: redact(input.title),
      mode: input.mode,
      questions,
      answers: {},
      status: 'open',
      binding: input.binding ?? null,
      ticketUrl: null,
      mailDelivered: false,
      taskId: input.taskId ?? null,
      createdAt: now,
      answeredAt: null,
      // 只有 interactive 会到期：async 的问卷本来就该一直挂着等人答。
      expiresAt: input.mode === 'interactive' && timeoutMs > 0 ? now + timeoutMs : null,
      approvalCode: input.approvalCode ?? null,
    };
    this.records.push(record);
    // 有界：无人值守跑久了，答完的问卷会一直堆进每一份全量快照里。
    const max = this.options.maxRecords ?? 100;
    if (this.records.length > max) {
      const firstSettled = this.records.findIndex((candidate) => candidate.status !== 'open');
      if (firstSettled !== -1) this.records.splice(firstSettled, 1);
    }
    return record;
  }

  /** 投递结果回写：工单链接与邮件是否真的送达。 */
  markDelivery(id: string, delivery: { ticketUrl: string | null; mailDelivered: boolean }): void {
    const record = this.byId(id);
    if (record === undefined) return;
    record.ticketUrl = delivery.ticketUrl;
    record.mailDelivered = delivery.mailDelivered;
  }

  /** 仍未作答的必填题。 */
  pendingRequired(record: QuestionnaireRecord): Question[] {
    return record.questions.filter((question) => {
      if (!question.required) return false;
      const answer = record.answers[question.name];
      return answer === undefined || answer.value.trim() === '';
    });
  }

  /**
   * 应用一批答案。**校验不过一条都不写**：半份问卷比零份更糟 —— 状态看起来在往前
   * 走，实际答案与问题已经对不上了。写进去的部分答案则保留（必填未答时不改状态、
   * 只回 missing），否则人每次漏答都要从第一题重答。
   */
  answer(id: string, answers: Record<string, string>, source: AnswerSource): AnswerResult {
    const record = this.byId(id);
    if (record === undefined) return { ok: false, message: 'questionnaire not found' };
    if (record.status !== 'open') {
      return { ok: false, message: `questionnaire ${id} is already ${record.status}` };
    }
    const known = new Map(record.questions.map((question) => [question.name, question]));
    const normalized: Record<string, string> = {};
    for (const [name, raw] of Object.entries(answers)) {
      const question = known.get(name);
      if (question === undefined) {
        return {
          ok: false,
          message: `unknown question "${name}"; this questionnaire asks: ${record.questions.map((q) => q.name).join(', ') || '(nothing)'}`,
        };
      }
      const value = this.normalizeValue(question, raw);
      const error = this.validateValue(question, value);
      if (error !== null) return { ok: false, message: error };
      normalized[name] = value;
    }
    const at = Date.now();
    for (const [name, value] of Object.entries(normalized)) {
      record.answers[name] = { value, at, source };
    }
    const missing = this.pendingRequired(record);
    if (missing.length > 0) return { ok: false, missing: missing.map((question) => question.label), record };
    record.status = 'answered';
    record.answeredAt = at;
    return { ok: true, record };
  }

  /** 超时：interactive 的 await 到点后挪走状态，避免一条问卷永久挂着。 */
  expire(id: string): void {
    const record = this.byId(id);
    if (record !== undefined && record.status === 'open') record.status = 'expired';
  }

  /** 人明确说不问了 / 组长撤掉一次多余的追问。 */
  cancel(id: string): void {
    const record = this.byId(id);
    if (record !== undefined && record.status === 'open') record.status = 'cancelled';
  }

  /**
   * 审批码比对。长度相同才逐字节比 —— 这是凭据不是文案，别用 `===` 短路成
   * 一个可测的前缀 oracle。
   */
  verifyApprovalCode(id: string, code: string): boolean {
    const record = this.byId(id);
    if (record === undefined || record.approvalCode === null) return false;
    const expected = Buffer.from(record.approvalCode, 'utf8');
    const actual = Buffer.from(code.trim().toUpperCase(), 'utf8');
    if (expected.length !== actual.length) return false;
    let diff = 0;
    for (let index = 0; index < expected.length; index += 1) {
      diff |= expected[index]! ^ actual[index]!;
    }
    return diff === 0;
  }

  /** 一次性凭据用完即废：批过一次码的问卷不能再被拿来批第二份文档。 */
  consumeApprovalCode(id: string): void {
    const record = this.byId(id);
    if (record !== undefined) record.approvalCode = null;
  }

  /** 空白 → 空串（未答）；多选题顺手去重、去空，因为重复勾选是同一个答案。 */
  private normalizeValue(question: Question, raw: string): string {
    const value = this.options.redactor.redact(raw.trim());
    if (question.type !== 'multiselect' || value === '') return value;
    const seen = new Set<string>();
    return splitMulti(value)
      .filter((part) => {
        if (seen.has(part)) return false;
        seen.add(part);
        return true;
      })
      .join(MULTI_VALUE_SEP);
  }

  /** 只在答案与题目对不上时报错；空值交给必填检查（pendingRequired）。 */
  private validateValue(question: Question, value: string): string | null {
    if (value.trim() === '' || question.options.length === 0) return null;
    const allowed = new Set(question.options.map((option) => option.value));
    const parts = question.type === 'multiselect' ? splitMulti(value) : [value];
    const unknown = parts.filter((part) => !allowed.has(part));
    if (unknown.length === 0) return null;
    return `answer for "${question.name}" has unknown option(s): ${unknown.join(MULTI_VALUE_SEP)}; pick from: ${[...allowed].join(MULTI_VALUE_SEP)}`;
  }
}

/**
 * 把一份问卷画成工单字段（§3.3）：选项题用 select / multiselect 并预勾 recommended，
 * 填空题用 text / textarea。带审批码的问卷把码写在说明里 —— 那是它唯一的出口，
 * 投影里没有。
 */
export function ticketFieldsOf(record: QuestionnaireRecord): { notice: string; fields: TicketField[] } {
  const fields: TicketField[] = record.questions.map((question) => {
    const options: TicketOption[] = question.options.map((option) => ({
      value: option.value,
      label: option.label,
      checked: option.recommended || option.value === question.defaultValue,
      ...(option.impact === '' ? {} : { impact: option.impact }),
    }));
    return {
      name: question.name,
      label: question.label,
      type: question.type,
      ...(question.required ? { required: true } : {}),
      ...(options.length === 0 ? {} : { options }),
    };
  });
  const notice =
    record.kind === 'approval'
      ? [
          'AI 团队写好了待批文档，需要人确认后才能升格为正式文档。',
          record.approvalCode === null
            ? '本单已无待批内容（审批码已作废）。'
            : `审批码：${record.approvalCode}；这是一次性凭据，只有读到本页的人才能批准。`,
        ].join(' ')
      : 'AI 团队需要你做一个决策才能继续。这不是故障上报 —— 没有任何东西坏掉，只是这个选择得由人来做。';
  return { notice, fields };
}

/**
 * 答案 → 带时间戳的 `[decision]` 决策行（§3.4）。写进文档的是选项 label 而不是
 * 原始值，因为读文档的人要一眼看懂选了什么；来源必须写清 —— 工单答复是本人操作，
 * 会话答复只是「有人替人转述」，两者可信度不同。
 */
export function decisionNotes(record: QuestionnaireRecord): string[] {
  const lines: string[] = [''];
  for (const [index, question] of record.questions.entries()) {
    const answer = record.answers[question.name];
    if (answer === undefined || answer.value.trim() === '') continue;
    const source = answer.source === 'ticket' ? '工单答复' : '会话答复';
    const fallback =
      question.defaultValue === ''
        ? ''
        : question.defaultValue === answer.value
          ? '，采纳默认方案'
          : `，默认方案是 ${displayValue(question, question.defaultValue)}`;
    lines.push(
      `> [decision] ${new Date(answer.at).toISOString()} Q${index + 1} ${question.label} = ${displayValue(question, answer.value)}（${source}${fallback}）`,
    );
  }
  if (lines.length === 1) return [];
  lines.push('');
  return lines;
}
