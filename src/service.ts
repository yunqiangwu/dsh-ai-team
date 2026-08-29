/**
 * AutopilotService —— dsh-ai-team 的中枢。
 *
 * 协作模型（共享仓库上按成员隔离的 git worktree、leader → developer 任务板、
 * 由 reviewer 把关的合并）只是底座；叠加在它之上的是无人值守运行所需的一切：
 * 远端 clone/push、裸机引导、客观质量门、带崩溃恢复的守护循环、升级与部署。
 *
 * 本服务刻意与运行时无关：它从不接触 cordis 与会话日志，因此集成测试可以
 * 直接驱动它。插件入口（index.ts）把它提供为 `autopilot` 服务，工具层
 * （tools.ts）负责把状态变更翻译成会话事件。
 *
 * 状态落到 <stateDir>/state.json（防抖写入），每个循环 tick 再写一次心跳文件；
 * dispose() 做最终 flush。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  addWorktree,
  checkout,
  changedFiles,
  cloneRemote,
  commitAll,
  countNewCommits,
  createBranch,
  deleteBranch,
  ensureRepo,
  fetchRemote,
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
import { linkSharedCacheDirs } from './cache.js';
import { runGates } from './gates.js';
import { runDeploy } from './deploy.js';
import { checkRunStatus, githubRepoSlug, upsertPullRequest } from './github.js';
import { EscalationManager, type EscalationInput } from './escalate.js';
import { Mailer, TicketServer, type TicketStore } from './notification.js';
import {
  classifyForbiddenFiles,
  distinctDomainCount,
  effectiveForbiddenRules,
  enrichDescriptionWithOwnership,
  ownerRoleForTouches,
  renderBranchName,
  renderPrBody,
  renderPrTitle,
  selectGateCommands,
  type ProjectProfile,
} from './profile.js';
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

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 状态落盘的防抖窗口（毫秒）：一次 tick 内的多次变更合并成一次写。 */
const PERSIST_DEBOUNCE_MS = 100;

/** 契约正文写入任务描述时的最大长度，避免超长契约撑爆提示词。 */
const CONTRACT_BODY_LIMIT = 2000;

/** 仓库内任务契约目录。 */
const TASKS_DIR = '.tasks';

/** 全部任务完成后的完成报告文件名。 */
const COMPLETION_FILE = '_completion.md';

/** 连续空闲多少个 tick 后开始放大轮询间隔。 */
const IDLE_BACKOFF_TICKS = 5;

/** 空闲退避的最大倍数：最多把轮询间隔放大到 4 倍。 */
const MAX_IDLE_BACKOFF_FACTOR = 4;

/** 生成短 id（team_xxxxxxxx / task_xxxxxxxx / m_xxxxxxxx / rev_xxxxxxxx）。 */
const shortId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

/** 成员的个人分支名：任务之外成员默认停留在这里。 */
const memberBranch = (memberId: string) => `member/${memberId}`;

// ── 运行时选项（Config 校验之后） ───────────────────────────────────────────

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
    /** 原生模块编译所需的系统包（如 node-gyp 用的 python3/make/g++）。 */
    systemPackages?: string[] | undefined;
    /** 包管理器命令（受白名单约束），例如 `sudo apt-get install -y`。 */
    packageManagerCommand?: string | undefined;
    /** 要从提交在仓库里的示例文件生成的 `.env` 路径（缺关键项时报错）。 */
    envFile?: string | undefined;
    /** 仓库中已提交的 `.env.example` 路径。 */
    envExample?: string | undefined;
    /** 启动时必需的环境变量名；缺失即响亮失败。 */
    requiredEnvKeys?: string[] | undefined;
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
    /** SMTP 传输配置。 */
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      userEnv: string;
      passEnv: string;
      fromEnv?: string | undefined;
      startTls?: boolean | undefined;
    };
    /** 人工通知邮件的收件人（逗号/空格分隔多个）。 */
    mailTo: string;
    /** 本地工单端点监听地址。 */
    ticket: {
      host: string;
      port: number;
      /** 邮件里展示给人的访问基址（例如 http://server:8080）。 */
      publicBaseUrl: string;
    };
    /**
     * 自动恢复：工单被答复后直接回写答案并清除升级（任务回到 pending），
     * 无需再等一次 escalation_resolve。
     */
    autoResume: boolean;
    /** "From" 头的环境变量名；缺省回落到 smtp.fromEnv。 */
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
  /**
   * 项目画像适配器：目标仓库的协作约定（分支/PR 命名、合并策略、条件质量门、
   * 禁区策略、所有权路由）。默认画像完全复刻插件的历史行为，项目预设
   * （如 AgentDeploy）只需覆盖有差异的字段。
   */
  profile: ProjectProfile;
  /**
   * 可选的构建缓存共享：把被 gitignore 的构建/测试缓存目录软链到按分支共享的
   * 位置，让相邻任务复用上一次产物而不是从头构建。尽力而为，默认关闭。
   */
  buildCache?: { enabled: boolean; dirs: string[] } | undefined;
  /** 测试钩子：缩短循环中的 sleep/退避时长。 */
  tickSleepMs?: number | undefined;
  /** 测试钩子：注入 fetch，用于 webhook / CI / 健康检查调用。 */
  fetchFn?: typeof fetch | undefined;
}

// ── 内部记录 ────────────────────────────────────────────────────────────────

interface MemberRecord {
  id: string;
  name: string;
  role: Role;
  systemPrompt: string;
  workspacePath: string;
  branch: string;
  status: MemberStatus;
  currentTaskId: string | null;
  /** 可选的领域专精（与所有权规则的 role 匹配）。 */
  specialization?: string | undefined;
}

