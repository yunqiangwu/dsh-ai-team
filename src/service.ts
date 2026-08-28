/**
 * AutopilotService — the heart of dsh-ai-team.
 *
 * Extends the dsh-ai-team collaboration model (isolated per-member git
 * worktrees on one shared repository, leader → developer task board,
 * reviewer-gated merges) with everything unattended operation needs:
 * remote clone/push, bare-machine bootstrap, objective quality gates, a
 * daemon run loop with crash recovery, escalation, and the deploy loop.
 *
 * The service is runtime-agnostic on purpose: it never touches cordis or the
 * session log, so integration tests can drive it directly. The plugin entry
 * (index.ts) provides it as the `autopilot` service and the tool layer
 * (tools.ts) translates mutations into session events.
 *
 * State persists to <stateDir>/state.json (debounced) plus a heartbeat file
 * on every loop tick; dispose() flushes.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  addWorktree,
  checkout,
  cloneRemote,
  commitAll,
  countNewCommits,
  createBranch,
  deleteBranch,
  ensureRepo,
  fetchRemote,
  forbiddenPathViolations,
  git,
  isSshRemote,
  lastCommitAt,
  listBranches,
  mergeBranch,
  pushBranch,
  resolveRef,
  sshEnvForKey,
} from './git.js';
import { bootstrapEnvironment, type BootstrapReport } from './bootstrap.js';
import { runGates } from './gates.js';
import { runDeploy } from './deploy.js';
import { EscalationManager, type EscalationInput } from './escalate.js';
import { Mailer, TicketServer, type TicketStore } from './notification.js';
import { resolveOptionalEnvRef, SecretRedactor } from './secrets.js';
import {
  appendTaskNote,
  loadTaskContracts,
  patchTaskContract,
  regenerateBoard,
  touchesOverlap,
  type TaskContract,
} from './team.js';
import { defaultMemberName, isRole, systemPromptFor } from './roles.js';
import type {
  CiStatus,
  DeployView,
  EscalationNotification,
  EscalationView,
  GateSummary,
  HeartbeatView,
  LoopState,
  MemberStatus,
  MemberView,
  ReviewVerdict,
  ReviewView,
  Role,
  TaskStatus,
  TaskView,
  TeamView,
} from './view.js';

const shortId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

// ── runtime options (post-Config-validation) ────────────────────────────────

export interface AutopilotOptions {
  rootDir: string;
  stateDir?: string | undefined;
  baseBranch: string;
  maxMembers: number;
  maxTasks: number;
  remote: {
    url: string;
    sshKeyEnv: string;
    platform: 'github' | 'cnb' | 'gitlab' | 'generic';
    apiTokenEnv?: string | undefined;
  };
  bootstrap: {
    enabled: boolean;
    toolchain: string[];
    setupCommand: string;
    verifyCommand: string;
  };
  gates: {
    commands: string[];
    e2eCommand?: string | undefined;
    requireCiGreen: boolean;
    timeoutMinutes: number;
  };
  daemon: {
    heartbeatSeconds: number;
    maxReviewRounds: number;
    stuckMinutes: number;
    pollIntervalSeconds: number;
  };
  escalation: {
    webhookUrlEnv?: string | undefined;
    label: string;
    pauseOnEscalation: 'task' | 'team';
  };
  notification?: {
    enabled: boolean;
    /** SMTP transport. */
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      userEnv: string;
      passEnv: string;
      fromEnv?: string | undefined;
      startTls?: boolean | undefined;
    };
    /** Recipient(s) of the human-notification email (comma/space separated). */
    mailTo: string;
    /** Local HTTP ticket endpoint bind host/port. */
    ticket: {
      host: string;
      port: number;
      /** Base URL presented in the email (e.g. http://server:8080). */
      publicBaseUrl: string;
    };
    /**
     * Auto-resume: when a ticket is answered, write the answer back and clear
     * the escalation (task → pending) without waiting for escalation_resolve.
     */
    autoResume: boolean;
    /** Env var name for the "From" header; defaults to smtp.fromEnv. */
    fromEnv?: string | undefined;
  } | undefined;
  deploy?: {
    enabled: boolean;
    command?: string | undefined;
    healthCheckUrl?: string | undefined;
    rollbackCommand?: string | undefined;
    secretsEnv: string[];
  } | undefined;
  security: {
    forbiddenPaths: string[];
    commandAllowlist: string[];
    pushRequiresGates: boolean;
  };
  /** Test hook: shrink loop sleeps/backoffs. */
  tickSleepMs?: number | undefined;
  /** Test hook: injectable fetch for webhook/CI/health-check calls. */
  fetchFn?: typeof fetch | undefined;
}

// ── internal records ────────────────────────────────────────────────────────

interface MemberRecord {
  id: string;
  name: string;
  role: Role;
  systemPrompt: string;
  workspacePath: string;
  branch: string;
  status: MemberStatus;
  currentTaskId: string | null;
}

interface TaskRecord {
  id: string;
  contractId: string | null;
  title: string;
  description: string;
  assigneeId: string;
  status: TaskStatus;
  branch: string;
  reviewRound: number;
  dependsOn: string[];
  touches: string[];
  gates: GateSummary | null;
  prUrl: string | null;
  ciStatus: CiStatus | null;
  lastActivityAt: number;
  createdAt: number;
  updatedAt: number;
}

interface ReviewRecord {
  id: string;
  taskId: string;
  reviewerId: string;
  verdict: ReviewVerdict;
  comments: string;
  createdAt: number;
}

interface TeamRecord {
  id: string;
  name: string;
  repoPath: string;
  workspaceRoot: string;
  baseBranch: string;
  branches: string[];
  members: MemberRecord[];
  tasks: TaskRecord[];
  reviews: ReviewRecord[];
  createdAt: number;
}

interface PersistedState {
  version: 1;
  teams: TeamRecord[];
  activeTeamId: string | null;
  escalations: EscalationView[];
  deploys: DeployView[];
  loopState: LoopState;
  tick: number;
  bootstrapped: boolean;
  lastDeployBaseSha: string | null;
}

export interface TickReport {
  tick: number;
  events: string[];
  recovered: string[];
  dispatched: string[];
  escalated: string[];
  deployed: string | null;
  completed: boolean;
}

export class AutopilotService {
  private teams = new Map<string, TeamRecord>();
  private listeners = new Set<() => void>();
  private activeTeamId: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private loopState: LoopState = 'stopped';
  private tick = 0;
  private bootstrapped = false;
  private lastDeployBaseSha: string | null = null;
  private notificationMailer: Mailer | null = null;
  private notificationServer: TicketServer | null = null;
  private deploys: DeployView[] = [];
  private recoveredOnce = false;
  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;

  readonly redactor = new SecretRedactor();
  readonly escalations: EscalationManager;

  private constructor(private readonly options: AutopilotOptions & { rootDir: string; stateDir: string }) {
    this.escalations = new EscalationManager({
      webhookUrlEnv: options.escalation.webhookUrlEnv,
      label: options.escalation.label,
      redactor: this.redactor,
      sink: {
        writeTaskNote: async (taskId, note) => {
          const found = this.tryFindTask(taskId);
          if (found?.task.contractId != null) {
            const contractPath = join(found.team.repoPath, '.tasks', `${found.task.contractId}.md`);
            await appendTaskNote(contractPath, note);
            await this.commitTasksDir(found.team, `tasks: note on ${found.task.contractId}`);
          }
        },
        labelTask: async (taskId) => {
          const found = this.tryFindTask(taskId);
          if (found?.task.contractId != null) {
            const contractPath = join(found.team.repoPath, '.tasks', `${found.task.contractId}.md`);
            await patchTaskContract(contractPath, { status: 'needs-human' });
            await this.commitTasksDir(found.team, `tasks: ${found.task.contractId} needs-human`);
          }
        },
      },
      notify: (record) => this.notifyEscalation(record),
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    });
  // Register every env-referenced secret with the redactor up front.
    this.redactor.registerEnvNames([
      options.remote.sshKeyEnv,
      options.remote.apiTokenEnv,
      options.escalation.webhookUrlEnv,
      ...(options.deploy?.secretsEnv ?? []),
    ]);
    this.initNotification();
  }

