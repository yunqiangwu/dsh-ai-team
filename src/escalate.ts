/**
 * Escalation & notification (spec §4.2 escalate, §4.3 escalation triggers).
 *
 * An escalation: records the event, labels the task `needs-human`, appends a
 * human-readable note to the task file, and fires the configured webhook with
 * redacted context. It never throws for webhook failures — delivery status is
 * data on the record.
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
  /** Persist a note on the task contract file (.tasks/<id>.md). */
  writeTaskNote(taskId: string, note: string): Promise<void>;
  /** Apply the human-attention label to the task. */
  labelTask(taskId: string, label: string): Promise<void>;
}

export interface EscalationManagerOptions {
  webhookUrlEnv?: string | undefined;
  label: string;
  redactor: SecretRedactor;
  sink: EscalationSink;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /**
   * Human-notification hook: raise an escalation, then attempt to reach a
   * person (email a ticket link). Returns the notification state or null when
   * notification is disabled. Never throws — delivery state is data.
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
   * Raise an escalation. Side effects: task note + label (when taskId given),
   * webhook POST (when configured). Returns the stored record.
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

    // Human-notification is best-effort: a failing mailer must never block the
    // escalation record. The notify hook lives in the service (it closes over
    // the TicketServer + Mailer) but is invoked here so delivery state is
    // captured on the record in one place.
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

  /** Mark an escalation resolved (human triaged the task back to pending). */
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