interface TaskRecord {
  id: string;
  contractId: string | null;
  /**
   * 契约文件的真实路径。老版本持久化数据里没有这个字段，读取时回退到
   * `.tasks/<contractId>.md`（见 contractPathFor）。
   */
  contractPath?: string | undefined;
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

// ── 服务主体 ────────────────────────────────────────────────────────────────

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
          if (found !== null && found.task.contractId !== null) {
            await appendTaskNote(this.contractPathFor(found.team, found.task), note);
            await this.commitTasksDir(found.team, `tasks: note on ${found.task.contractId}`);
          }
        },
        labelTask: async (taskId) => {
          const found = this.tryFindTask(taskId);
          if (found !== null && found.task.contractId !== null) {
            await patchTaskContract(this.contractPathFor(found.team, found.task), { status: 'needs-human' });
            await this.commitTasksDir(found.team, `tasks: ${found.task.contractId} needs-human`);
          }
        },
      },
      notify: (record) => this.notifyEscalation(record),
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    });
    // 提前把所有以环境变量引用的密钥登记进脱敏器，之后任何输出都不会漏出明文。
    this.redactor.registerEnvNames([
      options.remote.sshKeyEnv,
      options.remote.apiTokenEnv,
      options.escalation.webhookUrlEnv,
      ...(options.deploy?.secretsEnv ?? []),
    ]);
    this.initNotification();
  }

  // ── 人工通知回路 ──────────────────────────────────────────────────────────

  /**
   * 接通人工通知回路（SMTP 邮件 + 本地工单端点）。
   * 尽力而为：配置有问题绝不能拖垮守护进程，只会在升级记录上记一次发送失败。
   */
  private initNotification(): void {
    const config = this.options.notification;
    if (config?.enabled !== true) return;
    try {
      this.notificationMailer = Mailer.create({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        startTls: config.smtp.startTls,
        userEnv: config.smtp.userEnv,
        passEnv: config.smtp.passEnv,
        fromEnv: config.smtp.fromEnv ?? config.fromEnv,
        redactor: this.redactor,
      });
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

  /** 工单数据源直接读活的升级记录（按 id 查找）。 */
  private ticketStore(): TicketStore {
    return {
      renderTicket: async (id) => {
        const record = this.escalationById(id);
        if (record === undefined) return null;
        return {
          title: `人工确认：${this.escalationSubject(record)}`,
          fields: [
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
          ],
        };
      },
      handleSubmit: (id, answers) => this.submitTicketAnswer(id, answers),
    };
  }

  /**
   * 把工单答复应用到一条存活的升级记录上。
   * 这是 TicketServer 持有的回调：回写答案，并在开启 autoResume 时清除升级、
   * 恢复循环。设为 public 是为了让工具层和测试能走完全相同的路径。
   */
  async submitTicketAnswer(
    escalationId: string,
    answers: Record<string, string>,
  ): Promise<{ ok: boolean; message?: string }> {
    const record = this.escalationById(escalationId);
    if (record === undefined) return { ok: false, message: 'ticket not found' };
    const answer = answers.decision ?? answers.note ?? '';
    if (answer.trim() === '') return { ok: false, message: 'decision is required' };
    record.notification = {
      ...(record.notification ?? emptyNotification()),
      submitted: this.redactAnswers(answers),
      submittedAt: Date.now(),
    };
    // 应用人工决策：写入任务备注；开启 autoResume 时直接清除升级并重开任务，
    // 不必再等一次 escalation_resolve。
    await this.applyHumanDecision(record, answer);
    record.notification.autoResumed = this.options.notification?.autoResume === true;
    this.changed();
    return { ok: true };
  }

  /**
   * 人答复了工单：把决策写进任务备注；开启 autoResume 时把循环恢复为
   * running、任务退回 pending。
   */
  private async applyHumanDecision(record: EscalationView, answer: string): Promise<void> {
    const found = record.taskId === null ? null : this.tryFindTask(record.taskId);
    if (found !== null && found.task.contractId !== null) {
      const note = [
        '',
        `> [human]: ${new Date().toISOString()} decision recorded`,
        `> ${this.redactor.redact(answer)}`,
        '',
      ].join('\n');
      await appendTaskNote(this.contractPathFor(found.team, found.task), note).catch(() => {});
      await this.commitTasksDir(found.team, `tasks: human decision on ${found.task.contractId}`);
    }
    if (this.options.notification?.autoResume !== true) return;
    this.escalations.resolve(record.id);
    if (found !== null && found.task.status === 'needs-human') {
      await this.reopenTask(found.team, found.task);
    }
    if (this.loopState === 'escalated') this.loopState = 'running';
  }

  /**
   * EscalationManager 记录升级后回调的通知钩子：拼出工单链接、渲染并发送邮件。
   * 尽力而为——只返回通知状态（disabled / sent / failed），绝不抛异常。
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
    // 没有邮件器就只有工单链接：把 mail 标记为未送达，面板上要能一眼看出
    // 人其实没被触达。
    if (this.notificationMailer === null) {
      return { ...initial, status: 'failed', error: 'notification: mailer disabled' };
    }
    const subject = this.escalationSubject(record);
    const text = [
      `[dsh-ai-team] 需要你的人工确认`,
      ``,
      `任务: ${subject}`,
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
      await this.notificationMailer.send({ to: config.mailTo, subject: `[dsh-ai-team] 人工确认: ${subject}`, text });
      return { ...initial, mailDelivered: true, status: 'sent' };
    } catch (error) {
      return {
        ...initial,
        status: 'failed',
        error: `${this.redactor.redact(error instanceof Error ? error.message : String(error))}`,
      };
    }
  }

  private escalationById(escalationId: string): EscalationView | undefined {
    return this.escalations.all.find((candidate) => candidate.id === escalationId);
  }

  /** 升级事件的展示主体：有任务就用任务标题，否则是部署/全局事件。 */
  private escalationSubject(record: EscalationView): string {
    if (record.taskId === null) return 'deploy / global';
    return this.taskTitleFor(record.taskId) ?? record.taskId;
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  /** 创建服务并加载已持久化的状态（崩溃恢复）。 */
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

  /** 停止服务：flush 未落盘的状态并停掉循环。用 ctx.effect() 注册。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stopLoop();
    if (this.notificationServer !== null) {
      await this.notificationServer.close().catch(() => {});
      this.notificationServer = null;
    }
    this.notificationMailer = null;
    // 取消待触发的防抖写，改为立刻落盘一次，保证退出前状态完整。
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.flush();
    this.listeners.clear();
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────

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
      return; // 首次运行，没有历史状态
    }
    try {
      const state = JSON.parse(raw) as PersistedState;
      for (const team of state.teams ?? []) this.teams.set(team.id, team);
      this.activeTeamId = state.activeTeamId ?? null;
      this.escalations.restore(state.escalations ?? []);
      this.deploys = state.deploys ?? [];
      // 崩崩恢复的硬规则：持久化的 running 一律降级为 paused，等人来 resume。
      this.loopState = state.loopState === 'running' ? 'paused' : (state.loopState ?? 'stopped');
      this.tick = state.tick ?? 0;
      this.bootstrapped = state.bootstrapped ?? false;
      this.lastDeployBaseSha = state.lastDeployBaseSha ?? null;
      for (const team of this.teams.values()) {
        team.branches = await listBranches(team.repoPath).catch(() => team.branches);
      }
    } catch {
      // 状态文件损坏：宁可空着启动，也不能把宿主进程带崩。
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

  /** 立即把当前状态写入 state.json（失败静默：退出路径不该抛）。 */
  private async flush(): Promise<void> {
    await writeFile(this.stateFile, `${JSON.stringify(this.snapshot(), null, 2)}\n`, 'utf8').catch(() => {});
  }

  /** 防抖落盘：一次 tick 内的多次变更合并成一次写。 */
  private persist(): void {
    if (this.disposed) return;
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, PERSIST_DEBOUNCE_MS);
  }

  // ── 变更通知 ──────────────────────────────────────────────────────────────

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(teamId?: string): void {
    if (teamId !== undefined) this.activeTeamId = teamId;
    this.persist();
    for (const listener of this.listeners) listener();
  }

  // ── 视图 ──────────────────────────────────────────────────────────────────

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

  /** 全量状态投影快照——推给 Web 面板的值。 */
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

  // ── 查找 ──────────────────────────────────────────────────────────────────

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

  /** 按 id 或 contractId 查找任务；找不到返回 null 而不是抛错。 */
  private tryFindTask(taskId: string): { team: TeamRecord; task: TaskRecord } | null {
    for (const team of this.teams.values()) {
      const task = team.tasks.find((candidate) => candidate.id === taskId || candidate.contractId === taskId);
      if (task !== undefined) return { team, task };
    }
    return null;
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

  // ── 仓库辅助 ──────────────────────────────────────────────────────────────

  private get hasRemote(): boolean {
    return this.options.remote.url !== '';
  }

  /** 构造远端 git 操作的认证环境；本地仓库或无 SSH 远端时返回空环境。 */
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

  /** 用远端凭据推送分支，并保证临时 SSH key 一定被清理。 */
  private async pushWithRemoteEnv(team: TeamRecord, branch: string): Promise<void> {
    const { env, cleanup } = await this.remoteEnv();
    try {
      await pushBranch(team.repoPath, branch, { env });
    } finally {
      await cleanup();
    }
  }

  /** 刷新团队缓存的分支列表。 */
  private async refreshBranches(team: TeamRecord): Promise<void> {
    team.branches = await listBranches(team.repoPath);
  }

  /** 刷新任务的活动时间戳（卡死检测依赖它）。 */
  private touchTask(task: TaskRecord): void {
    task.lastActivityAt = Date.now();
    task.updatedAt = Date.now();
  }

  /**
   * 任务契约文件的路径。优先用建任务时记下的真实路径；老版本持久化数据没有
   * 该字段，回退到 `.tasks/<contractId>.md`。
   */
  private contractPathFor(team: TeamRecord, task: TaskRecord): string {
    return task.contractPath ?? join(team.repoPath, TASKS_DIR, `${task.contractId ?? task.id}.md`);
  }

  /** 重新生成 .tasks/_board.md（best effort）。 */
  private async syncBoard(team: TeamRecord): Promise<void> {
    const contracts = await loadTaskContracts(team.repoPath).catch(() => null);
    if (contracts !== null) await regenerateBoard(team.repoPath, contracts).catch(() => {});
  }

  /**
   * 提交 .tasks/ 的改动，让集成检出始终保持干净、可合并
   * （best effort：没有 .tasks 目录时是空操作）。
   */
  private async commitTasksDir(team: TeamRecord, message: string): Promise<void> {
    await commitAll(team.repoPath, TASKS_DIR, message).catch(() => {});
  }

  /**
   * 回写任务契约的状态，并同步看板、提交 .tasks/。
   *
   * `owner` 省略时不动契约里的 owner 字段（任务完成不该把 owner 抹掉）；
   * 显式传 null 才会把 owner 行删掉（任务退回待派发时这么做）。
   * 全部 best effort：契约文件缺失或提交失败都不该打断主流程。
   */
  private async updateContractStatus(
    team: TeamRecord,
    task: TaskRecord,
    status: TaskStatus,
    owner?: string | null,
  ): Promise<void> {
    if (task.contractId === null) return;
    const patch: { status: TaskStatus; owner?: string | null } = { status };
    if (owner !== undefined) patch.owner = owner;
    await patchTaskContract(this.contractPathFor(team, task), patch).catch(() => {});
    await this.syncBoard(team);
    await this.commitTasksDir(team, 'tasks: board update');
  }

  /** 重开任务：回到 pending、清零返工轮次并清空 owner，让循环可以重新派发。 */
  private async reopenTask(team: TeamRecord, task: TaskRecord): Promise<void> {
    task.status = 'pending';
    task.reviewRound = 0;
    task.updatedAt = Date.now();
    await this.updateContractStatus(team, task, 'pending', null);
  }

  /**
   * 让成员脱离任务分支、回到自己的个人分支并标记空闲。
   * 传入 team 时额外把基础分支的最新进展合并回个人分支（评审通过后走这条路），
   * 保证下一个任务从最新的基础分支开工；合并冲突静默忽略。
   */
  private async releaseMemberWorkspace(member: MemberRecord, team?: TeamRecord): Promise<void> {
    const branch = memberBranch(member.id);
    await checkout(member.workspacePath, branch).catch(() => {});
    if (team !== undefined) {
      await mergeBranch(team.repoPath, team.baseBranch, branch, team.baseBranch).catch(() => {});
    }
    member.branch = branch;
    member.status = 'idle';
    member.currentTaskId = null;
  }

  // ── 引导（autopilot_init） ────────────────────────────────────────────────

  /**
   * 无人值守引导：把远端克隆到新团队的仓库位置，rootless 补齐工具链，
   * 依次运行 setupCommand 与 verifyCommand。失败时带上引导报告升级。
   */
  async initAutopilot(teamName = 'autopilot'): Promise<{ teamId: string; report: BootstrapReport | null }> {
    if (!this.options.bootstrap.enabled && !this.hasRemote) {
      throw new Error('nothing to initialize: bootstrap.disabled and no remote.url configured');
    }
    // 重复 init 要幂等：已有团队就直接复用。
    let team = [...this.teams.values()][0];
    if (team === undefined) {
      const view = await this.createTeam({ name: teamName, members: [{ role: 'leader' }], cloneRemote: this.hasRemote });
      team = this.teamOf(view.id);
    } else if (this.hasRemote && !(await this.isCloneOfRemote(team.repoPath))) {
      await this.adoptRemote(team);
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
        systemPackages: this.options.bootstrap.systemPackages ?? [],
        packageManagerCommand: this.options.bootstrap.packageManagerCommand,
        envFile: this.options.bootstrap.envFile ? join(team.repoPath, this.options.bootstrap.envFile) : undefined,
        envExample: this.options.bootstrap.envExample,
        requiredEnvKeys: this.options.bootstrap.requiredEnvKeys ?? [],
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

  /**
   * 团队早于远端配置而存在时，把远端接管过来。
   * 只有本地仓库仍然干净（除初始提交外什么都没有）才自动重建；否则把冲突
   * 明确抛出来，而不是让两份历史悄悄分叉。
   */
  private async adoptRemote(team: TeamRecord): Promise<void> {
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
    // 用新克隆重建 leader 的 worktree。
    const leader = team.members[0];
    if (leader === undefined) return;
    await rm(leader.workspacePath, { recursive: true, force: true });
    await addWorktree(team.repoPath, leader.workspacePath, leader.branch, team.baseBranch).catch(async () => {
      await deleteBranch(team.repoPath, leader.branch).catch(() => {});
      await addWorktree(team.repoPath, leader.workspacePath, leader.branch, team.baseBranch);
    });
  }

  private async isCloneOfRemote(repoPath: string): Promise<boolean> {
    try {
      const url = await git(['remote', 'get-url', 'origin'], repoPath);
      return url === this.options.remote.url;
    } catch {
      return false;
    }
  }

  // ── 团队与成员 ────────────────────────────────────────────────────────────

  async createTeam(input: {
    name: string;
    members?: { role: Role; name?: string; specialization?: string }[];
    /** 内部用：克隆配置好的远端，而不是本地 init。 */
    cloneRemote?: boolean;
  }): Promise<TeamView> {
    const id = shortId('team');
    const repoPath = join(this.options.rootDir, id, 'repo');
    const workspaceRoot = join(this.options.rootDir, id, 'workspaces');
    const requested = input.members ?? [{ role: 'leader' as const }];
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
    // 先入册再逐个加成员：addMember 依赖 team 已经在表里。
    this.teams.set(id, team);
    if (requested.filter((member) => member.role === 'leader').length !== 1) {
      this.teams.delete(id);
      throw new Error('a team needs exactly one leader member');
    }
    for (const member of requested) {
      await this.addMember({
        teamId: id,
        role: member.role,
        ...(member.name !== undefined ? { name: member.name } : {}),
        ...(member.specialization !== undefined ? { specialization: member.specialization } : {}),
      });
    }
    return this.teamView(id);
  }

  async addMember(input: { teamId: string; role: Role; name?: string; specialization?: string }): Promise<MemberView> {
    const team = this.teamOf(input.teamId);
    if (!isRole(input.role)) {
      throw new Error(`invalid role "${input.role}"; expected leader, developer, reviewer or operator`);
    }
    if (team.members.length >= this.options.maxMembers) {
      throw new Error(`team "${team.name}" already has the maximum of ${this.options.maxMembers} members`);
    }
    if (input.role === 'leader' && team.members.some((member) => member.role === 'leader')) {
      throw new Error(`team "${team.name}" already has a leader`);
    }
    const id = shortId('m');
    const role = input.role;
    const index = team.members.filter((member) => member.role === role).length + 1;
    const name = input.name ?? defaultMemberName(role, index);
    const branch = memberBranch(id);
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
      ...(input.specialization !== undefined ? { specialization: input.specialization } : {}),
    };
    team.members.push(member);
    await this.refreshBranches(team);
    this.changed(team.id);
    return this.memberView(member);
  }

  // ── 任务看板 ──────────────────────────────────────────────────────────────

  /**
   * 派发任务（leader 或守护循环的 dispatcher）：从 base 建任务分支，
   * 在接手者的工作区里检出。给定 contractId 时，契约文件必须存在于仓库的
   * .tasks/ 且状态为 pending（规范 §4.4）。
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
    const destination = contract?.id ?? id;
    const domainCount = distinctDomainCount(contract?.touches ?? []);
    const threshold = this.options.profile.crossDomainThreshold;
    if (domainCount > threshold) {
      throw new Error(
        `task "${input.title}" touches ${domainCount} distinct domains (limit ${threshold}); ` +
          `split it into per-domain tasks or escalate for a cross-domain change`,
      );
    }
    const branch = renderBranchName(this.options.profile.branchTemplate, destination, contract?.title ?? input.title);
    await createBranch(team.repoPath, branch, team.baseBranch);
    await checkout(assignee.workspacePath, branch);
    const now = Date.now();
    const rawDescription = input.description ?? contract?.body.slice(0, CONTRACT_BODY_LIMIT) ?? '';
    const task: TaskRecord = {
      id,
      contractId: contract?.id ?? null,
      contractPath: contract?.path,
      title: contract?.title ?? input.title,
      description: enrichDescriptionWithOwnership(rawDescription, contract?.touches ?? [], this.options.profile.ownership),
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
      await this.updateContractStatus(team, task, 'in_progress', assignee.name);
      task.status = 'in_progress';
    }
    await this.refreshBranches(team);
    this.changed(team.id);
    return this.taskView(team, task);
  }

  private async requireContract(team: TeamRecord, contractId: string): Promise<TaskContract> {
    const contracts = await loadTaskContracts(team.repoPath);
    const contract = contracts.find((candidate) => candidate.id === contractId);
    if (contract === undefined) {
      throw new Error(
        `no task contract "${contractId}" in ${join(team.repoPath, TASKS_DIR)}; known: ${contracts.map((c) => c.id).join(', ') || '(none)'}`,
      );
    }
    return contract;
  }

  /**
   * 手动推进任务状态。只允许在 pending / in_progress / in_review 之间切换：
   * done 与 changes_requested 归评审流程所有，needs-human 归升级流程所有。
   */
  async updateTask(input: { taskId: string; status: 'pending' | 'in_progress' | 'in_review' }): Promise<TaskView> {
    const { team, task } = this.findTask(input.taskId);
    task.status = input.status;
    this.touchTask(task);
    this.changed(team.id);
    return this.taskView(team, task);
  }

  // ── 分支协作 ──────────────────────────────────────────────────────────────

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
        await this.refreshBranches(team);
        this.changed(team.id);
        return { action: 'list', branches: team.branches, detail: `${team.branches.length} branches` };
      }
      case 'create': {
        const branch = requireBranch(input.branch);
        const startPoint = input.target ?? team.baseBranch;
        await createBranch(team.repoPath, branch, startPoint);
        await this.refreshBranches(team);
        this.changed(team.id);
        return { action: 'create', branches: team.branches, detail: `created ${branch} from ${startPoint}` };
      }
      case 'switch': {
        const branch = requireBranch(input.branch);
        const member = this.memberOf(team, requireMember(input.memberId));
        await this.refreshBranches(team);
        if (!team.branches.includes(branch)) {
          throw new Error(`branch "${branch}" does not exist; known branches: ${team.branches.join(', ')}`);
        }
        await checkout(member.workspacePath, branch);
        member.branch = branch;
        this.changed(team.id);
        return { action: 'switch', branches: team.branches, detail: `${member.name} switched to ${branch}` };
      }
      case 'merge': {
        const branch = requireBranch(input.branch);
        const target = input.target ?? team.baseBranch;
        await mergeBranch(team.repoPath, branch, target, team.baseBranch, `merge: ${branch} into ${target} (dsh-ai-team)`);
        await this.refreshBranches(team);
        this.changed(team.id);
        return { action: 'merge', branches: team.branches, detail: `merged ${branch} into ${target}` };
      }
    }
  }

  // ── 质量门 ────────────────────────────────────────────────────────────────

  /**
   * 在任务接手者的工作区里跑配置好的质量门命令。结果存在任务上
   * （code_review 的 approve 要求它全绿）。
   */
  async runGatesForTask(input: { taskId: string; signal?: AbortSignal }): Promise<GateSummary> {
    const { team, task } = this.findTask(input.taskId);
    const assignee = this.memberOf(team, task.assigneeId);
    // 按画像选门：honor `when`（按 touches 条件触发）与 `role: 'ci'`
    //（只由远端 CI 执行，本地绝跑不）。
    const { commands, skippedCi } = selectGateCommands(
      this.options.profile,
      task.touches,
      this.options.gates.commands,
    );
    // 可选的构建缓存共享：跑门前先把被 gitignore 的缓存目录软链到按分支共享的
    // 位置，让 build / e2e 复用上一次产物。
    if (this.options.buildCache?.enabled === true) {
      const cacheDir = join(this.options.rootDir, team.id, 'build-cache', task.branch);
      await linkSharedCacheDirs(assignee.workspacePath, cacheDir, this.options.buildCache.dirs).catch(() => {});
    }
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
    if (skippedCi.length > 0) {
      // 明确标出被有意跳过的 CI-only 门，让模型与 reviewer 知道本地这轮
      // 本来就不是全部约束。
      summary.results.push({
        command: `(ci-only, not run locally) ${skippedCi.join(' && ')}`,
        passed: true,
        exitCode: 0,
        durationMs: 0,
        logTail: 'deferred to remote CI (requireCiGreen)',
      });
    }
    task.gates = summary;
    this.touchTask(task);
    this.changed(team.id);
    return summary;
  }

  // ── 代码评审（受门约束） ──────────────────────────────────────────────────

  /**
   * reviewer 对处于评审中的任务给出结论。approve 在开启 pushRequiresGates 时
   * 要求质量门全绿（规范 §4.5.4），随后按画像的合并策略合入 base；冲突则失败，
   * 任务停留在 in_review。request_changes 累加轮次并把任务退回。
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
      this.assertMergeAllowed(task);
      await mergeBranch(
        team.repoPath,
        task.branch,
        team.baseBranch,
        team.baseBranch,
        `merge: ${task.branch} — ${task.title} (approved by ${reviewer.name})`,
        this.options.profile.mergeStrategy,
      );
      merged = true;
      task.status = 'done';
      await this.updateContractStatus(team, task, 'done');
      // 让开发者的个人分支跟上刚合入的 base，再回到空闲。
      await this.releaseMemberWorkspace(assignee, team);
      if (this.hasRemote) await this.pushWithRemoteEnv(team, team.baseBranch);
    } else {
      task.status = 'changes_requested';
      task.reviewRound += 1;
      assignee.status = 'working';
    }
    this.touchTask(task);
    await this.refreshBranches(team);
    this.changed(team.id);
    return { review: this.reviewView(team, review), task: this.taskView(team, task), merged };
  }

  /** approve 前的硬校验：质量门与远端 CI 必须先绿。 */
  private assertMergeAllowed(task: TaskRecord): void {
    if (!this.options.security.pushRequiresGates) return;
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

  /** 从共享仓库里删掉已合并的任务分支。 */
  async pruneTaskBranch(taskId: string): Promise<void> {
    const { team, task } = this.findTask(taskId);
    if (task.status !== 'done') {
      throw new Error(`task "${task.title}" is not done; only merged task branches can be pruned`);
    }
    await deleteBranch(team.repoPath, task.branch);
    await this.refreshBranches(team);
    this.changed(team.id);
  }

  // ── pr_sync ───────────────────────────────────────────────────────────────

  /**
   * 把任务分支推到远端（规范 §4.2 pr_sync）。推送前的护栏：质量门要绿
   * （pushRequiresGates），分支 diff 不能碰禁区（规范 §4.5.3）。github 平台会
   * 用 api token 创建/更新 PR，其它平台只做推送。顺带刷新一次 CI 状态。
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
      await this.assertBranchDiffAllowed(team, task);
      await pushBranch(team.repoPath, task.branch, { env });
    } finally {
      await cleanup();
    }
    // PR 创建只支持 github；其它平台退化为纯推送。
    if (this.options.remote.platform === 'github') {
      task.prUrl = await this.upsertPullRequest(team, task).catch(() => task.prUrl);
      task.ciStatus = await this.ciStatusFor(team, task.branch).catch((): CiStatus => 'unknown');
    } else {
      task.ciStatus = 'unknown';
    }
    this.touchTask(task);
    this.changed(team.id);
    return { pushed: true, prUrl: task.prUrl, ciStatus: task.ciStatus ?? 'unknown' };
  }

  /**
   * 推送前的禁区检查（规范 §4.5.3）。策略由画像决定且区分模式：
   *  - `block`（human-only）→ 硬阻断推送并升级；
   *  - `needs-approval` / `high-conflict` → 先压住推送，等人或 owner 决策
   *    （走独立 PR），升级但不推。
   */
  private async assertBranchDiffAllowed(team: TeamRecord, task: TaskRecord): Promise<void> {
    const baseSha = await resolveRef(team.repoPath, `origin/${team.baseBranch}`);
    const branchSha = await resolveRef(team.repoPath, task.branch);
    if (baseSha === null || branchSha === null) return;
    const rules = effectiveForbiddenRules(this.options.profile, this.options.security.forbiddenPaths);
    const files = await changedFiles(team.repoPath, baseSha, branchSha);
    const { blocks, approvals } = classifyForbiddenFiles(files, rules);
    if (blocks.length > 0) {
      await this.escalateTask({
        taskId: task.id,
        reason: 'forbidden-paths',
        message: `branch ${task.branch} touches human-only/blocked paths: ${blocks.join(', ')}`,
        suggestion: 'remove the forbidden changes from the task branch, rebase onto base, then pr_sync again',
      });
      throw new Error(`push blocked: forbidden paths modified: ${blocks.join(', ')}`);
    }
    if (approvals.length > 0) {
      await this.escalateTask({
        taskId: task.id,
        reason: 'manual',
        message: `branch ${task.branch} touches paths needing owner/human approval or a dedicated PR: ${approvals.join(', ')}`,
        suggestion:
          'confirm the change may land only as a separate PR after owner/human approval, or split it out of this task',
      });
      throw new Error(`push held for approval: ${approvals.join(', ')}`);
    }
  }

  /** 为任务分支创建/更新 PR；拿不到新 URL 时保留旧值。 */
  private async upsertPullRequest(team: TeamRecord, task: TaskRecord): Promise<string | null> {
    const token = resolveOptionalEnvRef(this.options.remote.apiTokenEnv);
    if (token === undefined) return null;
    // token 一读出来就登记进脱敏器：外发 body 与日志都不会出现明文。
    this.redactor.register(token);
    const id = task.contractId ?? task.id;
    const result = await upsertPullRequest({
      token,
      slug: githubRepoSlug(this.options.remote.url),
      title: renderPrTitle(this.options.profile.prTitleTemplate, id, task.title, task.touches),
      body: this.redactor.redact(
        renderPrBody(
          this.options.profile.prBodyTemplate,
          id,
          task.title,
          task.touches,
          this.memberOf(team, task.assigneeId).name,
        ),
      ),
      head: task.branch,
      base: team.baseBranch,
      ...(this.options.fetchFn !== undefined ? { fetchFn: this.options.fetchFn } : {}),
    });
    return result.created ? result.url : task.prUrl;
  }

  /** 查询某个分支当前 HEAD 的 CI 汇总状态；查不到 sha 时返回 unknown。 */
  private async ciStatusFor(team: TeamRecord, branch: string): Promise<CiStatus> {
    const sha = await resolveRef(team.repoPath, branch);
    if (sha === null) return 'unknown';
    const token = resolveOptionalEnvRef(this.options.remote.apiTokenEnv);
    return checkRunStatus({
      slug: githubRepoSlug(this.options.remote.url),
      sha,
      ...(token !== undefined ? { token } : {}),
      ...(this.options.fetchFn !== undefined ? { fetchFn: this.options.fetchFn } : {}),
    });
  }

  // ── 升级 ──────────────────────────────────────────────────────────────────

  /**
   * 发起升级（规范 §4.3 触发清单）：记录 + 任务备注 + 打标 + webhook，
   * 然后按 escalation.pauseOnEscalation 决定是否暂停。
   */
  async escalateTask(input: EscalationInput): Promise<EscalationView> {
    const record = await this.escalations.escalate(input);
    if (input.taskId !== null) {
      const found = this.tryFindTask(input.taskId);
      if (found !== null) {
        found.task.status = 'needs-human';
        found.task.updatedAt = Date.now();
        // 释放接手者，让分诊与重新派发可以挑任意开发者：任务分支不能一直
        // 占着他的工作区。
        const assignee = found.team.members.find((member) => member.id === found.task.assigneeId);
        if (assignee !== undefined && assignee.currentTaskId === found.task.id) {
          await this.releaseMemberWorkspace(assignee);
        }
      }
    }
    if (this.options.escalation.pauseOnEscalation === 'team' && this.loopState === 'running') {
      this.loopState = 'escalated';
    }
    this.changed(foundTeamId(input.taskId, this.teams));
    return record;
  }

  /** 人工（或其它插件）分诊：解决升级并把任务退回 pending。 */
  async resolveEscalation(input: { escalationId: string }): Promise<void> {
    this.escalations.resolve(input.escalationId);
    const record = this.escalationById(input.escalationId);
    if (record?.taskId != null) {
      const found = this.tryFindTask(record.taskId);
      if (found !== null && found.task.status === 'needs-human') {
        await this.reopenTask(found.team, found.task);
      }
    }
    if (this.loopState === 'escalated') this.loopState = 'running';
    this.changed();
  }

  // ── 部署 ──────────────────────────────────────────────────────────────────

  /**
   * 从基础分支部署（规范 §4.2 deploy_run）：仅在启用部署、base 健康且 base
   * 自上次部署后又有推进时执行。健康检查失败会在 runDeploy 内部触发回滚并升级。
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

  // ── 守护循环 ──────────────────────────────────────────────────────────────

  getLoopState(): LoopState {
    return this.loopState;
  }

  /**
   * 启动无人值守循环（autopilot_run）。幂等：运行期间重复调用只返回当前状态。
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

  /** 暂停循环（autopilot_pause）——人或其它插件要介入时调用。 */
  pauseLoop(): LoopState {
    if (this.loopState === 'running') {
      this.loopState = 'paused';
      this.changed();
    }
    return this.loopState;
  }

  /** 恢复暂停或升级中的循环（autopilot_resume）。 */
  resumeLoop(): LoopState {
    if (this.loopState === 'paused' || this.loopState === 'escalated') {
      this.loopState = 'running';
      this.changed();
    }
    return this.loopState;
  }

  /** 停止循环，并等当前 tick 安全落地。 */
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
      // 空闲退避：连续 5 个安静的 tick 之后，把轮询间隔最多放大到 4 倍。
      const factor = Math.min(1 + Math.floor(idleTicks / IDLE_BACKOFF_TICKS), MAX_IDLE_BACKOFF_FACTOR);
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
   * 无人值守循环的一轮（规范 §4.3）。设为 public，测试可以脱离时序确定性地
   * 驱动它。
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
    // 1. 恢复：上一次崩溃时停留在 in_progress 的任务重新变为可派发。
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
      await this.checkCompletion(team, report);
    }
    this.changed();
    return report;
  }

  /** 把仓库里的任务契约同步到看板；分诊 needs-human 的契约。 */
  private async syncContracts(team: TeamRecord, report: TickReport): Promise<void> {
    const contracts = await loadTaskContracts(team.repoPath).catch(() => [] as TaskContract[]);
    for (const contract of contracts) {
      const existing = team.tasks.find((task) => task.contractId === contract.id);
      if (existing === undefined) {
        this.adoptPendingContract(team, contract, report);
      } else if (existing.status === 'needs-human' && contract.status !== 'needs-human') {
        // 人直接改了契约文件把状态从 needs-human 挪走 → 重开任务。
        // 契约文件已经是权威来源，这里只改内存状态，不再回写一次。
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

  /**
   * 还没有人认领的契约：以 leader 为名义 owner 挂在看板上保持 pending，
   * 等 dispatch 真正派发时再落到具体开发者头上。
   */
  private adoptPendingContract(team: TeamRecord, contract: TaskContract, report: TickReport): void {
    const leader = team.members.find((member) => member.role === 'leader');
    if (leader === undefined) return;
    if (contract.status !== 'pending') return;
    const now = Date.now();
    team.tasks.push({
      id: shortId('task'),
      contractId: contract.id,
      contractPath: contract.path,
      title: contract.title,
      description: enrichDescriptionWithOwnership(
        contract.body.slice(0, CONTRACT_BODY_LIMIT),
        contract.touches,
        this.options.profile.ownership,
      ),
      assigneeId: leader.id,
      status: 'pending',
      branch: renderBranchName(this.options.profile.branchTemplate, contract.id, contract.title),
      reviewRound: 0,
      dependsOn: contract.dependsOn,
      touches: contract.touches,
      gates: null,
      prUrl: null,
      ciStatus: null,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    report.events.push(`contract:${contract.id}`);
  }

  /** 派发 pending 任务（依赖已完成、领域锁空闲）给空闲开发者。 */
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
      if (await this.escalateCrossDomain(task, report)) continue;
      if (!task.dependsOn.every((dep) => doneContracts.has(dep))) continue;
      if (task.touches.length > 0 && touchesOverlap(task.touches, lockedTouches)) continue;
      const developers = team.members.filter(
        (member) => member.role === 'developer' && member.status === 'idle' && member.currentTaskId === null,
      );
      const developer = this.pickDeveloper(developers, task.touches);
      if (developer === undefined) return; // 没有空闲开发者，下个 tick 再试
      // （重新）派发：syncContracts 建的占位任务在这里拿到真正的接手者、
      // 分支与工作区检出。
      task.assigneeId = developer.id;
      await this.refreshBranches(team);
      if (!team.branches.includes(task.branch)) {
        await createBranch(team.repoPath, task.branch, team.baseBranch);
      }
      await checkout(developer.workspacePath, task.branch);
      developer.branch = task.branch;
      developer.status = 'working';
      developer.currentTaskId = task.id;
      task.status = 'in_progress';
      this.touchTask(task);
      await this.updateContractStatus(team, task, 'in_progress', developer.name);
      lockedTouches.push(...task.touches);
      report.dispatched.push(task.id);
      report.events.push(`dispatched:${task.id}`);
    }
  }

  /**
   * 跨域检查：触及的领域数超过阈值就升级并跳过派发。
   * @returns 是否已升级（true 表示本轮不要再派发这个任务）
   */
  private async escalateCrossDomain(task: TaskRecord, report: TickReport): Promise<boolean> {
    const domainCount = distinctDomainCount(task.touches);
    const threshold = this.options.profile.crossDomainThreshold;
    if (domainCount <= threshold) return false;
    report.escalated.push(task.id);
    report.events.push(`cross-domain:${task.id}`);
    await this.escalateTask({
      taskId: task.id,
      reason: 'cross-domain',
      message: `task "${task.title}" touches ${domainCount} distinct domains (limit ${threshold})`,
      suggestion: 'split it into per-domain tasks instead of one cross-domain change',
    });
    return true;
  }

  /**
   * 挑一个开发者：优先选专精方向与任务命中所有权规则一致的，
   * 否则退回任意空闲开发者。
   */
  private pickDeveloper(developers: MemberRecord[], touches: readonly string[]): MemberRecord | undefined {
    if (developers.length === 0) return undefined;
    const ownerRole = ownerRoleForTouches(touches, this.options.profile.ownership);
    if (ownerRole === null) return developers[0];
    return developers.find((member) => member.specialization === ownerRole) ?? developers[0];
  }

  /** 升级耗尽返工轮次的任务。 */
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

  /** 升级 stuckMinutes 内没有任何 git 活动的进行中任务。 */
  private async checkStuck(team: TeamRecord, report: TickReport): Promise<void> {
    const stuckMs = this.options.daemon.stuckMinutes * 60_000;
    for (const task of team.tasks) {
      if (task.status !== 'in_progress') continue;
      // 任务分支上的新提交即视为活动，用它刷新 lastActivityAt。
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

  /** 基础分支有推进且门/CI 允许时部署。 */
  private async maybeDeploy(team: TeamRecord, report: TickReport): Promise<void> {
    const deploy = this.options.deploy;
    if (deploy?.enabled !== true || deploy.command === undefined || deploy.command === '') return;
    const baseSha = await resolveRef(team.repoPath, team.baseBranch).catch(() => null);
    if (baseSha === null || baseSha === this.lastDeployBaseSha) return;
    if (this.options.gates.requireCiGreen && this.hasRemote) {
      const ci = await this.ciStatusFor(team, team.baseBranch).catch(() => 'unknown' as CiStatus);
      if (ci !== 'success') return;
    }
    const view = await this.deployRun(team.id);
    report.deployed = view.id;
    report.events.push(`deploy:${view.id}:${view.status}`);
  }

  /** 全部任务完成 → 写完成报告并把循环置为 completed。 */
  private async checkCompletion(team: TeamRecord, report: TickReport): Promise<void> {
    if (team.tasks.length === 0) return;
    if (!team.tasks.every((task) => task.status === 'done')) return;
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
    await writeFile(join(team.repoPath, TASKS_DIR, COMPLETION_FILE), summary, 'utf8').catch(() => {});
    await this.commitTasksDir(team, 'tasks: completion report');
  }

  // ── 状态查询 ──────────────────────────────────────────────────────────────

  /** 任务的 git 活动探针：任务分支相对 base 的新提交数。 */
  async taskActivity(taskId: string): Promise<{ newCommits: number; lastCommitAt: number | null }> {
    const { team, task } = this.findTask(taskId);
    const baseSha = await resolveRef(team.repoPath, team.baseBranch);
    const newCommits = baseSha === null ? 0 : await countNewCommits(team.repoPath, task.branch, baseSha);
    const lastCommit = await lastCommitAt(team.repoPath, task.branch);
    return { newCommits, lastCommitAt: lastCommit };
  }

  /** autopilot_status：循环、看板、工作区健康度、心跳与阻塞项。 */
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

// ── 模块级工具 ──────────────────────────────────────────────────────────────

/** 新建一条通知记录时的初始状态（未送达、未答复）。 */
function emptyNotification(): EscalationNotification {
  return {
    status: 'sent',
    mailTo: '',
    mailDelivered: false,
    ticketUrl: null,
    submitted: null,
    submittedAt: null,
    autoResumed: false,
    error: null,
  };
}

/** 找出任务所属的团队（用于变更通知定位到面板）。 */
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

/** 可被 abort 打断的 sleep：守护循环的每一处等待都必须能取消。 */
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