  /**
   * Wire the human-notification loop (SMTP mailer + local ticket endpoint).
   * Best-effort: a broken config never stops the daemon — it just records a
   * failed notification on escalation and carries on.
   */
  private initNotification(): void {
    const config = this.options.notification;
    if (config?.enabled !== true) return;
    try {
      const mailer = Mailer.create({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        startTls: config.smtp.startTls,
        userEnv: config.smtp.userEnv,
        passEnv: config.smtp.passEnv,
        fromEnv: config.smtp.fromEnv ?? config.fromEnv,
        redactor: this.redactor,
      });
      this.notificationMailer = mailer;

      const server = new TicketServer({
        host: config.ticket.host,
        port: config.ticket.port,
        store: this.ticketStore(),
      });
      void server.start().catch(() => {});
      this.notificationServer = server;
    } catch {
      this.notificationMailer = null;
      this.notificationServer = null;
    }
  }

  /** The ticket store feeds on the live escalation records (by id). */
  private ticketStore(): TicketStore {
    return {
      renderTicket: async (id) => {
        const record = this.escalations.all.find((candidate) => candidate.id === id);
        if (record === undefined) return null;
        const taskTitle =
          record.taskId !== null ? this.taskTitleFor(record.taskId) ?? record.taskId : 'deploy / global';
        const fields = [
          {
            name: 'decision',
            label: '请确认如何处理该问题（填写你的决策）',
            type: 'textarea' as const,
            required: true,
            placeholder: '例如：同意该方案 / 更换密钥 / 变更需求……',
          },
          {
            name: 'note',
            label: '补充说明（可选；密钥请通过环境变量提供，勿直接粘贴）',
            type: 'text' as const,
            placeholder: '任何需要 AI 团队知道的上下文',
          },
        ];
        return {
          title: `人工确认：${taskTitle}`,
          fields,
        };
      },
      handleSubmit: (id, answers) => this.submitTicketAnswer(id, answers),
    };
  }

  /**
   * Apply a submitted ticket answer to a live escalation. This is the closure
   * the TicketServer reaches: write the answer back to the record/task note and
   * (with autoResume) clear the escalation + resume the loop. Public so the
   * exact same path can be driven from tools and tests.
   */
  async submitTicketAnswer(
    escalationId: string,
    answers: Record<string, string>,
  ): Promise<{ ok: boolean; message?: string }> {
    const record = this.escalations.all.find((candidate) => candidate.id === escalationId);
    if (record === undefined) return { ok: false, message: 'ticket not found' };
    const answer = answers.decision ?? answers.note ?? '';
    if (answer.trim() === '') return { ok: false, message: 'decision is required' };
    record.notification = {
      ...(record.notification ?? {
        status: 'sent' as const,
        mailTo: '',
        mailDelivered: false,
        ticketUrl: null,
        submitted: null,
        submittedAt: null,
        autoResumed: false,
        error: null,
      }),
      submitted: this.redactAnswers(answers),
      submittedAt: Date.now(),
    };
    // Apply the human decision: write note + (with autoResume) clear the
    // escalation and re-open the task without waiting for escalation_resolve.
    await this.applyHumanDecision(record, answer);
    record.notification.autoResumed = this.options.notification?.autoResume === true;
    this.changed();
    return { ok: true };
  }

  private taskTitleFor(taskId: string): string | null {
    for (const team of this.teams.values()) {
      const task = team.tasks.find((candidate) => candidate.id === taskId);
      if (task !== undefined) return task.title;
    }
    return null;
  }

