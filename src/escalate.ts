/**
 * 升级与通知（spec §4.2 escalate，§4.3 升级触发条件）。
 *
 * 一次升级：记录事件、把任务标记为 `needs-human`、在任务文件上追加人类可读
 * 的备注，并用脱敏后的上下文触发配置好的 webhook。它对 webhook 失败绝不抛错
 * —— 投递状态本身就是记录上的数据。
 */
import type { EscalationReason, EscalationView, EscalationNotification } from './view.js';
import { resolveOptionalEnvRef, SecretRedactor } from './secrets.js';

export interface EscalationInput {
  taskId: string | null;
  reason: EscalationReason;
  message: string;
  suggestion: string;
  logTail?: string;
}

export interface EscalationSink {
  /** 在任务契约文件（.tasks/<id>.md）上持久化一条备注。 */
  writeTaskNote(taskId: string, note: string): Promise<void>;
  /** 给任务打上「需人工」标记。 */
  labelTask(taskId: string, label: string): Promise<void>;
}

export interface EscalationManagerOptions {
  webhookUrlEnv?: string | undefined;
  label: string;
  redactor: SecretRedactor;
  sink: EscalationSink;
  /** 测试可注入；默认取全局 fetch。 */
  fetchFn?: typeof fetch;
  /**
   * 人工通知钩子：发起升级后尝试联系到人（发一封带工单链接的邮件）。
   * 返回通知状态，或在通知被禁用时返回 null。绝不抛错——投递状态就是数据。
   */
  notify?: (
    record: EscalationView,
  ) => Promise<EscalationNotification | null> | EscalationNotification | null;
}

let escalationSeq = 0;

export class EscalationManager {
  private readonly records: EscalationView[] = [];

  constructor(private readonly options: EscalationManagerOptions) {}

  get all(): readonly EscalationView[] {
    return this.records;
  }

  get open(): EscalationView[] {
    return this.records.filter((record) => record.resolvedAt === null);
  }

  /** Load previously persisted records (daemon recovery). */
  restore(records: EscalationView[]): void {
    this.records.length = 0;
    this.records.push(...records);
  }

  /**
   * 发起一次升级。副作用：任务备注 + 标记（当给出 taskId 时）、webhook POST
   *（当已配置时）。返回存储下来的记录。
   */
  async escalate(input: EscalationInput): Promise<EscalationView> {
    const redactor = this.options.redactor;
    const record: EscalationView = {
      id: `esc_${Date.now().toString(36)}_${(escalationSeq += 1)}`,
      taskId: input.taskId,
      reason: input.reason,
      message: redactor.redact(input.message),
      suggestion: redactor.redact(input.suggestion),
      logTail: redactor.redact(input.logTail ?? ''),
      webhookDelivered: false,
      createdAt: Date.now(),
      resolvedAt: null,
      notification: null,
    };
    this.records.push(record);

    if (input.taskId !== null) {
      const note = [
        '',
        `> [needs-human] ${new Date(record.createdAt).toISOString()} ${record.reason}`,
        `> ${record.message}`,
        `> suggested action: ${record.suggestion}`,
        '',
      ].join('\n');
      await this.options.sink.writeTaskNote(input.taskId, note).catch(() => {});
      await this.options.sink.labelTask(input.taskId, this.options.label).catch(() => {});
    }

    record.webhookDelivered = await this.deliverWebhook(record);

    // 人工通知是尽力而为的：失败的邮件器绝不能阻塞升级记录。notify 钩子住在
    // service 里（它闭包引用了 TicketServer + Mailer），但在这里被调用，这样
    // 投递状态能在一个地方被落到记录上。
    if (this.options.notify !== undefined) {
      try {
        record.notification = await this.options.notify(record);
      } catch {
        record.notification = {
          status: 'failed',
          mailTo: '',
          mailDelivered: false,
          ticketUrl: null,
          submitted: null,
          submittedAt: null,
          autoResumed: false,
          error: 'notification failed',
        };
      }
    }
    return record;
  }

  /** 标记一条升级已解决（人类把任务分诊回 pending）。 */
  resolve(escalationId: string): void {
    const record = this.records.find((candidate) => candidate.id === escalationId);
    if (record !== undefined) record.resolvedAt = Date.now();
  }

  private async deliverWebhook(record: EscalationView): Promise<boolean> {
    const url = resolveOptionalEnvRef(this.options.webhookUrlEnv);
    if (url === undefined) return false;
    const fetchImpl = this.options.fetchFn ?? fetch;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: `[dsh-ai-team] escalation: ${record.reason}`,
          escalation: record,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