  private redactAnswers(answers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(answers)) {
      out[key] = this.redactor.redact(value);
    }
    return out;
  }

  /**
   * A human answered the ticket. Write the decision into the task note and,
   * when autoResume, restore the escalation to running + task to pending.
   */
  private async applyHumanDecision(record: EscalationView, answer: string): Promise<void> {
    if (record.taskId !== null) {
      const found = this.tryFindTask(record.taskId);
      if (found !== null && found.task.contractId !== null) {
        const contractPath = join(found.team.repoPath, '.tasks', `${found.task.contractId}.md`);
        const note = [
          '',
          `> [human]: ${new Date().toISOString()} decision recorded`,
          `> ${this.redactor.redact(answer)}`,
          '',
        ].join('\n');
        await appendTaskNote(contractPath, note).catch(() => {});
        await this.commitTasksDir(found.team, `tasks: human decision on ${found.task.contractId}`);
      }
    }
    if (this.options.notification?.autoResume === true) {
      this.escalations.resolve(record.id);
      if (record.taskId !== null) {
        const found = this.tryFindTask(record.taskId);
        if (found !== null && found.task.status === 'needs-human') {
          found.task.status = 'pending';
          found.task.reviewRound = 0;
          found.task.updatedAt = Date.now();
          if (found.task.contractId !== null) {
            const contractPath = join(found.team.repoPath, '.tasks', `${found.task.contractId}.md`);
            await patchTaskContract(contractPath, { status: 'pending', owner: null }).catch(() => {});
            await this.syncBoard(found.team);
            await this.commitTasksDir(found.team, 'tasks: board update');
          }
        }
      }
      if (this.loopState === 'escalated') this.loopState = 'running';
    }
  }

  /**
   * notify hook invoked by EscalationManager after an escalation is recorded:
   * build the ticket link, render & send the email. Best-effort — returns the
   * notification state (disabled / sent / failed) and never throws.
   */
  private async notifyEscalation(record: EscalationView): Promise<EscalationNotification | null> {
    const config = this.options.notification;
    if (config?.enabled !== true) return null;
    const baseUrl = config.ticket.publicBaseUrl.replace(/\/+$/, '');
    const ticketUrl = this.notificationServer === null ? null : `${baseUrl}/ticket/${record.id}`;
    const initial: EscalationNotification = {
      status: 'sent',
      mailTo: config.mailTo,
      mailDelivered: false,
      ticketUrl,
      submitted: null,
      submittedAt: null,
      autoResumed: false,
      error: null,
    };
    // No mailer configured or no ticket endpoint: surface the link but mark
    // mail as undelivered so the panel makes it obvious the human wasn't reached.
    if (this.notificationMailer === null) {
      return { ...initial, status: 'failed', error: 'notification: mailer disabled' };
    }
    const taskTitle =
      record.taskId !== null ? this.taskTitleFor(record.taskId) ?? record.taskId : 'deploy / global';
    const text = [
      `[dsh-ai-team] 需要你的人工确认`,
      ``,
      `任务: ${taskTitle}`,
      `原因: ${record.reason}`,
      `说明: ${record.message}`,
      ``,
      `建议动作: ${record.suggestion}`,
      ``,
      ticketUrl === null ? `（未配置工单端点，请在 dsh 面板查看）` : `请填写工单以继续：${ticketUrl}`,
      ``,
      `回答会回写到任务单；如需密钥请用环境变量提供，勿粘贴明文。`,
    ].join('\n');
    try {
      await this.notificationMailer.send({
        to: config.mailTo,
        subject: `[dsh-ai-team] 人工确认: ${taskTitle}`,
        text,
      });
      return { ...initial, mailDelivered: true, status: 'sent' };
    } catch (error) {
      return {
        ...initial,
        status: 'failed',
        error: `${this.redactor.redact(error instanceof Error ? error.message : String(error))}`,
      };
    }
  }

  /** Create the service and reload any persisted state (crash recovery). */
  static async create(options: AutopilotOptions): Promise<AutopilotService> {
    const resolved = {
      ...options,
      rootDir: resolve(options.rootDir),
      stateDir: resolve(options.stateDir ?? options.rootDir),
    };
    const service = new AutopilotService(resolved);
    await mkdir(resolved.stateDir, { recursive: true });
    await service.load();
    return service;
  }

  // ── persistence ──────────────────────────────────────────────────────────

  private get stateFile(): string {
    return join(this.options.stateDir, 'state.json');
  }

  private get heartbeatFile(): string {
    return join(this.options.stateDir, 'heartbeat.json');
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.stateFile, 'utf8');
    } catch {
      return; // first run
    }
    try {
      const state = JSON.parse(raw) as PersistedState;
      for (const team of state.teams ?? []) this.teams.set(team.id, team);
      this.activeTeamId = state.activeTeamId ?? null;
      this.escalations.restore(state.escalations ?? []);
      this.deploys = state.deploys ?? [];
      this.loopState = state.loopState === 'running' ? 'paused' : (state.loopState ?? 'stopped');
      this.tick = state.tick ?? 0;
      this.bootstrapped = state.bootstrapped ?? false;
      this.lastDeployBaseSha = state.lastDeployBaseSha ?? null;
      for (const team of this.teams.values()) {
        team.branches = await listBranches(team.repoPath).catch(() => team.branches);
      }
    } catch {
      // Corrupt state file: start empty rather than crash the host.
    }
  }

  private snapshot(): PersistedState {
    return {
      version: 1,
      teams: [...this.teams.values()],
      activeTeamId: this.activeTeamId,
      escalations: [...this.escalations.all],
      deploys: this.deploys,
      loopState: this.loopState,
      tick: this.tick,
      bootstrapped: this.bootstrapped,
      lastDeployBaseSha: this.lastDeployBaseSha,
    };
  }

  private persist(): void {
    if (this.disposed) return;
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void writeFile(this.stateFile, `${JSON.stringify(this.snapshot(), null, 2)}\n`, 'utf8').catch(() => {});
    }, 100);
  }

  /** Flush pending state and stop the service. Register via ctx.effect(). */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stopLoop();
    if (this.notificationServer !== null) {
      await this.notificationServer.close().catch(() => {});
      this.notificationServer = null;
    }
    this.notificationMailer = null;
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      await writeFile(this.stateFile, `${JSON.stringify(this.snapshot(), null, 2)}\n`, 'utf8').catch(() => {});
    } else {
      await writeFile(this.stateFile, `${JSON.stringify(this.snapshot(), null, 2)}\n`, 'utf8').catch(() => {});
    }
    this.listeners.clear();
  }

  // ── change notification ──────────────────────────────────────────────────

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(teamId?: string): void {
    if (teamId !== undefined) this.activeTeamId = teamId;
    this.persist();
    for (const listener of this.listeners) listener();
  }

  // ── views ────────────────────────────────────────────────────────────────

  private memberView(member: MemberRecord): MemberView {
    return {
      id: member.id,
      name: member.name,
      role: member.role,
      workspacePath: member.workspacePath,
      branch: member.branch,
      status: member.status,
      currentTaskId: member.currentTaskId,
    };
  }

  private taskView(team: TeamRecord, task: TaskRecord): TaskView {
    return {
      id: task.id,
      contractId: task.contractId,
      title: task.title,
      description: task.description,
      assigneeId: task.assigneeId,
      assigneeName: this.memberOf(team, task.assigneeId).name,
      status: task.status,
      branch: task.branch,
      reviewRound: task.reviewRound,
      dependsOn: task.dependsOn,
      touches: task.touches,
      gates: task.gates,
      prUrl: task.prUrl,
      ciStatus: task.ciStatus,
      lastActivityAt: task.lastActivityAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  private reviewView(team: TeamRecord, review: ReviewRecord): ReviewView {
    return {
      id: review.id,
      taskId: review.taskId,
      reviewerId: review.reviewerId,
      reviewerName: this.memberOf(team, review.reviewerId).name,
      verdict: review.verdict,
      comments: review.comments,
      createdAt: review.createdAt,
    };
  }

  teamView(teamId: string): TeamView {
    const team = this.teamOf(teamId);
    return {
      id: team.id,
      name: team.name,
      repoPath: team.repoPath,
      baseBranch: team.baseBranch,
      branches: [...team.branches],
      members: team.members.map((member) => this.memberView(member)),
      tasks: team.tasks.map((task) => this.taskView(team, task)),
      reviews: team.reviews.map((review) => this.reviewView(team, review)),
      createdAt: team.createdAt,
    };
  }

  memberSystemPrompt(teamId: string, memberId: string): string {
    return this.memberOf(this.teamOf(teamId), memberId).systemPrompt;
  }

  /** Whole-state projection snapshot — the value pushed to the Web UI. */
  projection() {
    const blocked: string[] = [];
    for (const team of this.teams.values()) {
      for (const task of team.tasks) {
        if (task.status === 'needs-human') blocked.push(task.id);
      }
    }
    return {
      loopState: this.loopState,
      teams: [...this.teams.keys()].map((id) => this.teamView(id)),
      activeTeamId: this.activeTeamId,
      escalations: [...this.escalations.all],
      deploys: this.deploys,
      heartbeat: { at: Date.now(), loopState: this.loopState, tick: this.tick } satisfies HeartbeatView,
      blocked,
    };
  }

  // ── lookups ──────────────────────────────────────────────────────────────

  private teamOf(teamId: string): TeamRecord {
    const team = this.teams.get(teamId);
    if (team === undefined) {
      throw new Error(
        `unknown team "${teamId}"${this.teams.size > 0 ? `; known teams: ${[...this.teams.keys()].join(', ')}` : ' (no teams yet — call team_create first)'}`,
      );
    }
    return team;
  }

  private memberOf(team: TeamRecord, memberId: string): MemberRecord {
    const member = team.members.find((candidate) => candidate.id === memberId);
    if (member === undefined) {
      throw new Error(
        `team "${team.name}" has no member "${memberId}"; members: ${team.members.map((m) => `${m.name}(${m.id})`).join(', ') || '(none)'}`,
      );
    }
    return member;
  }

  private findTask(taskId: string): { team: TeamRecord; task: TaskRecord } {
    const found = this.tryFindTask(taskId);
    if (found === null) throw new Error(`unknown task "${taskId}"`);
    return found;
  }

  private tryFindTask(taskId: string): { team: TeamRecord; task: TaskRecord } | null {
    for (const team of this.teams.values()) {
      const task = team.tasks.find((candidate) => candidate.id === taskId || candidate.contractId === taskId);
      if (task !== undefined) return { team, task };
    }
    return null;
  }

  // ── remote helpers ───────────────────────────────────────────────────────

  private get hasRemote(): boolean {
    return this.options.remote.url !== '';
  }

  /** Build authenticated env for remote git ops; undefined for local/generic. */
  private async remoteEnv(): Promise<{ env?: Record<string, string>; cleanup: () => Promise<void> }> {
    if (!this.hasRemote || !isSshRemote(this.options.remote.url)) return { cleanup: async () => {} };
    const key = process.env[this.options.remote.sshKeyEnv];
    if (key === undefined || key === '') {
      throw new Error(
        `remote "${this.options.remote.url}" requires SSH auth but env var "${this.options.remote.sshKeyEnv}" is not set`,
      );
    }
    this.redactor.register(key);
    const { env, cleanup } = await sshEnvForKey(key);
    return { env, cleanup };
  }

  // ── bootstrap (autopilot_init) ───────────────────────────────────────────

  /**
   * Unattended bootstrap: clone the remote into a fresh team's repo slot,
   * satisfy the toolchain rootlessly, run setupCommand + verifyCommand.
   * Failures escalate with the bootstrap report attached.
   */
  async initAutopilot(teamName = 'autopilot'): Promise<{ teamId: string; report: BootstrapReport | null }> {
    if (!this.options.bootstrap.enabled && !this.hasRemote) {
      throw new Error('nothing to initialize: bootstrap.disabled and no remote.url configured');
    }
    // Reuse an existing team when init is retried (idempotent).
    let team = [...this.teams.values()][0];
    if (team === undefined) {
      const view = await this.createTeam({ name: teamName, members: [{ role: 'leader' }], cloneRemote: this.hasRemote });
      team = this.teamOf(view.id);
    } else if (this.hasRemote && !(await this.isCloneOfRemote(team.repoPath))) {
      // The team predates the remote configuration: adopt the remote only
      // when the local repo is still pristine (nothing but the initial
      // commit), otherwise make the conflict explicit instead of silently
      // diverging.
      const branches = await listBranches(team.repoPath);
      const pristine = branches.length <= 1 && team.members.length <= 1;
      if (!pristine) {
        throw new Error(
          `team repo ${team.repoPath} is not a clone of remote "${this.options.remote.url}" and already has local work; ` +
            `set the remote up manually or start from a fresh rootDir`,
        );
      }
      const { env, cleanup } = await this.remoteEnv();
      try {
        await rm(team.repoPath, { recursive: true, force: true });
        await cloneRemote(this.options.remote.url, team.repoPath, team.baseBranch, env);
      } finally {
        await cleanup();
      }
      // Recreate the leader's worktree against the fresh clone.
      const repo = team.repoPath;
      const base = team.baseBranch;
      const leader = team.members[0];
      if (leader !== undefined) {
        await rm(leader.workspacePath, { recursive: true, force: true });
        await addWorktree(repo, leader.workspacePath, leader.branch, base).catch(async () => {
          await deleteBranch(repo, leader.branch).catch(() => {});
          await addWorktree(repo, leader.workspacePath, leader.branch, base);
        });
      }
    }
    if (!this.options.bootstrap.enabled || this.bootstrapped) {
      return { teamId: team.id, report: null };
    }
    try {
      const report = await bootstrapEnvironment({
        toolchain: this.options.bootstrap.toolchain,
        setupCommand: this.options.bootstrap.setupCommand,
        verifyCommand: this.options.bootstrap.verifyCommand,
        repoPath: team.repoPath,
        allowlist: this.options.security.commandAllowlist,
        redactor: this.redactor,
      });
      this.bootstrapped = true;
      this.changed(team.id);
      return { teamId: team.id, report };
    } catch (error) {
      const report = (error as { report?: BootstrapReport }).report ?? null;
      await this.escalateTask({
        taskId: null,
        reason: 'bootstrap-failed',
        message: error instanceof Error ? error.message : String(error),
        suggestion: 'provision the missing tooling manually, fix the setup/verify command, then call autopilot_init again',
        logTail: JSON.stringify(report ?? {}).slice(-2000),
      });
      throw error;
    }
  }

  private async probeRemote(env?: Record<string, string>): Promise<boolean> {
    try {
      await git(['ls-remote', this.options.remote.url, 'HEAD'], this.options.rootDir, { env });
      return true;
    } catch {
      return false;
    }
  }

  private async isCloneOfRemote(repoPath: string): Promise<boolean> {
    try {
      const url = await git(['remote', 'get-url', 'origin'], repoPath);
      return url === this.options.remote.url;
    } catch {
      return false;
    }
  }

  // ── team & member management (dsh-ai-team compatible) ────────────────────

  async createTeam(input: {
    name: string;
    members?: { role: Role; name?: string }[];
    /** Internal: clone the configured remote instead of a local init. */
    cloneRemote?: boolean;
  }): Promise<TeamView> {
    const id = shortId('team');
    const repoPath = join(this.options.rootDir, id, 'repo');
    const workspaceRoot = join(this.options.rootDir, id, 'workspaces');
    if (input.cloneRemote === true && this.hasRemote) {
      const { env, cleanup } = await this.remoteEnv();
      try {
        await cloneRemote(this.options.remote.url, repoPath, this.options.baseBranch, env);
      } finally {
        await cleanup();
      }
    } else {
      await ensureRepo(repoPath, this.options.baseBranch);
    }
    const team: TeamRecord = {
      id,
      name: input.name,
      repoPath,
      workspaceRoot,
      baseBranch: this.options.baseBranch,
      branches: await listBranches(repoPath),
      members: [],
      tasks: [],
      reviews: [],
      createdAt: Date.now(),
    };
    this.teams.set(id, team);
    const requested = input.members ?? [{ role: 'leader' as const }];
    if (requested.filter((m) => m.role === 'leader').length !== 1) {
      this.teams.delete(id);
      throw new Error('a team needs exactly one leader member');
    }
    for (const member of requested) {
      await this.addMember({ teamId: id, role: member.role, ...(member.name !== undefined ? { name: member.name } : {}) });
    }
    return this.teamView(id);
  }

  async addMember(input: { teamId: string; role: Role; name?: string }): Promise<MemberView> {
    const team = this.teamOf(input.teamId);
    if (!isRole(input.role)) {
      throw new Error(`invalid role "${input.role}"; expected leader, developer, reviewer or operator`);
    }
    if (team.members.length >= this.options.maxMembers) {
      throw new Error(`team "${team.name}" already has the maximum of ${this.options.maxMembers} members`);
    }
    if (input.role === 'leader' && team.members.some((m) => m.role === 'leader')) {
      throw new Error(`team "${team.name}" already has a leader`);
    }
    const id = shortId('m');
    const role = input.role;
    const index = team.members.filter((m) => m.role === role).length + 1;
    const name = input.name ?? defaultMemberName(role, index);
    const branch = `member/${id}`;
    const workspacePath = join(team.workspaceRoot, id);
    await addWorktree(team.repoPath, workspacePath, branch, team.baseBranch);
    const member: MemberRecord = {
      id,
      name,
      role,
      systemPrompt: systemPromptFor(role, {
        teamName: team.name,
        memberName: name,
        baseBranch: team.baseBranch,
        maxReviewRounds: this.options.daemon.maxReviewRounds,
      }),
      workspacePath,
      branch,
      status: 'idle',
      currentTaskId: null,
    };
    team.members.push(member);
    team.branches = await listBranches(team.repoPath);
    this.changed(team.id);
    return this.memberView(member);
  }

  // ── task board ───────────────────────────────────────────────────────────

  /**
   * Assign a task (leader or the daemon dispatcher): creates the task branch
   * from base, checks it out in the assignee's workspace. When contractId is
   * given, the contract file must exist in the repo's .tasks/ and its status
   * must be pending (spec §4.4).
   */
  async assignTask(input: {
    teamId: string;
    title: string;
    description?: string;
    assigneeId: string;
    contractId?: string;
  }): Promise<TaskView> {
    const team = this.teamOf(input.teamId);
    if (team.tasks.length >= this.options.maxTasks) {
      throw new Error(`team "${team.name}" already has the maximum of ${this.options.maxTasks} tasks`);
    }
    const assignee = this.memberOf(team, input.assigneeId);
    if (assignee.role === 'reviewer' || assignee.role === 'operator') {
      throw new Error(`${assignee.role}s do not write code; assign the task to a developer`);
    }
    if (assignee.currentTaskId !== null) {
      throw new Error(
        `${assignee.name} is already working on ${assignee.currentTaskId}; finish or update that task first`,
      );
    }
    let contract: TaskContract | null = null;
    if (input.contractId !== undefined) {
      contract = await this.requireContract(team, input.contractId);
      if (contract.status !== 'pending') {
        throw new Error(`task contract "${contract.id}" is ${contract.status}; only pending contracts can be assigned`);
      }
      if (team.tasks.some((task) => task.contractId === contract?.id && task.status !== 'done')) {
        throw new Error(`task contract "${contract.id}" is already on the board`);
      }
    }
    const id = shortId('task');
    const branch = `task/${contract?.id ?? id}`;
    await createBranch(team.repoPath, branch, team.baseBranch);
    await checkout(assignee.workspacePath, branch);
    const now = Date.now();
    const task: TaskRecord = {
      id,
      contractId: contract?.id ?? null,
      title: contract?.title ?? input.title,
      description: input.description ?? contract?.body.slice(0, 2000) ?? '',
      assigneeId: assignee.id,
      status: 'pending',
      branch,
      reviewRound: 0,
      dependsOn: contract?.dependsOn ?? [],
      touches: contract?.touches ?? [],
      gates: null,
      prUrl: null,
      ciStatus: null,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    };
    team.tasks.push(task);
    assignee.branch = branch;
    assignee.status = 'working';
    assignee.currentTaskId = id;
    if (contract !== null) {
      await patchTaskContract(contract.path, { status: 'in_progress', owner: assignee.name }).catch(() => {});
      await this.syncBoard(team);
      await this.commitTasksDir(team, "tasks: board update");
      task.status = 'in_progress';
    }
    team.branches = await listBranches(team.repoPath);
    this.changed(team.id);
    return this.taskView(team, task);
  }

  private async requireContract(team: TeamRecord, contractId: string): Promise<TaskContract> {
    const contracts = await loadTaskContracts(team.repoPath);
    const contract = contracts.find((candidate) => candidate.id === contractId);
    if (contract === undefined) {
      throw new Error(
        `no task contract "${contractId}" in ${join(team.repoPath, '.tasks')}; known: ${contracts.map((c) => c.id).join(', ') || '(none)'}`,
      );
    }
    return contract;
  }

  /** Regenerate .tasks/_board.md from the repo's contracts (best effort). */
  private async syncBoard(team: TeamRecord): Promise<void> {
    const contracts = await loadTaskContracts(team.repoPath).catch(() => null);
    if (contracts !== null) await regenerateBoard(team.repoPath, contracts).catch(() => {});
  }

  /**
   * Commit .tasks/ changes in the integration checkout so the working tree
   * stays clean for merges (best effort: no-op without a .tasks directory).
   */
  private async commitTasksDir(team: TeamRecord, message: string): Promise<void> {
    await commitAll(team.repoPath, '.tasks', message).catch(() => {});
  }

  /**
   * Move a task along the board. Manual transitions are restricted to
   * pending / in_progress / in_review — done and changes_requested are owned
   * by the review flow, needs-human by the escalation flow.
   */
  async updateTask(input: { taskId: string; status: 'pending' | 'in_progress' | 'in_review' }): Promise<TaskView> {
    const { team, task } = this.findTask(input.taskId);
    task.status = input.status;
    task.lastActivityAt = Date.now();
    task.updatedAt = Date.now();
    this.changed(team.id);
    return this.taskView(team, task);
  }

  // ── branch collaboration (dsh-ai-team compatible) ────────────────────────

  async branch(input: {
    teamId: string;
    action: 'list' | 'create' | 'switch' | 'merge';
    branch?: string;
    target?: string;
    memberId?: string;
  }): Promise<{ action: string; branches: string[]; detail: string }> {
    const team = this.teamOf(input.teamId);
    switch (input.action) {
      case 'list': {
        team.branches = await listBranches(team.repoPath);
        this.changed(team.id);
        return { action: 'list', branches: team.branches, detail: `${team.branches.length} branches` };
      }
      case 'create': {
        const branch = requireBranch(input.branch);
        await createBranch(team.repoPath, branch, input.target ?? team.baseBranch);
        team.branches = await listBranches(team.repoPath);
        this.changed(team.id);
        return {
          action: 'create',
          branches: team.branches,
          detail: `created ${branch} from ${input.target ?? team.baseBranch}`,
        };
      }
      case 'switch': {
        const branch = requireBranch(input.branch);
        const member = this.memberOf(team, requireMember(input.memberId));
        const branches = await listBranches(team.repoPath);
        if (!branches.includes(branch)) {
          throw new Error(`branch "${branch}" does not exist; known branches: ${branches.join(', ')}`);
        }
        await checkout(member.workspacePath, branch);
        member.branch = branch;
        this.changed(team.id);
        return { action: 'switch', branches, detail: `${member.name} switched to ${branch}` };
      }
      case 'merge': {
        const branch = requireBranch(input.branch);
        const target = input.target ?? team.baseBranch;
        await mergeBranch(team.repoPath, branch, target, team.baseBranch, `merge: ${branch} into ${target} (dsh-ai-team)`);
        team.branches = await listBranches(team.repoPath);
        this.changed(team.id);
        return { action: 'merge', branches: team.branches, detail: `merged ${branch} into ${target}` };
      }
    }
  }

  // ── quality gates ────────────────────────────────────────────────────────

  /**
   * Run the configured gate commands in the workspace of the task's
   * assignee. The summary is stored on the task (code_review approve
   * requires it green).
   */
  async runGatesForTask(input: { taskId: string; signal?: AbortSignal }): Promise<GateSummary> {
    const { team, task } = this.findTask(input.taskId);
    const assignee = this.memberOf(team, task.assigneeId);
    const commands = [...this.options.gates.commands];
    const summary = await runGates({
      cwd: assignee.workspacePath,
      commands,
      allowlist: this.options.security.commandAllowlist,
      timeoutMs: this.options.gates.timeoutMinutes * 60_000,
      redactor: this.redactor,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      taskId: task.id,
      branch: task.branch,
    });
    task.gates = summary;
    task.lastActivityAt = Date.now();
    task.updatedAt = Date.now();
    this.changed(team.id);
    return summary;
  }

  // ── code review (gated) ──────────────────────────────────────────────────

  /**
   * Reviewer verdict on a task in review. approve requires green quality
   * gates when pushRequiresGates is set (spec §4.5.4), then --no-ff merges
   * into base; conflicts fail and the task stays in_review. request_changes
   * bumps the round and hands the task back.
   */
  async review(input: {
    taskId: string;
    reviewerId: string;
    verdict: ReviewVerdict;
    comments?: string;
  }): Promise<{ review: ReviewView; task: TaskView; merged: boolean }> {
    const { team, task } = this.findTask(input.taskId);
    const reviewer = this.memberOf(team, input.reviewerId);
    if (reviewer.role === 'developer') {
      throw new Error('developers cannot review their own workflow; use a reviewer (or the leader)');
    }
    if (reviewer.id === task.assigneeId) {
      throw new Error('a member cannot review their own task');
    }
    if (task.status !== 'in_review' && task.status !== 'changes_requested') {
      throw new Error(`task "${task.title}" is ${task.status}; only in_review tasks can be reviewed`);
    }
    const assignee = this.memberOf(team, task.assigneeId);
    const review: ReviewRecord = {
      id: shortId('rev'),
      taskId: task.id,
      reviewerId: reviewer.id,
      verdict: input.verdict,
      comments: input.comments ?? '',
      createdAt: Date.now(),
    };
    team.reviews.push(review);
    let merged = false;
    if (input.verdict === 'approve') {
      if (this.options.security.pushRequiresGates) {
        const gates = task.gates;
        if (gates === null || !gates.allPassed) {
          throw new Error(
            `cannot approve: quality gates are not green for task "${task.title}" — run gates_run first and make every gate pass`,
          );
        }
        if (this.options.gates.requireCiGreen && this.hasRemote && task.ciStatus !== null && task.ciStatus !== 'success') {
          throw new Error(
            `cannot approve: remote CI status is "${task.ciStatus ?? 'unknown'}" — wait for CI to go green (pr_sync polls it)`,
          );
        }
      }
      await mergeBranch(
        team.repoPath,
        task.branch,
        team.baseBranch,
        team.baseBranch,
        `merge: ${task.branch} — ${task.title} (approved by ${reviewer.name})`,
      );
      merged = true;
      task.status = 'done';
      assignee.status = 'idle';
      assignee.currentTaskId = null;
      if (task.contractId !== null) {
        const contractPath = join(team.repoPath, '.tasks', `${task.contractId}.md`);
        await patchTaskContract(contractPath, { status: 'done' }).catch(() => {});
        await this.syncBoard(team);
        await this.commitTasksDir(team, "tasks: board update");
      }
      await checkout(assignee.workspacePath, `member/${assignee.id}`).catch(() => {});
      await mergeBranch(team.repoPath, team.baseBranch, `member/${assignee.id}`, team.baseBranch).catch(() => {});
      assignee.branch = `member/${assignee.id}`;
      // Push the merged base branch to the remote when one is configured.
      if (this.hasRemote) {
        const { env, cleanup } = await this.remoteEnv();
        try {
          await pushBranch(team.repoPath, team.baseBranch, { env });
        } finally {
          await cleanup();
        }
      }
    } else {
      task.status = 'changes_requested';
      task.reviewRound += 1;
      assignee.status = 'working';
    }
    task.lastActivityAt = Date.now();
    task.updatedAt = Date.now();
    team.branches = await listBranches(team.repoPath);
    this.changed(team.id);
    return { review: this.reviewView(team, review), task: this.taskView(team, task), merged };
  }

  /** Remove a merged task branch from the shared repository. */
  async pruneTaskBranch(taskId: string): Promise<void> {
    const { team, task } = this.findTask(taskId);
    if (task.status !== 'done') {
      throw new Error(`task "${task.title}" is not done; only merged task branches can be pruned`);
    }
    await deleteBranch(team.repoPath, task.branch);
    team.branches = await listBranches(team.repoPath);
    this.changed(team.id);
  }

  // ── pr_sync ──────────────────────────────────────────────────────────────

  /**
   * Push the task branch to the remote (spec §4.2 pr_sync). Pre-push guards:
   * gates green (pushRequiresGates) and no forbidden paths in the branch diff
   * (spec §4.5.3). Creates/updates a PR on github via the api token; generic
   * remotes just get the push. Also refreshes CI status once.
   */
  async prSync(input: { taskId: string }): Promise<{ pushed: boolean; prUrl: string | null; ciStatus: CiStatus }> {
    const { team, task } = this.findTask(input.taskId);
    if (!this.hasRemote) {
      throw new Error('no remote configured; pr_sync needs remote.url');
    }
    if (this.options.security.pushRequiresGates && (task.gates === null || !task.gates.allPassed)) {
      throw new Error(
        `push blocked by pushRequiresGates: gates are not green for "${task.title}" — run gates_run first`,
      );
    }
    const { env, cleanup } = await this.remoteEnv();
    try {
      await fetchRemote(team.repoPath, env);
      const baseSha = await resolveRef(team.repoPath, `origin/${team.baseBranch}`);
      const branchSha = await resolveRef(team.repoPath, task.branch);
      if (baseSha !== null && branchSha !== null) {
        const violations = await forbiddenPathViolations(
          team.repoPath,
          baseSha,
          branchSha,
          this.options.security.forbiddenPaths,
        );
        if (violations.length > 0) {
          await this.escalateTask({
            taskId: task.id,
            reason: 'forbidden-paths',
            message: `branch ${task.branch} touches human-only paths: ${violations.join(', ')}`,
            suggestion: 'remove the forbidden changes from the task branch, rebase onto base, then pr_sync again',
          });
          throw new Error(`push blocked: forbidden paths modified: ${violations.join(', ')}`);
        }
      }
      await pushBranch(team.repoPath, task.branch, { env });
    } finally {
      await cleanup();
    }
    // PR creation (github only; other platforms fall back to push-only).
    if (this.options.remote.platform === 'github') {
      task.prUrl = await this.githubUpsertPr(task).catch(() => task.prUrl);
      task.ciStatus = await this.githubCiStatus(team, task.branch).catch((): CiStatus => 'unknown');
    } else {
      task.ciStatus = 'unknown';
    }
    task.lastActivityAt = Date.now();
    task.updatedAt = Date.now();
    this.changed(team.id);
    return { pushed: true, prUrl: task.prUrl, ciStatus: task.ciStatus ?? 'unknown' };
  }

  private githubRepoSlug(): string {
    const url = this.options.remote.url;
    const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url);
    if (match === null) throw new Error(`cannot parse github owner/repo from remote url "${url}"`);
    return match[1] ?? '';
  }

  private async githubUpsertPr(task: TaskRecord): Promise<string | null> {
    const token = resolveOptionalEnvRef(this.options.remote.apiTokenEnv);
    if (token === undefined) return null;
    this.redactor.register(token);
    const fetchImpl = this.options.fetchFn ?? fetch;
    const slug = this.githubRepoSlug();
    const response = await fetchImpl(`https://api.github.com/repos/${slug}/pulls`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: `[${task.contractId ?? task.id}] ${task.title}`,
        head: task.branch,
        base: this.options.baseBranch,
        body: this.redactor.redact(task.description),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      // 422 usually means the PR already exists — keep the previous URL.
      return task.prUrl;
    }
    const body = (await response.json()) as { html_url?: string };
    return body.html_url ?? null;
  }

  private async githubCiStatus(team: TeamRecord, branch: string): Promise<CiStatus> {
    const token = resolveOptionalEnvRef(this.options.remote.apiTokenEnv);
    const fetchImpl = this.options.fetchFn ?? fetch;
    const slug = this.githubRepoSlug();
    const sha = await resolveRef(team.repoPath, branch);
    if (sha === null) return 'unknown';
    const response = await fetchImpl(`https://api.github.com/repos/${slug}/commits/${sha}/check-runs`, {
      headers: {
        accept: 'application/vnd.github+json',
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return 'unknown';
    const body = (await response.json()) as { check_runs?: { conclusion: string | null; status: string }[] };
    const runs = body.check_runs ?? [];
    if (runs.length === 0) return 'pending';
    if (runs.some((run) => run.status !== 'completed')) return 'pending';
    return runs.every((run) => run.conclusion === 'success' || run.conclusion === 'neutral' || run.conclusion === 'skipped')
      ? 'success'
      : 'failure';
  }

  // ── escalation ───────────────────────────────────────────────────────────

  /**
   * Raise an escalation (spec §4.3 trigger list): record + task note + label
   * + webhook, then pause per escalation.pauseOnEscalation.
   */
  async escalateTask(input: EscalationInput): Promise<EscalationView> {
    const record = await this.escalations.escalate(input);
    if (input.taskId !== null) {
      const found = this.tryFindTask(input.taskId);
      if (found !== null) {
        found.task.status = 'needs-human';
        found.task.updatedAt = Date.now();
        // Free the assignee so triage + redispatch can pick any developer:
        // the task branch must not stay checked out in their worktree.
        const assignee = found.team.members.find((member) => member.id === found.task.assigneeId);
        if (assignee !== undefined && assignee.currentTaskId === found.task.id) {
          await checkout(assignee.workspacePath, `member/${assignee.id}`).catch(() => {});
          assignee.branch = `member/${assignee.id}`;
          assignee.status = 'idle';
          assignee.currentTaskId = null;
        }
      }
    }
    if (this.options.escalation.pauseOnEscalation === 'team' && this.loopState === 'running') {
      this.loopState = 'escalated';
    }
    this.changed(foundTeamId(input.taskId, this.teams));
    return record;
  }

  /** Human/other-plugin triage: resolve an escalation and re-open the task. */
  async resolveEscalation(input: { escalationId: string }): Promise<void> {
    this.escalations.resolve(input.escalationId);
    const record = this.escalations.all.find((candidate) => candidate.id === input.escalationId);
    if (record?.taskId != null) {
      const found = this.tryFindTask(record.taskId);
      if (found !== null && found.task.status === 'needs-human') {
        found.task.status = 'pending';
        found.task.reviewRound = 0;
        found.task.updatedAt = Date.now();
        if (found.task.contractId !== null) {
          const contractPath = join(found.team.repoPath, '.tasks', `${found.task.contractId}.md`);
          await patchTaskContract(contractPath, { status: 'pending', owner: null }).catch(() => {});
          await this.syncBoard(found.team);
          await this.commitTasksDir(found.team, "tasks: board update");
        }
      }
    }
    if (this.loopState === 'escalated') this.loopState = 'running';
    this.changed();
  }

  // ── deploy ───────────────────────────────────────────────────────────────

  /**
   * Deploy from the base branch (spec §4.2 deploy_run): only when deploy is
   * enabled, base is green, and base moved since the last deploy. Failed
   * health checks trigger rollback + escalation inside runDeploy/here.
   */
  async deployRun(teamId?: string): Promise<DeployView> {
    const deploy = this.options.deploy;
    if (deploy?.enabled !== true) {
      throw new Error('deploy is disabled; set deploy.enabled and deploy.command in the plugin config');
    }
    if (deploy.command === undefined || deploy.command === '') {
      throw new Error('deploy.command is empty in the plugin config');
    }
    const team = teamId !== undefined ? this.teamOf(teamId) : [...this.teams.values()][0];
    if (team === undefined) throw new Error('no team yet — nothing to deploy');
    const view = await runDeploy({
      command: deploy.command,
      healthCheckUrl: deploy.healthCheckUrl,
      rollbackCommand: deploy.rollbackCommand,
      secretsEnv: deploy.secretsEnv,
      allowlist: this.options.security.commandAllowlist,
      redactor: this.redactor,
      cwd: team.repoPath,
      branch: team.baseBranch,
      ...(this.options.fetchFn !== undefined ? { fetchFn: this.options.fetchFn } : {}),
      ...(this.options.tickSleepMs !== undefined ? { backoffMs: Math.max(this.options.tickSleepMs, 10) } : {}),
    });
    this.deploys.push(view);
    if (view.status === 'healthy') {
      this.lastDeployBaseSha = await resolveRef(team.repoPath, team.baseBranch);
    } else {
      await this.escalateTask({
        taskId: null,
        reason: 'deploy-failed',
        message: `deploy ${view.id} ended ${view.status}`,
        suggestion: 'inspect the deploy log tail, fix the root cause, then re-run deploy_run',
        logTail: view.logTail,
      });
    }
    this.changed(team.id);
    return view;
  }

  // ── daemon loop ──────────────────────────────────────────────────────────

  getLoopState(): LoopState {
    return this.loopState;
  }

  /**
   * Start the unattended loop (autopilot_run). Idempotent: repeated calls
   * while running just return the current state.
   */
  async startLoop(): Promise<{ loopState: LoopState; tick: number }> {
    if (this.loopPromise !== null && (this.loopState === 'running' || this.loopState === 'paused')) {
      return { loopState: this.loopState, tick: this.tick };
    }
    this.abortController = new AbortController();
    this.loopState = 'running';
    this.changed();
    const signal = this.abortController.signal;
    this.loopPromise = this.runLoop(signal).finally(() => {
      this.loopPromise = null;
    });
    return { loopState: this.loopState, tick: this.tick };
  }

  /** Pause the loop (autopilot_pause) — humans or other plugins step in. */
  pauseLoop(): LoopState {
    if (this.loopState === 'running') {
      this.loopState = 'paused';
      this.changed();
    }
    return this.loopState;
  }

  /** Resume a paused/escalated loop (autopilot_resume). */
  resumeLoop(): LoopState {
    if (this.loopState === 'paused' || this.loopState === 'escalated') {
      this.loopState = 'running';
      this.changed();
    }
    return this.loopState;
  }

  /** Stop the loop and wait for the current tick to land safely. */
  async stopLoop(): Promise<void> {
    if (this.abortController !== null) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.loopPromise !== null) {
      await this.loopPromise.catch(() => {});
    }
    if (this.loopState === 'running' || this.loopState === 'paused') {
      this.loopState = 'stopped';
    }
  }

  private sleepMs(): number {
    return this.options.tickSleepMs ?? this.options.daemon.pollIntervalSeconds * 1000;
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let idleTicks = 0;
    while (!signal.aborted) {
      if (this.loopState === 'paused' || this.loopState === 'escalated' || this.loopState === 'completed') {
        await this.writeHeartbeat();
        await interruptibleSleep(this.sleepMs(), signal);
        continue;
      }
      try {
        const report = await this.tickOnce(signal);
        idleTicks = report.events.length === 0 ? idleTicks + 1 : 0;
      } catch (error) {
        if (signal.aborted) break;
        await this.escalateTask({
          taskId: null,
          reason: 'manual',
          message: `run loop tick failed: ${error instanceof Error ? error.message : String(error)}`,
          suggestion: 'inspect the autopilot state and recent git activity; resume with autopilot_resume',
        });
      }
      // Idle backoff: after 5 quiet ticks poll at 4x the interval (max).
      const factor = Math.min(1 + Math.floor(idleTicks / 5), 4);
      await this.writeHeartbeat();
      await interruptibleSleep(this.sleepMs() * factor, signal);
    }
    await this.writeHeartbeat();
  }

  private async writeHeartbeat(): Promise<void> {
    const heartbeat: HeartbeatView = { at: Date.now(), loopState: this.loopState, tick: this.tick };
    await writeFile(this.heartbeatFile, `${JSON.stringify(heartbeat)}\n`, 'utf8').catch(() => {});
  }

  /**
   * One pass of the unattended loop (spec §4.3). Public so tests can drive
   * the loop deterministically without timing.
   */
  async tickOnce(signal?: AbortSignal): Promise<TickReport> {
    this.tick += 1;
    const report: TickReport = {
      tick: this.tick,
      events: [],
      recovered: [],
      dispatched: [],
      escalated: [],
      deployed: null,
      completed: false,
    };
    // 1. Recovery: tasks left in_progress by a crashed run become resumable.
    if (!this.recoveredOnce) {
      this.recoveredOnce = true;
      for (const team of this.teams.values()) {
        for (const task of team.tasks) {
          if (task.status === 'in_progress') {
            report.recovered.push(task.id);
            report.events.push(`recovered:${task.id}`);
          }
        }
      }
    }
    for (const team of this.teams.values()) {
      if (signal?.aborted === true) break;
      await this.syncContracts(team, report);
      await this.dispatch(team, report, signal);
      await this.checkReviewRounds(team, report);
      await this.checkStuck(team, report);
      await this.maybeDeploy(team, report);
      this.checkCompletion(team, report);
    }
    this.changed();
    return report;
  }

  /** Pull task contracts from the repo onto the board; triage needs-human. */
  private async syncContracts(team: TeamRecord, report: TickReport): Promise<void> {
    const contracts = await loadTaskContracts(team.repoPath).catch(() => [] as TaskContract[]);
    for (const contract of contracts) {
      const existing = team.tasks.find((task) => task.contractId === contract.id);
      if (existing === undefined) {
        // A contract nobody assigned yet — keep it pending on the board with
        // the leader as nominal owner until dispatch picks it up.
        const leader = team.members.find((member) => member.role === 'leader');
        if (leader === undefined) continue;
        if (contract.status !== 'pending') continue;
        team.tasks.push({
          id: shortId('task'),
          contractId: contract.id,
          title: contract.title,
          description: contract.body.slice(0, 2000),
          assigneeId: leader.id,
          status: 'pending',
          branch: `task/${contract.id}`,
          reviewRound: 0,
          dependsOn: contract.dependsOn,
          touches: contract.touches,
          gates: null,
          prUrl: null,
          ciStatus: null,
          lastActivityAt: Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        report.events.push(`contract:${contract.id}`);
      } else if (existing.status === 'needs-human' && contract.status !== 'needs-human') {
        // Human triaged the contract file directly → re-open the task.
        existing.status = 'pending';
        existing.reviewRound = 0;
        existing.updatedAt = Date.now();
        for (const escalation of this.escalations.open) {
          if (escalation.taskId === existing.id || escalation.taskId === existing.contractId) {
            this.escalations.resolve(escalation.id);
          }
        }
        if (this.loopState === 'escalated') this.loopState = 'running';
        report.events.push(`triaged:${existing.id}`);
      }
    }
  }

  /** Dispatch pending tasks (deps done, domain lock free) to idle developers. */
  private async dispatch(team: TeamRecord, report: TickReport, signal?: AbortSignal): Promise<void> {
    const doneContracts = new Set(
      team.tasks.filter((task) => task.status === 'done').map((task) => task.contractId ?? task.id),
    );
    const lockedTouches = team.tasks
      .filter((task) => task.status === 'in_progress' || task.status === 'in_review')
      .flatMap((task) => task.touches);
    for (const task of team.tasks) {
      if (signal?.aborted === true) return;
      if (task.status !== 'pending') continue;
      if (!task.dependsOn.every((dep) => doneContracts.has(dep))) continue;
      if (task.touches.length > 0 && touchesOverlap(task.touches, lockedTouches)) continue;
      const developer = team.members.find(
        (member) => member.role === 'developer' && member.status === 'idle' && member.currentTaskId === null,
      );
      if (developer === undefined) return; // no free developer: try again next tick
      // (Re)assign: the placeholder task created by syncContracts gets a real
      // assignee, branch and workspace checkout.
      if (task.assigneeId !== developer.id) {
        task.assigneeId = developer.id;
      }
      const branches = await listBranches(team.repoPath);
      if (!branches.includes(task.branch)) {
        await createBranch(team.repoPath, task.branch, team.baseBranch);
      }
      await checkout(developer.workspacePath, task.branch);
      developer.branch = task.branch;
      developer.status = 'working';
      developer.currentTaskId = task.id;
      task.status = 'in_progress';
      task.lastActivityAt = Date.now();
      task.updatedAt = Date.now();
      if (task.contractId !== null) {
        const contractPath = join(team.repoPath, '.tasks', `${task.contractId}.md`);
        await patchTaskContract(contractPath, { status: 'in_progress', owner: developer.name }).catch(() => {});
        await this.syncBoard(team);
        await this.commitTasksDir(team, "tasks: board update");
      }
      lockedTouches.push(...task.touches);
      report.dispatched.push(task.id);
      report.events.push(`dispatched:${task.id}`);
    }
  }

  /** Escalate tasks that exhausted their review rounds. */
  private async checkReviewRounds(team: TeamRecord, report: TickReport): Promise<void> {
    for (const task of team.tasks) {
      if (task.status === 'changes_requested' && task.reviewRound >= this.options.daemon.maxReviewRounds) {
        report.escalated.push(task.id);
        report.events.push(`review-rounds:${task.id}`);
        await this.escalateTask({
          taskId: task.id,
          reason: 'review-rounds-exceeded',
          message: `task "${task.title}" was sent back ${task.reviewRound} times (limit ${this.options.daemon.maxReviewRounds})`,
          suggestion: 're-scope or re-split the task contract, then move it back to pending',
        });
      }
    }
  }

  /** Escalate in-progress tasks with no git activity for stuckMinutes. */
  private async checkStuck(team: TeamRecord, report: TickReport): Promise<void> {
    const stuckMs = this.options.daemon.stuckMinutes * 60_000;
    for (const task of team.tasks) {
      if (task.status !== 'in_progress') continue;
      // Git activity refreshes lastActivityAt: new commits on the task branch.
      const lastCommit = await lastCommitAt(team.repoPath, task.branch).catch(() => null);
      if (lastCommit !== null && lastCommit > task.lastActivityAt) {
        task.lastActivityAt = lastCommit;
      }
      if (Date.now() - task.lastActivityAt > stuckMs) {
        report.escalated.push(task.id);
        report.events.push(`stuck:${task.id}`);
        await this.escalateTask({
          taskId: task.id,
          reason: 'task-stuck',
          message: `task "${task.title}" had no git activity for ${this.options.daemon.stuckMinutes} minutes`,
          suggestion: 'check the assignee workspace, unblock or re-assign the task, then move it back to pending',
        });
      }
    }
  }

  /** Deploy when base moved and gates/CI allow it. */
  private async maybeDeploy(team: TeamRecord, report: TickReport): Promise<void> {
    const deploy = this.options.deploy;
    if (deploy?.enabled !== true || deploy.command === undefined || deploy.command === '') return;
    const baseSha = await resolveRef(team.repoPath, team.baseBranch).catch(() => null);
    if (baseSha === null || baseSha === this.lastDeployBaseSha) return;
    if (this.options.gates.requireCiGreen && this.hasRemote) {
      const ci = await this.githubCiStatus(team, team.baseBranch).catch(() => 'unknown' as CiStatus);
      if (ci !== 'success') return;
    }
    const view = await this.deployRun(team.id);
    report.deployed = view.id;
    report.events.push(`deploy:${view.id}:${view.status}`);
  }

  /** All tasks done → completion report + stop. */
  private checkCompletion(team: TeamRecord, report: TickReport): void {
    if (team.tasks.length === 0) return;
    const allDone = team.tasks.every((task) => task.status === 'done');
    if (!allDone) return;
    report.completed = true;
    report.events.push('completed');
    this.loopState = 'completed';
    const summary = [
      `# Autopilot completion report`,
      ``,
      `team: ${team.name} (${team.id})`,
      `finished at: ${new Date().toISOString()}`,
      ``,
      `## tasks`,
      ...team.tasks.map((task) => `- ${task.contractId ?? task.id} ${task.title} — ${task.status}`),
      ``,
      `## deploys`,
      ...(this.deploys.length === 0
        ? ['- (none)']
        : this.deploys.map((deploy) => `- ${deploy.id} ${deploy.status} at ${new Date(deploy.startedAt).toISOString()}`)),
      ``,
    ].join('\n');
    void (async () => {
      await writeFile(join(team.repoPath, '.tasks', '_completion.md'), summary, 'utf8').catch(() => {});
      await this.commitTasksDir(team, 'tasks: completion report');
    })();
  }

  /** Git-activity probe for tools: new commits of a task branch vs base. */
  async taskActivity(taskId: string): Promise<{ newCommits: number; lastCommitAt: number | null }> {
    const { team, task } = this.findTask(taskId);
    const baseSha = await resolveRef(team.repoPath, team.baseBranch);
    const newCommits = baseSha === null ? 0 : await countNewCommits(team.repoPath, task.branch, baseSha);
    const lastCommit = await lastCommitAt(team.repoPath, task.branch);
    return { newCommits, lastCommitAt: lastCommit };
  }

  /** autopilot_status: loop, board, workspace health, heartbeat, blockers. */
  async status(): Promise<Record<string, unknown>> {
    const teams = [...this.teams.keys()].map((id) => this.teamView(id));
    const workspaces: Record<string, unknown>[] = [];
    for (const team of this.teams.values()) {
      for (const member of team.members) {
        const healthy = await resolveRef(member.workspacePath, 'HEAD').then((sha) => sha !== null).catch(() => false);
        workspaces.push({
          memberId: member.id,
          memberName: member.name,
          path: member.workspacePath,
          branch: member.branch,
          healthy,
        });
      }
    }
    let heartbeat: HeartbeatView | null = null;
    try {
      heartbeat = JSON.parse(await readFile(this.heartbeatFile, 'utf8')) as HeartbeatView;
    } catch {
      heartbeat = null;
    }
    return {
      loopState: this.loopState,
      tick: this.tick,
      bootstrapped: this.bootstrapped,
      teams,
      workspaces,
      heartbeat,
      blocked: this.projection().blocked,
      escalations: [...this.escalations.all],
      deploys: this.deploys,
    };
  }
}

function foundTeamId(taskId: string | null, teams: Map<string, TeamRecord>): string | undefined {
  if (taskId === null) return undefined;
  for (const team of teams.values()) {
    if (team.tasks.some((task) => task.id === taskId || task.contractId === taskId)) return team.id;
  }
  return undefined;
}

function requireBranch(branch: string | undefined): string {
  if (branch === undefined || branch === '') throw new Error('the "branch" parameter is required for this action');
  return branch;
}

function requireMember(memberId: string | undefined): string {
  if (memberId === undefined || memberId === '') {
    throw new Error('the "memberId" parameter is required for this action');
  }
  return memberId;
}

function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolvePromise();
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
