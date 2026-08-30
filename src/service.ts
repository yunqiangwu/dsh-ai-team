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
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  addWorktree,
  checkout,
  changedFiles,
  cloneRemote,
  commitAll,
  countNewCommits,
  createBranch,
  deleteBranch,
  diffShortstat,
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
  assertSafeRef,
} from './git.js';
import { bootstrapEnvironment, type BootstrapReport } from './bootstrap.js';
import { linkSharedCacheDirs } from './cache.js';
import { runGates } from './gates.js';
import { runDeploy } from './deploy.js';
import { checkRunStatus, githubRepoSlug, upsertPullRequest } from './github.js';
import { EscalationManager, type EscalationInput } from './escalate.js';
import { Mailer, postHumanWebhook, renderEscalationMail } from './notification.js';
import {
  TICKET_PATH_PREFIX,
  TicketHandler,
  TicketServer,
  ticketUrlWithToken,
  type TicketStore,
  type TicketTrust,
} from './ticket-handler.js';
import { escalationFields } from './formmodel.js';
import {
  newApprovalCode,
  questionnaireViewOf,
  QuestionnaireManager,
  ticketFieldsOf,
  type QuestionnaireRecord,
} from './questionnaire.js';
import { repoFile, type DocStatus } from './docdraft.js';
import {
  renderContractFile,
  validateContractBatch,
  validateContractDraft,
  type ContractDraft,
} from './service/contracts.js';
import {
  classifyForbiddenFiles,
  domainLimitStatus,
  effectiveForbiddenRules,
  forbiddenTouchesViolation,
  ownerRoleForTouches,
  renderBranchName,
  renderPrBody,
  renderPrTitle,
  selectGateCommands,
} from './profile.js';
import { resolveOptionalEnvRef, SecretRedactor } from './secrets.js';
import {
  appendTaskNote,
  loadTaskContracts,
  patchTaskContract,
  regenerateBoard,
  renderTaskNote,
  touchesOverlap,
  type TaskContract,
} from './team.js';
import { defaultMemberName, isRole, systemPromptFor } from './roles.js';
import {
  applyLearning,
  DEFAULT_LEARNINGS,
  renderLearningsFile,
  viewOf,
  type LearningInput,
  type LearningOptions,
} from './learnings.js';
import type {
  AnswerSource,
  AutopilotProjection,
  CiStatus,
  DeployView,
  EscalationNotification,
  EscalationView,
  GateSummary,
  HeartbeatView,
  LearningBucket,
  LearningKind,
  LearningView,
  LoopState,
  MemberView,
  Question,
  QuestionBinding,
  QuestionnaireKind,
  QuestionnaireMode,
  QuestionnaireView,
  ReviewVerdict,
  ReviewView,
  Role,
  TaskStatus,
  TaskView,
  TeamPhase,
  TeamView,
} from './view.js';
// 阶段枚举经 view.ts 门面取自唯一词表（与 tools.ts 同一惯例）：手抄一份漏掉新值，
// 编译器和测试都不响。
import { DISPATCHABLE_PHASES, TICKET_ROUTE_PREFIX } from './view.js';
import type { AutopilotOptions } from './service/options.js';
import {
  clip,
  createTaskRecord,
  CANCELLABLE_FROM_BOARD,
  emptyTeamMetrics,
  HELD_STATUSES,
  memberBranch,
  noteLines,
  oneLine,
  requireTeamMember,
  shortId,
  TASKS_DIR,
  teamPhase,
} from './service/state.js';
import {
  memberView as memberViewOf,
  reviewView as reviewViewOf,
  taskView as taskViewOf,
} from './service/views.js';
import { budgetExceeded, reviewRoundsExceeded, taskStuck } from './service/daemon.js';
import {
  APPROVAL_QUESTION,
  assertBindingWritable,
  docApprove as docApproveFlow,
  docWrite as docWriteFlow,
  effectiveAnswers,
  findAcceptedDrift,
  promoteDrafts,
  questionnaireResult,
  resetDraftsToEditable,
  revertAcceptedDrift,
  stampForApproval,
  withApprovalQuestion,
  writeBackAnswers,
  type AskHumanResult,
  type DocFlowDeps,
  type PromoteResult,
  type WriteBack,
} from './service/docflow.js';
import type {
  MemberRecord,
  PersistedState,
  ReviewRecord,
  TaskRecord,
  TeamMetrics,
  TeamRecord,
  TickReport,
} from './service/state.js';
import { buildDescription } from './service/description.js';
import { renderCompletionReport } from './service/report.js';

// ── 常量（数据形状与文本预算已各自成模块，这里只留循环自用项） ──────────────

/** 状态落盘的防抖窗口（毫秒）：一次 tick 内的多次变更合并成一次写。 */
const PERSIST_DEBOUNCE_MS = 100;

/** 全部任务完成后的完成报告（运行态产物，落在 stateDir）。 */
const COMPLETION_ARTIFACT = 'completion.md';

/**
 * 学习记录的全量生成物（运行态产物，落在 stateDir）。
 * 不再放 `.tasks/` 下：那是目标仓库、会被提交进用户的 git 历史，而 AGENTS.md 的
 * 约定是运行态绝不入库。移出后也不再需要靠 `_` 前缀躲开 loadTaskContracts 的收养。
 */
const LEARNINGS_ARTIFACT = 'learnings.md';

/** 单条学习记录原文（评审意见 / 升级消息 / 日志尾）的截断长度。 */
const LEARNING_DETAIL_LIMIT = 400;

/** 连续空闲多少个 tick 后开始放大轮询间隔。 */
const IDLE_BACKOFF_TICKS = 5;

/** 空闲退避的最大倍数：最多把轮询间隔放大到 4 倍。 */
const MAX_IDLE_BACKOFF_FACTOR = 4;

/**
 * 审批问卷的「批 / 不批」保留题、文档审批链与问卷记录纯操作已搬到
 * `service/docflow.ts`（脱离状态机单测）；这里 re-export 保持对外类型面不变。
 */
export type { AskHumanResult, PromoteResult } from './service/docflow.js';

/** 唤醒 interactive await 的负载：最终记录 + 这次作答的回写结果。 */
interface QuestionnaireOutcome {
  record: QuestionnaireRecord;
  writeBack: WriteBack;
}

// ── 服务主体 ────────────────────────────────────────────────────────────────

export class AutopilotService {
  private teams = new Map<string, TeamRecord>();
  private listeners = new Set<() => void>();
  /**
   * 由插件层登记的「带外快照推送」回调（见 setSnapshotPublisher）。
   * 放在这里而不是并入 listeners：listeners 每次状态变更都会响，而工具调用栈里
   * 的变更已经由 publish() 顺带推过一遍了，重复推只是给 session 日志灌水。
   */
  private snapshotPublisher: (() => void) | undefined;
  private activeTeamId: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private loopState: LoopState = 'stopped';
  private tick = 0;
  private bootstrapped = false;
  private lastDeployBaseSha: string | null = null;
  private notificationMailer: Mailer | null = null;
  private notificationServer: TicketServer | null = null;
  /**
   * 工单凭据（ticket id → token）的**旁路表**。刻意既不在记录里也不在视图里：
   * 全量快照会进模型读得到的 session 日志，而默认命令白名单里有 `node`（AGENTS.md
   * 安全硬规则 2：那等价于能起任意进程），拿到 token 就等于模型可以自己答掉一张
   * 等人的工单 —— 与 `approvalCode` 同一条理由（见 schema.ts）。
   *
   * key 覆盖 `qn_` 与 `esc_` 两个 id 空间：作答入口是共用的（`submitTicketAnswer`），
   * 凭据表也就只有一张。
   */
  private readonly ticketTokens = new Map<string, string>();
  private deploys: DeployView[] = [];
  private recoveredOnce = false;
  /**
   * 已经进过 `contract-rejected` 事件的坏契约路径。去重是必需的：坏文件每拍都会
   * 被重新扫到，若每拍都塞一条事件，`report.events` 就永远非空，空闲退避
   * （runLoop 里的 idleTicks）再也不会生效。
   */
  private readonly reportedRejectedContracts = new Set<string>();
  /**
   * 重规划调用的滚动窗口（teamId → 近一小时的调用时刻）。只在内存里：它是防
   * 「无限重排」的短期护栏，不是审计记录 —— 重启清零可接受，与 questionnaireWaiters
   * 同一条口径（docs/design-interaction.md §6.5）。
   */
  private readonly replanCalls = new Map<string, number[]>();
  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;

  readonly redactor = new SecretRedactor();
  readonly escalations: EscalationManager;
  /**
   * 问卷（AI 要人给一个决策）与升级（AI 卡住了）是两个实体、两条记录，绝不共用：
   * 见 src/questionnaire.ts 的开头。
   */
  readonly questionnaires: QuestionnaireManager;
  /**
   * interactive 模式的 `ask_human` 就 await 在这里：问卷 id → 唤醒回调。
   * 只在内存里 —— 一条等不到人的 await 撑过一次崩溃没有意义，恢复后问卷仍然
   * open，组长重新问一次比假装续上更安全。
   *
   * `settled` 是反方向的竞态：工单 POST 抢在投递返回之前答完了，此刻还没有等待者，
   * 就把结果（含回写报告）留在这个槽位里，等 `waitForQuestionnaire` 上门取走。
   */
  private readonly questionnaireWaiters = new Map<
    string,
    {
      settle: (outcome: QuestionnaireOutcome) => void;
      timer: ReturnType<typeof setTimeout> | null;
      settled?: QuestionnaireOutcome;
    }
  >();

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
    this.questionnaires = new QuestionnaireManager({ redactor: this.redactor });
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
   * 接通人工通知回路（出向的 SMTP 邮件 + 入向的本地工单端点）。
   *
   * 两种失败刻意不同处理：
   *
   * - **绑定地址不是回环 → 抛**（`TicketServer.start()` 同步拒绝，一路穿到插件装载
   *   失败）。这个端点收的答案等于替 AI 团队做决策，开放在网段上时"决策由人来做"
   *   这条前提就作废了（docs/design-interaction.md §8-9），不是能降级继续的东西。
   * - **listen 失败（端口被占）→ 记一条告警后继续**。后果只是邮件里的工单链接打不开，
   *   而面板同源路由与 `answer_questionnaire` 都还在，守护进程不该因此起不来。
   */
  private initNotification(): void {
    const config = this.options.notification;
    if (config?.enabled !== true) return;
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
      handler: this.buildTicketHandler(TICKET_PATH_PREFIX, 'token-only'),
    });
    this.notificationServer = server;
    void server.start().catch((error: unknown) => {
      // 置空即退回"没有工单端点"：notify* 因此不会在邮件里写一条打不开的链接。
      this.notificationServer = null;
      this.warn('notification: 本地工单端点未能监听，邮件里的工单链接将不可用', error);
    });
  }

  /** 面向运维的告警出口：由插件层接到 `ctx.logger.warn`（核心不碰 cordis）。 */
  private warn(message: string, error?: unknown): void {
    this.options.warn?.(message, error);
  }

  /**
   * 造一个挂载点用的 handler。两个挂载点只差 `basePath` 与接受哪种凭据，其余
   * （数据源、token 表、可信 authority 清单）必须是同一份 —— 否则同一张工单在
   * 两处会画出两张脸。
   */
  private buildTicketHandler(
    basePath: string,
    trust: TicketTrust,
    trustedHosts?: () => readonly string[],
  ): TicketHandler {
    return new TicketHandler({
      basePath,
      store: this.ticketStore(),
      trust,
      tokenOf: (id) => this.ticketTokenOf(id),
      // 运维声明"人从哪个地址访问我们"的那一处配置，加上插件层递过来的宿主自带
      // 可信清单（Host 改写的反代与 `--host 0.0.0.0` 的局域网地址各占一头）。
      trustedAuthorities: () => {
        const publicBaseUrl = this.options.notification?.ticket.publicBaseUrl;
        return [...(publicBaseUrl === undefined || publicBaseUrl === '' ? [] : [publicBaseUrl]), ...(trustedHosts?.() ?? [])];
      },
      warn: (message, error) => this.warn(message, error),
    });
  }

  /**
   * 面板作答那条通道的 handler：由插件层 `register` 到宿主 `webServer` 的
   * `TICKET_ROUTE_PREFIX` 前缀上（装配住在 index.ts，本服务不认识 cordis）。
   *
   * 与独立端口那份的唯一区别是 `trust`：面板手里没有 token（token 刻意不在投影里），
   * 所以这条路由额外接受宿主那套同源围栏。`trustedHosts` 由插件层提供 —— 那是宿主
   * 自己的可信 Host 清单，本服务只把它当作一串 authority 字符串，不认识它从哪来。
   */
  panelTicketHandler(trustedHosts?: () => readonly string[]): TicketHandler {
    return this.buildTicketHandler(TICKET_ROUTE_PREFIX, 'fence-or-token', trustedHosts);
  }

  // ── 工单凭据 ──────────────────────────────────────────────────────────────

  /**
   * 铸造（或复用）一张工单的凭据。**只在要给人的文案里出现时调用** —— 面板那条
   * 走围栏，不需要 token。
   */
  private mintTicketToken(id: string): string {
    const existing = this.ticketTokens.get(id);
    if (existing !== undefined) return existing;
    const token = randomBytes(16).toString('hex');
    this.ticketTokens.set(id, token);
    return token;
  }

  /**
   * handler 唯一的读取口。对**还答得动**的记录惰性补铸，这样「每张开放工单都有
   * token」是个不变量，而不取决于某条通知路径有没有跑到（老 state.json 恢复出来的
   * 开放问卷就属于后者，不需要数据迁移）。
   */
  private ticketTokenOf(id: string): string | undefined {
    const existing = this.ticketTokens.get(id);
    if (existing !== undefined) return existing;
    if (!this.ticketAnswerable(id)) return undefined;
    const token = this.mintTicketToken(id);
    this.changed();
    return token;
  }

  /** 这张工单还答得动吗：问卷要 `open`，升级要未 resolve。 */
  private ticketAnswerable(id: string): boolean {
    const questionnaire = this.questionnaires.byId(id);
    if (questionnaire !== undefined) return questionnaire.status === 'open';
    return this.escalationById(id)?.resolvedAt === null;
  }

  /**
   * 工单数据源：一个 id 先按升级记录找，找不到再按问卷找。
   *
   * 刻意**不**按 id 前缀分流：前缀只是两类记录各自的命名习惯，拿它当路由依据等于
   * 给未来第三类可答工单埋一个「忘了改这里」的坑。两边都查不到才返回 null（404）。
   */
  private ticketStore(): TicketStore {
    return {
      renderTicket: async (id) => {
        const record = this.escalationById(id);
        if (record !== undefined) {
          return {
            title: `人工确认：${this.escalationSubject(record)}`,
            notice: 'AI 团队卡住了，需要你分诊。这不是正常流程里的提问 —— 有东西坏了或互相矛盾。',
            fields: escalationFields(),
          };
        }
        const questionnaire = this.questionnaires.byId(id);
        if (questionnaire === undefined) return null;
        const { notice, fields } = ticketFieldsOf(questionnaire);
        return { title: `等你决策：${questionnaire.title}`, notice, fields };
      },
      handleSubmit: (id, answers) => this.submitTicketAnswer(id, answers),
      hasTicket: (id) => this.escalationById(id) !== undefined || this.questionnaires.byId(id) !== undefined,
    };
  }

  /**
   * 把一次工单答卷应用到存活的记录上 —— 升级与问卷共用这一个入口，靠查找分流。
   * 这是 TicketServer 持有的回调：回写答案，并在开启 autoResume 时清除升级、
   * 恢复循环。设为 public 是为了让工具层和测试能走完全相同的路径。
   */
  async submitTicketAnswer(
    ticketId: string,
    answers: Record<string, string>,
  ): Promise<{ ok: boolean; message?: string; missing?: string[] }> {
    if (this.questionnaires.byId(ticketId) !== undefined) {
      return this.answerQuestionnaire({ questionnaireId: ticketId, answers, source: 'ticket' });
    }
    const record = this.escalationById(ticketId);
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
    // changed() 只管落盘与内部监听；快照事件要靠在插件层登记的发布器推出去，
    // 否则这条答复要等到下一次工具调用才看得见。
    this.snapshotPublisher?.();
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
    // 记录里那份**不带凭据**（它进投影，而投影进模型读得到的 session 日志）；
    // 只有给人的文案才拼上 `?t=` —— 独立工单端口现在无 token 一律 404。
    const ticketUrl = this.notificationServer === null ? null : `${baseUrl}${TICKET_PATH_PREFIX}/${record.id}`;
    const link = ticketUrl === null ? null : ticketUrlWithToken(ticketUrl, this.mintTicketToken(record.id));
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
    // 邮件文案渲染在 notification.ts（纯函数，与 Mailer 靠在一起）。
    const { subject, text } = renderEscalationMail({
      subject: this.escalationSubject(record),
      reason: record.reason,
      message: record.message,
      suggestion: record.suggestion,
      link,
    });
    try {
      await this.notificationMailer.send({ to: config.mailTo, subject, text });
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

  // ── 人工决策回路（问卷 + 文档先行，docs/design-interaction.md §3、§4）──────
  //
  // 与上面「人工通知回路」的分工：那边是升级（有东西坏了或矛盾了），这边是问卷
  //（一切正常，只是这个选择得由人来做）。两者共用 TicketServer 与 Mailer，但记录、
  // 状态与回写目标各一套 —— 混用会让一次普通提问看起来像一次故障。
  //
  // 文档审批链与问卷记录纯操作在 `service/docflow.ts`（`this.docflow` 注入依赖）；
  // 这里只保留交互层：投递、interactive 等待唤醒、两个工具后端与阶段分流。

  /** 文档审批链的依赖注入：全部是本服务已有能力的引用，不含新状态。 */
  private get docflow(): DocFlowDeps {
    return {
      docs: this.options.docs,
      forbiddenRules: effectiveForbiddenRules(this.options.profile, this.options.security.forbiddenPaths),
      redactor: this.redactor,
      questionnaires: this.questionnaires,
      teamOf: (teamId) => this.teamOf(teamId),
      tryFindTask: (taskId) => this.tryFindTask(taskId),
      commitTasksDir: (team, message) => this.commitTasksDir(team, message),
      applyPhase: (team, phase) => this.applyPhase(team, phase),
      notifyQuestionnaire: (record) => this.notifyQuestionnaire(record),
    };
  }

  /** 面板与 `autopilot_status` 用的对外视图（剥掉审批码，见 schema.ts 的说明）。 */
  private questionnaireViews(): QuestionnaireView[] {
    return this.questionnaires.all.map((record) => questionnaireViewOf(record));
  }

  /**
   * 投递一份问卷给人：工单链接 + 邮件（配了 webhook 就再推一条）。
   *
   * 尽力而为，绝不抛错：投递状态是记录上的数据。没配 notification 时工单链接为
   * null，此时唯一的作答入口是会话里人直接 `answer_questionnaire` —— 工具结果会
   * 如实带上 `mailDelivered: false`，组长不该以为人已经被叫来了。
   */
  private async notifyQuestionnaire(record: QuestionnaireRecord): Promise<{ ticketUrl: string | null; mailDelivered: boolean }> {
    const config = this.options.notification;
    const baseUrl = (config?.ticket.publicBaseUrl ?? '').replace(/\/+$/, '');
    // 与 notifyEscalation 同一分工：记录里那份不带凭据（它进投影、进工具结果，
    // 那些都在模型读得到的 session 日志里），只有给人的渠道才拼 `?t=`。
    const ticketUrl = this.notificationServer === null || baseUrl === '' ? null : `${baseUrl}${TICKET_PATH_PREFIX}/${record.id}`;
    const link = ticketUrl === null ? null : ticketUrlWithToken(ticketUrl, this.mintTicketToken(record.id));
    const lines: string[] = [`[dsh-ai-team] AI 团队需要你做一个决策：${record.title}`, ''];
    if (record.kind === 'approval') {
      lines.push('这是一次文档审批。批准前请自己读一遍 draft 区里的内容 —— 文档改写没有客观质量门可验证。');
      if (record.approvalCode !== null) {
        lines.push(`审批码：${record.approvalCode}（一次性凭据，只有读到本邮件的人能批准）`);
      }
      lines.push('');
    }
    record.questions.forEach((question, index) => {
      lines.push(`Q${index + 1}. ${question.label}${question.required ? '' : '（可留空）'}`);
      for (const option of question.options) {
        const marks = [option.recommended ? '推荐' : '', option.value === question.defaultValue ? '默认' : '']
          .filter((mark) => mark !== '')
          .join(' / ');
        lines.push(`  - ${option.label}${option.impact === '' ? '' : `：${option.impact}`}${marks === '' ? '' : ` [${marks}]`}`);
      }
      if (question.type === 'multiselect') lines.push('  （可多选）');
    });
    lines.push(
      '',
      ticketUrl === null ? '（未配置工单端点：请回到 dsh 会话里直接作答）' : `请填写工单：${link}`,
      record.mode === 'interactive'
        ? `这条提问正卡在那一轮里等人回答，最长 ${this.options.questionnaire.timeoutMinutes} 分钟；超时后按各题默认方案继续。`
        : '这是异步提问：答完请回会话里说一句「继续」，组长才会往下走（插件无法自行唤醒 agent）。',
      '密钥请通过环境变量提供，勿直接粘贴。',
    );
    let mailDelivered = false;
    if (config?.enabled === true && this.notificationMailer !== null) {
      mailDelivered = await this.notificationMailer
        .send({ to: config.mailTo, subject: `[dsh-ai-team] 等你决策: ${record.title}`, text: lines.join('\n') })
        .then(() => true, () => false);
    }
    await postHumanWebhook({
      urlEnv: this.options.escalation.webhookUrlEnv,
      text: `[dsh-ai-team] 等你决策: ${record.title}`,
      // webhook 是给人的渠道，所以推带凭据的那份；记录里的 ticketUrl 仍无凭据。
      payload: { questionnaire: questionnaireViewOf(record), ticketUrl: link },
      redactor: this.redactor,
      ...(this.options.fetchFn !== undefined ? { fetchFn: this.options.fetchFn } : {}),
    });
    return { ticketUrl, mailDelivered };
  }

  /**
   * interactive 的 await 就住在这里：到点没人答就把问卷转 `expired` 并放行，
   * 绝不让组长那一轮永久挂着（§3.2）。答案若赶在登记之前到了，就直接取那份结果。
   */
  private waitForQuestionnaire(record: QuestionnaireRecord, timeoutMs: number): Promise<QuestionnaireOutcome> {
    const teamId = record.teamId;
    const early = this.questionnaireWaiters.get(record.id)?.settled;
    if (early !== undefined) {
      this.questionnaireWaiters.delete(record.id);
      return Promise.resolve(early);
    }
    return new Promise<QuestionnaireOutcome>((resolvePromise) => {
      const settle = (settled: QuestionnaireOutcome): void => resolvePromise(settled);
      if (!(timeoutMs > 0)) {
        this.questionnaireWaiters.set(record.id, { settle, timer: null });
        return;
      }
      const timer = setTimeout(() => {
        this.questionnaireWaiters.delete(record.id);
        this.questionnaires.expire(record.id);
        const expired = this.questionnaires.byId(record.id);
        // 记录被有界列表挤掉属于病态情况：宁可不放行（这轮工具调用由宿主管超时），
        // 也不要凭空造一份答案。
        if (expired === undefined) return;
        this.changed(teamId);
        this.snapshotPublisher?.();
        settle({ record: expired, writeBack: { writtenTo: null, sectionMatched: null } });
      }, timeoutMs);
      this.questionnaireWaiters.set(record.id, { settle, timer });
    });
  }

  /** 有人答了（或人被取消了）：唤醒正在 await 的那一轮。 */
  private settleQuestionnaireWaiter(record: QuestionnaireRecord, writeBack: WriteBack): void {
    const waiter = this.questionnaireWaiters.get(record.id);
    if (waiter === undefined) {
      // 答案比 await 先到：只有 interactive 才会有 await，别的模式直接丢弃。
      if (record.mode === 'interactive') {
        this.questionnaireWaiters.set(record.id, { settle: () => {}, timer: null, settled: { record, writeBack } });
      }
      return;
    }
    this.questionnaireWaiters.delete(record.id);
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    waiter.settle({ record, writeBack });
  }

  /**
   * 向人提一个决策问题（`ask_human` 的后端，§3）。
   *
   * `interactive` 真的 await 到人答复或超时才返回，组长这一轮 agent 不断线；
   * `async` 登记 open 问卷后立即返回。等待期间挂着的 open 问卷就是 `checkStuck`
   * 的豁免依据（§6.5）—— 否则一次合法的「等人 45 分钟」会被判成任务卡死。
   */
  async askHuman(input: {
    teamId: string;
    title: string;
    questions: Question[];
    kind?: QuestionnaireKind;
    binding?: QuestionBinding | null;
    taskId?: string | null;
    mode?: QuestionnaireMode;
    /** interactive 的 await 上限覆盖（测试用）；缺省取 questionnaire.timeoutMinutes。 */
    timeoutMinutes?: number;
  }): Promise<AskHumanResult> {
    const team = this.teamOf(input.teamId);
    const kind = input.kind ?? 'intake';
    const mode = input.mode ?? this.options.questionnaire.mode;
    const taskId = input.taskId ?? null;
    if (taskId !== null) this.findTask(taskId);
    const binding = assertBindingWritable(this.docflow, team, input.binding ?? null);
    const questions = kind === 'approval' ? withApprovalQuestion(input.questions) : input.questions;
    // 「这批草稿批不批」之前，先把人将要看的那份内容钉住（sha256 = 落盘正文哈希）：
    // 这是防「批 A 合 B」的前半，后半是 promoteDrafts 的比对。空包直接拒绝。
    if (kind === 'approval') await stampForApproval(this.docflow, team, input.title);
    const timeoutMinutes = input.timeoutMinutes ?? this.options.questionnaire.timeoutMinutes;
    const timeoutMs = mode === 'interactive' ? Math.max(0, timeoutMinutes) * 60_000 : 0;
    const record = this.questionnaires.create({
      teamId: team.id,
      kind,
      title: input.title,
      mode,
      questions,
      binding,
      taskId,
      timeoutMs,
      ...(kind === 'approval' ? { approvalCode: newApprovalCode() } : {}),
    });
    const delivery = await this.notifyQuestionnaire(record);
    this.questionnaires.markDelivery(record.id, delivery);
    this.changed(team.id);
    // 「正在等人」这一帧必须现在就出去：interactive 模式下工具的 `publish()` 要等
    // await 结束才跑得动，而那正是几十分钟之后。
    this.snapshotPublisher?.();
    if (mode !== 'interactive') return questionnaireResult(record, { writtenTo: null, sectionMatched: null });
    const outcome = await this.waitForQuestionnaire(record, timeoutMs);
    return questionnaireResult(outcome.record, outcome.writeBack);
  }

  /**
   * 应用一份问卷的答卷（`answer_questionnaire` 与工单 POST 共用这一条漏斗）。
   *
   * approval 问卷答完即真的改变阶段：批准 → 升格；不批准 → 退回 intake。
   * 否则问卷只是装饰，而「人批过了」这句话仍然是模型自己说的。
   */
  async answerQuestionnaire(input: {
    questionnaireId: string;
    answers: Record<string, string>;
    /** `ticket` = 人在工单页上亲手点的；`tool` = 会话里转述的答复。 */
    source?: AnswerSource;
    /** 作答的成员 id。只有人（不传）或组长能答；见 §8-10。 */
    actorId?: string;
    /** approval 问卷经会话作答时必填的一次性审批码。 */
    code?: string;
  }): Promise<{
    ok: boolean;
    message?: string;
    missing?: string[];
    questionnaire?: QuestionnaireView;
    writtenTo?: string | null;
    sectionMatched?: boolean | null;
  }> {
    const before = this.questionnaires.byId(input.questionnaireId);
    if (before === undefined) {
      return {
        ok: false,
        message: `questionnaire "${input.questionnaireId}" not found; open ones: ${
          this.questionnaires.open.map((record) => record.id).join(', ') || '(none)'
        }`,
      };
    }
    const team = this.teamOf(before.teamId);
    const source = input.source ?? 'tool';
    if (input.actorId !== undefined) {
      const actor = this.memberOf(team, input.actorId);
      if (actor.role !== 'leader') {
        throw new Error(
          `only a human (or the leader relaying one) can answer a questionnaire; ${actor.name} should raise it with ask_human instead`,
        );
      }
    }
    // §8-10：审批不能由模型自己伪造。工单 POST 本身就是人的动作；经会话转述的
    // 批准必须带上只出现在工单页 / 邮件里的一次性码。
    if (before.kind === 'approval' && source === 'tool' && !this.questionnaires.verifyApprovalCode(before.id, input.code ?? '')) {
      return {
        ok: false,
        message:
          'an approval answered in-session must carry the one-time code from the ticket page or email (only a human who read it can approve, §8-10); the leader asks, it does not approve',
        questionnaire: questionnaireViewOf(before),
      };
    }
    const result = this.questionnaires.answer(input.questionnaireId, input.answers, source);
    const record = result.record ?? before;
    if (!result.ok) {
      // 部分答案也要落盘并推快照：人漏答一题时不该在页面上从第一题重答。
      this.changed(team.id);
      this.snapshotPublisher?.();
      return {
        ok: false,
        message: result.message,
        missing: result.missing,
        questionnaire: questionnaireViewOf(record),
      };
    }
    const writeBack = await writeBackAnswers(this.docflow, team, record);
    // interactive 的那一轮还 await 在 ask_human 里，而工单 POST 的调用栈上没有 exec
    // 可以返回 —— 只能在这里主动唤醒它。
    this.settleQuestionnaireWaiter(record, writeBack);
    // 等待期被豁免掉了 git 活动检查，答完要把计时起点拨回现在：否则人想了 40 分钟，
    // 组长一回来任务就被判成「40 分钟没动静」。
    if (record.taskId !== null) {
      const found = this.tryFindTask(record.taskId);
      if (found !== null) found.task.lastActivityAt = Date.now();
    }
    let message =
      record.mode === 'interactive'
        ? '答复已回写，组长正在同一轮里继续。'
        : '答复已回写。异步提问：请回到 dsh 会话里说一句「继续」，组长才会往下走。';
    try {
      await this.afterAnswered(team, record);
    } catch (error) {
      // 审批环节失败（正文与审批码覆盖的内容已不一致）不该把工单页炸成 500：
      // 人要能看到「为什么没批成、接下来批什么」。
      message = this.redactor.redact(error instanceof Error ? error.message : String(error));
    }
    this.changed(team.id);
    this.snapshotPublisher?.();
    return { ok: true, message, questionnaire: questionnaireViewOf(record), ...writeBack };
  }

  /** 答卷收齐后的分流：需求问卷推进阶段，审批问卷真的升格或退回，重规划问卷执行撤回。 */
  private async afterAnswered(team: TeamRecord, record: QuestionnaireRecord): Promise<void> {
    if (record.kind === 'replan') {
      // abort 的执行点（§6.3）：问卷只是提问，人批了这一刻才真的动任务与分支。
      // 兜底答案是 reject —— 没人答的问卷不该变成一次自动放弃。
      if (effectiveAnswers(record).abort === 'approve' && record.taskId !== null) {
        const found = this.tryFindTask(record.taskId);
        if (found !== null) await this.executeReplanAbort(found.team, found.task, record);
      }
      return;
    }
    if (record.kind !== 'approval') {
      // §2.1：需求采集（intake）答完 → 进入「开工包等人批」。组长不能自己
      // setPhase 越过去（autopilot_phase 的说明里写了这条）。
      if (record.kind === 'intake' && teamPhase(team) === 'intake') this.applyPhase(team, 'kickoff_pending_approval');
      return;
    }
    if (record.answers[APPROVAL_QUESTION]?.value === 'approve') {
      await promoteDrafts(this.docflow, team, record, 'human(工单答复)');
      this.questionnaires.consumeApprovalCode(record.id);
      return;
    }
    await resetDraftsToEditable(this.docflow, team);
    this.questionnaires.consumeApprovalCode(record.id);
    this.applyPhase(team, 'intake');
  }

  /**
   * 执行已获人批准的 abort：任务废弃、在途分支删除、接手者释放回个人分支。
   * 与 supersede / continue 不同，这里丢的是**在途工作** —— 所以它只被
   * afterAnswered（人批过的 replan 问卷）调用，没有任何工具能直达。
   */
  private async executeReplanAbort(team: TeamRecord, task: TaskRecord, record: QuestionnaireRecord): Promise<void> {
    const answer = record.answers['abort']?.value ?? '';
    const assignee = team.members.find((member) => member.id === task.assigneeId);
    if (assignee !== undefined && assignee.currentTaskId === task.id) {
      // releaseMemberWorkspace 的第四个调用点（§6.3）：与澄清、合入、升级同一套退场机制。
      await this.releaseMemberWorkspace(assignee);
    }
    // 丢分支：任务分支删掉，base 与成员个人分支不动（破坏性 git 的红线只护共享分支，
    // 任务分支本就允许 prune —— 但这里删的是还没合入的工作，所以前置多了一道人批）。
    await deleteBranch(team.repoPath, task.branch).catch(() => {});
    await this.refreshBranches(team);
    if (task.contractId !== null) {
      await appendTaskNote(
        this.contractPathFor(team, task),
        [
          '',
          renderTaskNote('replan', Date.now(), 'human → abort'),
          ...noteLines(this.redactor.redact(`abort approved: ${answer === '' ? '(no detail)' : answer}`)),
          '',
        ].join('\n'),
      ).catch(() => {});
    }
    task.status = 'cancelled';
    this.touchTask(task);
    await this.updateContractStatus(team, task, 'cancelled');
    this.changed(team.id);
  }

  /**
   * `doc_approve` 的后端。两条合法来源（§8-10）：人带一次性码在会话里调，或人自己
   * 不带 `actorId` 直接调；主体（码校验 + sha256 比对升格）在 `service/docflow.ts`，
   * 这里只补状态变更通知。
   */
  async docApprove(input: { teamId: string; code?: string; actorId?: string }): Promise<PromoteResult> {
    const result = await docApproveFlow(this.docflow, input);
    this.changed(input.teamId);
    return result;
  }

  /**
   * `doc_write` 的后端：AI 写文档**只进 draft 区**（§4.1）。draft 区校验、审批
   * 作废与提交在 `service/docflow.ts`；这里只补状态变更通知。
   */
  async docWrite(input: { teamId: string; path: string; body: string }): Promise<{
    path: string;
    status: DocStatus;
    version: string;
    sha256: string;
    approvalsCancelled: string[];
  }> {
    const result = await docWriteFlow(this.docflow, input);
    this.changed(input.teamId);
    return result;
  }

  /**
   * `contract_create` 的后端（§4.4）：**写前**校验，不合法就指名道姓地抛错，
   * 绝不留半个文件在盘上等收养链路出丑。合法契约下一个 tick 由 `syncContracts`
   * 正常收养，不需要第二次人工动作。
   */
  async contractCreate(input: { teamId: string; contracts: ContractDraft[] }): Promise<{ created: { id: string; path: string }[] }> {
    const team = this.teamOf(input.teamId);
    if (input.contracts.length === 0) throw new Error('contract_create needs at least one contract');
    const { contracts: existing } = await loadTaskContracts(team.repoPath);
    const knownIds = existing.map((contract) => contract.id);
    const batchIds = input.contracts.map((draft) => draft.id.trim());
    const threshold = this.options.profile.crossDomainThreshold;
    const errors: string[] = [];
    for (const draft of input.contracts) {
      const per = validateContractDraft(draft, {
        knownIds,
        batchIds,
        globalForbidden: this.options.security.forbiddenPaths,
      });
      // 建一张注定在首拍就被 escalateCrossDomain 打回的同判据校验：白跑一轮派发
      // 是最贵的失败（判据与两条派发路径共用 domainLimitStatus）。
      const { domainCount, exceeded } = domainLimitStatus(draft.touches ?? [], threshold);
      if (exceeded) {
        per.push(`touches span ${domainCount} distinct domains (limit ${threshold}); split it per domain`);
      }
      if (per.length > 0) errors.push(`${draft.id.trim() || '(missing id)'}: ${per.join('; ')}`);
    }
    errors.push(...validateContractBatch(input.contracts, existing));
    if (errors.length > 0) {
      throw new Error(`contract_create refused, nothing was written:\n- ${errors.join('\n- ')}`);
    }
    const created: { id: string; path: string }[] = [];
    for (const draft of input.contracts) {
      const id = draft.id.trim();
      // id 已经过 CONTRACT_ID_RE，这里只是把路径收口统一交给 repoFile 再验一遍。
      const relative = join(TASKS_DIR, `${id}.md`);
      const absolute = repoFile(team.repoPath, relative);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, this.redactor.redact(renderContractFile(draft)), 'utf8');
      created.push({ id, path: relative.replace(/\\/g, '/') });
    }
    await this.syncBoard(team);
    await this.commitTasksDir(team, `tasks: create ${created.map((item) => item.id).join(', ')}`);
    this.changed(team.id);
    return { created };
  }

  /** 内部阶段推进（不经过 `autopilot_phase` 那个裸开关）。 */
  private applyPhase(team: TeamRecord, phase: TeamPhase): void {
    team.phase = phase;
  }

  /** 把还在等人的问卷清单摊给 `autopilot_status` 与面板。 */
  private awaitingHuman(): Record<string, unknown>[] {
    return this.questionnaires.open.map((record) => ({
      id: record.id,
      teamId: record.teamId,
      kind: record.kind,
      mode: record.mode,
      title: record.title,
      taskId: record.taskId,
      ticketUrl: record.ticketUrl,
      mailDelivered: record.mailDelivered,
      expiresAt: record.expiresAt,
      questions: record.questions.map((question) => question.label),
    }));
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
    // interactive 的 await 不能被我抛下：计时器留着会让进程舍不得退出，而重启后
    // 「这轮还在等人」是假象 —— 把问卷标成 expired 放行，组长重新问一次才是真的。
    for (const [id, waiter] of this.questionnaireWaiters) {
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      const record = this.questionnaires.byId(id);
      if (record !== undefined) {
        this.questionnaires.expire(id);
        waiter.settle({ record, writeBack: { writtenTo: null, sectionMatched: null } });
      }
    }
    this.questionnaireWaiters.clear();
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
    // 卸载后 session 可能已经销毁，留着发布器等于留着一个会炸的句柄。
    this.snapshotPublisher = undefined;
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
      // 问卷带着审批码一起恢复：那次审批可能正等人批，作废它等于把人做的事抹掉。
      this.questionnaires.restore(state.questionnaires ?? []);
      // 凭据表同样要跨重启存活：邮件里那条链接已经发出去了，换一枚 token 就等于
      // 把已经叫来的人关在门外。老 state.json 没这个字段，`?? {}` 兜底。
      for (const [id, token] of Object.entries(state.ticketTokens ?? {})) this.ticketTokens.set(id, token);
      this.deploys = state.deploys ?? [];
      // 崩崩恢复的硬规则：持久化的 running 一律降级为 paused，等人来 resume。
      this.loopState = state.loopState === 'running' ? 'paused' : (state.loopState ?? 'stopped');
      this.tick = state.tick ?? 0;
      this.bootstrapped = state.bootstrapped ?? false;
      this.lastDeployBaseSha = state.lastDeployBaseSha ?? null;
      for (const team of this.teams.values()) {
        // 老state.json 没有 metrics 字段：读取处归一化兜底，之后所有埋点都可直接写。
        team.metrics ??= emptyTeamMetrics();
        team.branches = await listBranches(team.repoPath).catch(() => team.branches);
      }
    } catch {
      // 状态文件损坏：宁可空着启动，也不能把宿主进程带崩。但必须先把它留在磁盘上 ——
      // 否则解析失败 + 随后的正常 persist 会用空状态覆盖掉唯一一份历史，等价于
      // 静默删掉全部团队、任务与升级记录。
      this.teams.clear();
      this.activeTeamId = null;
      this.escalations.restore([]);
      this.questionnaires.restore([]);
      this.ticketTokens.clear();
      this.deploys = [];
      this.lastDeployBaseSha = null;
      await rename(this.stateFile, `${this.stateFile}.corrupt-${Date.now()}`).catch(() => {});
    }
  }

  private snapshot(): PersistedState {
    return {
      version: 1,
      teams: [...this.teams.values()],
      activeTeamId: this.activeTeamId,
      escalations: [...this.escalations.all],
      questionnaires: [...this.questionnaires.all],
      // 只写还答得动的工单：答完、过期、作废之后，token 留着只是给未来的攻击面
      // 留库存，而记录本身要留在 state.json 里做审计。派生而不是原地删，是为了
      // 让"内存里那把表"与"磁盘上那份视图"各自清楚。
      ticketTokens: Object.fromEntries([...this.ticketTokens].filter(([id]) => this.ticketAnswerable(id))),
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

  /**
   * 登记/取消「带外快照推送」回调。
   *
   * 存在的理由是有一类变更不在任何工具调用栈里：工单答卷由 TicketServer 的 HTTP
   * 回调处理，那时没有 `exec`，也就没人往 session 追加 `autopilot/update` —— 人答完
   * 问卷，面板要等到下一次工具调用才刷新。插件层（唯一看得见 session 的地方）在这里
   * 登记回调，核心侧只认一个无参函数，不 import 任何 session 类型。
   */
  setSnapshotPublisher(publish: (() => void) | undefined): void {
    this.snapshotPublisher = publish;
  }

  private changed(teamId?: string): void {
    if (teamId !== undefined) this.activeTeamId = teamId;
    this.persist();
    for (const listener of this.listeners) listener();
  }

  // ── 视图 ──────────────────────────────────────────────────────────────────
  //
  // 视图映射的实体在 service/views.ts（纯函数、可独立单测）；这里只保留薄委托
  // 与 teamView 的组装（它还要就地补零 metrics、折算 learnings 视图）。

  private memberView(member: MemberRecord): MemberView {
    return memberViewOf(member);
  }

  private taskView(team: TeamRecord, task: TaskRecord): TaskView {
    return taskViewOf(team, task);
  }

  private reviewView(team: TeamRecord, review: ReviewRecord): ReviewView {
    return reviewViewOf(team, review);
  }

  teamView(teamId: string): TeamView {
    const team = this.teamOf(teamId);
    return {
      id: team.id,
      name: team.name,
      repoPath: team.repoPath,
      baseBranch: team.baseBranch,
      phase: teamPhase(team),
      branches: [...team.branches],
      members: team.members.map((member) => this.memberView(member)),
      tasks: team.tasks.map((task) => this.taskView(team, task)),
      reviews: team.reviews.map((review) => this.reviewView(team, review)),
      learnings: (team.learnings ?? []).map((record) => viewOf(record)),
      metrics: this.teamMetrics(team),
      createdAt: team.createdAt,
    };
  }

  memberSystemPrompt(teamId: string, memberId: string): string {
    return this.memberOf(this.teamOf(teamId), memberId).systemPrompt;
  }

  /** 全量状态投影快照——推给 Web 面板的值。 */
  projection(): AutopilotProjection {
    const blocked: string[] = [];
    for (const team of this.teams.values()) {
      for (const task of team.tasks) {
        if (HELD_STATUSES.includes(task.status)) blocked.push(task.id);
      }
    }
    return {
      loopState: this.loopState,
      teams: [...this.teams.keys()].map((id) => this.teamView(id)),
      activeTeamId: this.activeTeamId,
      escalations: [...this.escalations.all],
      // 走 questionnaireViews() 而不是 manager.all：审批码是服务侧凭据，
      // 进快照就等于进模型读得到的 session 日志。
      questionnaires: this.questionnaireViews(),
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
    // 错误文案的唯一出处是 requireTeamMember —— 视图层也用它，别处再写第二份迟早漂移。
    return requireTeamMember(team, memberId);
  }

  /** 团队指标（缺则就地补零）：所有埋点与视图组装都走这里，避免各处判空。 */
  private teamMetrics(team: TeamRecord): TeamMetrics {
    return (team.metrics ??= emptyTeamMetrics());
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

  /**
   * remoteEnv 的作用域包装：无论块内成败，SSH 临时密钥都在块尾清理。
   * 以前四处各写一份 try/finally —— 手工 finally 恰恰是密钥泄漏最爱藏的地方。
   */
  private async withRemoteEnv<T>(run: (env: Record<string, string> | undefined) => Promise<T>): Promise<T> {
    const { env, cleanup } = await this.remoteEnv();
    try {
      return await run(env);
    } finally {
      await cleanup();
    }
  }

  /** 用远端凭据推送分支，并保证临时 SSH key 一定被清理。 */
  private async pushWithRemoteEnv(team: TeamRecord, branch: string): Promise<void> {
    await this.withRemoteEnv((env) => pushBranch(team.repoPath, branch, { env }));
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
    // loadTaskContracts 现在自己就不抛错（坏文件逐个进 rejected），这层壳不再需要。
    const { contracts } = await loadTaskContracts(team.repoPath);
    await regenerateBoard(team.repoPath, contracts).catch(() => {});
  }

  /**
   * 提交 .tasks/ 的改动，让集成检出始终保持干净、可合并
   * （best effort：没有 .tasks 目录时是空操作）。
   */
  private async commitTasksDir(team: TeamRecord, message: string): Promise<void> {
    await commitAll(team.repoPath, [TASKS_DIR], message).catch(() => {});
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
    await this.withRemoteEnv(async (env) => {
      await rm(team.repoPath, { recursive: true, force: true });
      await cloneRemote(this.options.remote.url, team.repoPath, team.baseBranch, env);
    });
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
      await this.withRemoteEnv((env) => cloneRemote(this.options.remote.url, repoPath, this.options.baseBranch, env));
    } else {
      await ensureRepo(repoPath, this.options.baseBranch);
    }
    const team: TeamRecord = {
      id,
      name: input.name,
      repoPath,
      workspaceRoot,
      baseBranch: this.options.baseBranch,
      // 显式落盘而不是留给 ?? 兜底：state.json 里的 phase 应当是事实，
      // 而不是"缺省所以没写"。新团队从 intake 起步属 M1 的流程策略。
      phase: 'developing',
      branches: await listBranches(repoPath),
      members: [],
      tasks: [],
      reviews: [],
      metrics: emptyTeamMetrics(),
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
    const { domainCount, exceeded } = domainLimitStatus(
      contract?.touches ?? [],
      this.options.profile.crossDomainThreshold,
    );
    if (exceeded) {
      throw new Error(
        `task "${input.title}" touches ${domainCount} distinct domains (limit ${this.options.profile.crossDomainThreshold}); ` +
          `split it into per-domain tasks or escalate for a cross-domain change`,
      );
    }
    // 契约自洽检查：touches 不得踩到契约自己声明的 forbidden 禁区 —— 派发期就
    // 拦下，否则违规任务要白跑一整轮门和评审才被远端 CI 拦。
    const forbiddenHits = forbiddenTouchesViolation(contract?.touches ?? [], contract?.forbidden ?? []);
    if (forbiddenHits.length > 0) {
      throw new Error(
        `task "${contract?.title ?? input.title}" touches paths its own contract declares forbidden: ${forbiddenHits.join(', ')} — narrow the touches, or split the forbidden change into a separately approved contract`,
      );
    }
    const branch = renderBranchName(this.options.profile.branchTemplate, destination, contract?.title ?? input.title);
    await createBranch(team.repoPath, branch, team.baseBranch);
    await checkout(assignee.workspacePath, branch);
    const now = Date.now();
    const rawDescription = input.description ?? contract?.body ?? '';
    const task = createTaskRecord({
      id,
      contract,
      title: input.title,
      branch,
      assigneeId: assignee.id,
      description: this.buildDescription(team, rawDescription, contract?.touches ?? []),
      now,
    });
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
    const { contracts } = await loadTaskContracts(team.repoPath);
    const contract = contracts.find((candidate) => candidate.id === contractId);
    if (contract === undefined) {
      throw new Error(
        `no task contract "${contractId}" in ${join(team.repoPath, TASKS_DIR)}; known: ${contracts.map((c) => c.id).join(', ') || '(none)'}`,
      );
    }
    return contract;
  }

  /**
   * 手动推进任务状态（可选），或调整派发优先级（M3 §6.2「调 priority」，组长自主）。
   * status 只允许在 pending / in_progress / in_review 之间切换：done 与
   * changes_requested 归评审流程所有，needs-human 归升级流程所有，
   * needs-clarification 由 task_clarify 进入、由 leader 在这里回答后退出。
   *
   * `note` 会作为留言写进任务契约 —— leader 的澄清答案就靠这条落地。
   */
  async updateTask(input: {
    taskId: string;
    status?: 'pending' | 'in_progress' | 'in_review';
    /** 派发排序权重（越大越先派，只在依赖条件相同的任务间生效）。 */
    priority?: number;
    note?: string;
    /** 操作者（成员 id）。从待澄清解回 pending 时校验必须是 leader。 */
    actorId?: string;
  }): Promise<TaskView> {
    const { team, task } = this.findTask(input.taskId);
    if (input.status === undefined && input.priority === undefined && (input.note === undefined || input.note === '')) {
      throw new Error('task_update needs something to change: pass status, priority or note');
    }
    const heldForClarification = task.status === 'needs-clarification';
    if (heldForClarification) {
      // 澄清只能由提出方之外的角色回答：developer 自己把任务解回去，就等于
      // 用「问一句」绕过了返工轮次预算。未传 actorId 视为人工在直接操作。
      if (input.actorId !== undefined) {
        const actor = this.memberOf(team, input.actorId);
        if (actor.role !== 'leader') {
          throw new Error(`task "${task.title}" is waiting for the leader to clarify; only leader (or a human) can answer`);
        }
      }
    }
    if (input.note !== undefined && input.note !== '' && task.contractId !== null) {
      // 必须先确认绑定了契约：无契约时 contractPathFor 会拼出一个不存在的路径，
      // 而 appendTaskNote 是"读失败当空文件再写"，会凭空造出一个没有 frontmatter
      // 的 .md —— 它会被 loadTaskContracts 判为坏文件跳过并升级告警（见 syncContracts），
      // 但一个凭空多出来的契约文件仍然会污染看板和后续收养。
      const author = input.actorId === undefined ? 'human' : this.memberOf(team, input.actorId).name;
      const kind = heldForClarification ? 'clarify-answer' : 'note';
      await appendTaskNote(
        this.contractPathFor(team, task),
        ['', renderTaskNote(kind, Date.now(), author), ...noteLines(this.redactor.redact(input.note))].join('\n'),
      ).catch(() => {});
    }
    if (input.status !== undefined) task.status = input.status;
    if (input.priority !== undefined) task.priority = input.priority;
    this.touchTask(task);
    // 优先级是契约 frontmatter 的一部分：改了要同步回契约文件，否则人工翻文件
    // （或下次以契约为准的重建）看到的还是旧权重。status 的契约回写维持既有口径
    // —— 只有从待澄清解回时才写（见下）。
    if (input.priority !== undefined && task.contractId !== null) {
      await patchTaskContract(this.contractPathFor(team, task), { priority: input.priority }).catch(() => {});
      await this.syncBoard(team);
      await this.commitTasksDir(team, 'tasks: board update');
    }
    if (heldForClarification && input.status !== undefined) {
      // 必须把契约一起回写：否则 syncContracts 看到「内存已解、契约还挂着」，
      // 会把它当人工放行再重开一遍。updateContractStatus 顺带刷看板并提交。
      await this.updateContractStatus(team, task, input.status, null);
    }
    this.changed(team.id);
    return this.taskView(team, task);
  }

  /**
   * developer 把任务退回 leader 澄清：契约本身含糊或自相矛盾时，这条路比
   * escalate 便宜得多 —— **不消耗返工轮次、不产生升级、不打 needs-human**。
   * 理由：打回的常见根源是 leader 写的契约有歧义，轮次惩罚不该落在 developer 头上。
   */
  async clarifyTask(input: {
    taskId: string;
    memberId: string;
    question: string;
    ambiguousPoints?: string[];
    proposedResolutions?: string[];
  }): Promise<TaskView> {
    const { team, task } = this.findTask(input.taskId);
    const member = this.memberOf(team, input.memberId);
    if (member.role === 'reviewer' || member.role === 'operator') {
      throw new Error(`${member.role}s do not implement tasks; only a developer can ask for clarification`);
    }
    if (task.status !== 'in_progress' && task.status !== 'changes_requested') {
      throw new Error(
        `task "${task.title}" is ${task.status}; only a task you are working on (or reworking) can be clarified`,
      );
    }
    const leader = team.members.find((candidate) => candidate.role === 'leader');
    if (leader === undefined) throw new Error('team has no leader to clarify this task');
    const note = [
      '',
      renderTaskNote('needs-clarification', Date.now(), `${member.name} → ${leader.name}`),
      ...noteLines(this.redactor.redact(input.question)),
      ...(input.ambiguousPoints ?? []).map((point) => `> - ambiguous: ${this.redactor.redact(point)}`),
      ...(input.proposedResolutions ?? []).map((option) => `> - proposed: ${this.redactor.redact(option)}`),
      '',
    ].join('\n');
    if (task.contractId !== null) await appendTaskNote(this.contractPathFor(team, task), note).catch(() => {});
    task.status = 'needs-clarification';
    // 刻意不动 reviewRound：问清楚不是返工。
    await this.updateContractStatus(team, task, 'needs-clarification');
    // 释放接手者的工作区，让他能立刻接下一个任务，而不是挂着等答案。
    if (member.currentTaskId === task.id) await this.releaseMemberWorkspace(member);
    this.touchTask(task);
    this.changed(team.id);
    return this.taskView(team, task);
  }

  // ── 需求变更与重规划（M3，docs/design-interaction.md §6）──────────────────
  //
  // 分级表（§6.2）在这里落地为两条边界：
  // - 新增 pending 契约（contract_create）、调 priority（task_update）、取消
  //   未派发的 pending（task_cancel）→ 组长自主，不升级、不发通知；
  // - 撤回在途工作（abort = 丢分支）→ 强制 kind:'replan' 问卷，人批之前不落盘。
  // 另一条硬边界是"越级改验收数值的路径不存在"：契约正文没有任何工具能改，
  // doc_write 只收 draft 区 —— 组长能做的是废弃 + 派生新契约，而不是偷改旧验收。

  /**
   * 重规划频率上限（§6.5）：单位时间 replan 调用超 `replan.maxPerHour` 即拒绝。
   * 「无限重排」是模型自己察觉不到的失败模式 —— 它每一步看起来都合理，
   * 只有外部的预算能拦住它。0 = 不设限。
   */
  private assertReplanBudget(teamId: string): void {
    const max = this.options.replan.maxPerHour;
    if (!(max > 0)) return;
    const now = Date.now();
    const window = (this.replanCalls.get(teamId) ?? []).filter((at) => now - at < 3_600_000);
    if (window.length >= max) {
      throw new Error(
        `replan rate limit: ${window.length} replanning calls in the last hour (max ${max}); ` +
          `stop re-sorting the plan and let it breathe — if this change really must land now, ask a human with ask_human instead`,
      );
    }
    window.push(now);
    this.replanCalls.set(teamId, window);
  }

  /**
   * `task_cancel` 的后端：废弃一张**尚未派发**的 pending 任务（§6.1）。
   * 契约文件保留不删（frontmatter 改 `cancelled`，随 git 历史可追溯）；
   * 不产生升级、不发通知 —— 这是分级表里的自主档。在途任务的撤回走
   * `task_replan(disposition:'abort')`，那条路要人批。
   */
  async taskCancel(input: { taskId: string; reason?: string }): Promise<TaskView> {
    const { team, task } = this.findTask(input.taskId);
    if (task.status !== 'pending') {
      throw new Error(
        `task "${task.title}" is ${task.status}; only an undispatched pending task can be cancelled — ` +
          `withdraw an in-flight one with task_replan(disposition:"abort")`,
      );
    }
    this.assertReplanBudget(team.id);
    task.status = 'cancelled';
    this.touchTask(task);
    if (input.reason !== undefined && input.reason !== '' && task.contractId !== null) {
      await appendTaskNote(
        this.contractPathFor(team, task),
        ['', renderTaskNote('replan', Date.now(), 'leader'), ...noteLines(this.redactor.redact(input.reason))].join('\n'),
      ).catch(() => {});
    }
    await this.updateContractStatus(team, task, 'cancelled');
    this.changed(team.id);
    return this.taskView(team, task);
  }

  /** 重规划对在途任务的三种处置（§6.3）。 */
  async replanTask(input: {
    taskId: string;
    disposition: 'supersede' | 'continue' | 'abort';
    /** 这次需求变更改了什么：写进原契约留言，abort 时进问卷标题。 */
    changeNote: string;
    /** supersede / continue 派生的承接契约；缺省字段回落原任务。 */
    followup?: {
      title?: string;
      body?: string;
      owner?: string;
      touches?: string[];
      forbidden?: string[];
      dependsOn?: string[];
      priority?: number;
    };
  }): Promise<{ disposition: string; followup?: { id: string; path: string }; questionnaire?: QuestionnaireView }> {
    const { team, task } = this.findTask(input.taskId);
    if (task.status !== 'in_progress' && task.status !== 'in_review') {
      throw new Error(
        `task "${task.title}" is ${task.status}; the three replan dispositions apply to in-flight tasks — ` +
          `cancel an undispatched one with task_cancel instead`,
      );
    }
    this.assertReplanBudget(team.id);
    if (input.disposition === 'abort') {
      return { disposition: 'abort', questionnaire: await this.openAbortQuestionnaire(team, task, input.changeNote) };
    }
    const followup = input.followup;
    if (followup === undefined) {
      throw new Error(
        `disposition "${input.disposition}" derives a follow-up contract; pass followup {title/body/...} — ` +
          `supersede lets the original land as-is and routes the correction through a NEW contract, it never rewrites the old acceptance criteria`,
      );
    }
    if (task.contractId === null) {
      throw new Error(`task "${task.title}" has no contract to derive a follow-up from`);
    }
    const followupId = await this.deriveFollowupId(team, task.contractId);
    const created = await this.contractCreate({
      teamId: team.id,
      contracts: [
        {
          id: followupId,
          title: followup.title ?? `${task.title}（${input.disposition} 修正）`,
          owner: followup.owner ?? 'leader',
          // supersede 的修正在原任务合入之后才有意义；continue 的增量不阻塞在它后面。
          dependsOn: followup.dependsOn ?? (input.disposition === 'supersede' ? [task.contractId] : []),
          touches: followup.touches ?? task.touches,
          forbidden: followup.forbidden ?? [],
          ...(followup.priority !== undefined ? { priority: followup.priority } : {}),
          body:
            followup.body ??
            `需求变更（原契约 ${task.contractId}）\n\n${input.changeNote}\n\n> 本契约由 task_replan(${input.disposition}) 自动派生；Gherkin 验收标准由组长补齐后再派发。`,
        },
      ],
    });
    // 契约先落（写前校验，失败即什么都不留），再补原任务的变更留言。
    const note = [
      '',
      renderTaskNote('replan', Date.now(), `leader → ${input.disposition}`),
      ...noteLines(this.redactor.redact(input.changeNote)),
      '',
    ].join('\n');
    await appendTaskNote(this.contractPathFor(team, task), note).catch(() => {});
    await this.commitTasksDir(team, `tasks: replan ${input.disposition} on ${task.contractId}`);
    this.changed(team.id);
    return { disposition: input.disposition, followup: created.created[0] };
  }

  /**
   * supersede / continue 派生契约的 id：沿用原契约的域前缀取下一个空号。
   * 磁盘是真相源 —— 只扫 `.tasks/` 里的现存契约，不内存里猜。
   */
  private async deriveFollowupId(team: TeamRecord, contractId: string): Promise<string> {
    const domain = /^([A-Z][A-Z0-9]*)-\d+$/.exec(contractId)?.[1];
    if (domain === undefined) {
      throw new Error(`contract id "${contractId}" does not follow <DOMAIN>-<number>; cannot derive a follow-up id`);
    }
    return `${domain}-${await this.nextContractSeq(team, domain)}`;
  }

  private async nextContractSeq(team: TeamRecord, domain: string): Promise<number> {
    const { contracts } = await loadTaskContracts(team.repoPath);
    const prefix = `${domain}-`;
    let max = 0;
    for (const contract of contracts) {
      if (!contract.id.startsWith(prefix)) continue;
      const seq = Number(contract.id.slice(prefix.length));
      if (Number.isInteger(seq) && seq > max) max = seq;
    }
    return max + 1;
  }

  /** abort 的问卷：人批之前不落盘（§6.3）——问题不答，任务与分支分毫不动。 */
  private async openAbortQuestionnaire(team: TeamRecord, task: TaskRecord, changeNote: string): Promise<QuestionnaireView> {
    const record = (
      await this.askHuman({
        teamId: team.id,
        kind: 'replan',
        title: `重规划确认：放弃「${task.title}」的在途工作`,
        taskId: task.id,
        binding: task.contractId === null ? null : { type: 'task', contractId: task.contractId },
        questions: [
          {
            name: 'abort',
            label: `是否放弃这个任务的在途工作并丢弃其分支？变更背景：${oneLine(changeNote)}`,
            type: 'select',
            options: [
              {
                value: 'approve',
                label: '放弃：任务废弃、分支删除（丢分支 = 丢工作）',
                impact: '在途未合入的提交随之作废；原契约以 cancelled 保留',
                recommended: false,
              },
              {
                value: 'reject',
                label: '不放弃：任务照常继续',
                impact: '任务与分支都保持原样，继续走正常的评审合入',
                recommended: false,
              },
            ],
            required: true,
            // 超时兜底也是它：一张没人答的问卷不该变成一次自动放弃。
            defaultValue: 'reject',
          },
        ],
      })
    ).questionnaire;
    return record;
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
        // 手工合并同样要过禁区闸门，否则这是一条绕过 pr_sync 检查的旁路。
        await this.assertNoForbiddenChanges(team, branch, target, null);
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
    const metrics = this.teamMetrics(team);
    metrics.gateRuns += 1;
    if (!summary.allPassed) metrics.gateFailures += 1;
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
    /** reviewer 判定"这轮打回是契约本身含糊"，供知识回路与澄清通道分类。 */
    contractAmbiguity?: boolean;
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
      await this.assertDiffSizeAllowed(team, task);
      // 合并进 base 之前必须查禁区：质量门全绿不代表可以改写禁区。
      await this.assertNoForbiddenChanges(team, task.branch, team.baseBranch, task.id);
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
      task.completedAt = Date.now();
      this.teamMetrics(team).completed += 1;
      await this.updateContractStatus(team, task, 'done');
      // 让开发者的个人分支跟上刚合入的 base，再回到空闲。
      await this.releaseMemberWorkspace(assignee, team);
      if (this.hasRemote) await this.pushWithRemoteEnv(team, team.baseBranch);
    } else {
      task.status = 'changes_requested';
      task.reviewRound += 1;
      this.teamMetrics(team).reviewRounds += 1;
      assignee.status = 'working';
      // 评审意见必须落到任务单上 —— 换任接手者（或下一场会话）要看得见
      // 上一轮为什么被打回，只改内存字段等于知识泄漏。
      if (task.contractId !== null) {
        const quoted = this.redactor
          .redact(review.comments)
          .split('\n')
          .map((line) => `> ${line}`);
        await appendTaskNote(
          this.contractPathFor(team, task),
          [
            '',
            renderTaskNote('review', review.createdAt, `round ${task.reviewRound} (${reviewer.name})`),
            ...quoted,
            '',
          ].join('\n'),
        ).catch(() => {});
        // updateContractStatus 顺带重生成看板并提交 .tasks/。
        await this.updateContractStatus(team, task, 'changes_requested');
      }
      await this.captureLearning(team, {
        kind: 'review-change-request',
        summary: review.comments,
        detail: review.comments,
        touches: task.touches,
        taskId: task.id,
        contractId: task.contractId,
        ...(input.contractAmbiguity === true ? { bucket: 'contract-ambiguity' as LearningBucket } : {}),
      });
    }
    this.touchTask(task);
    await this.refreshBranches(team);
    this.changed(team.id);
    return { review: this.reviewView(team, review), task: this.taskView(team, task), merged };
  }

  /** approve 前的硬校验：质量门与远端 CI 各自是一道独立的门，互不短路。 */
  private assertMergeAllowed(task: TaskRecord): void {
    if (this.options.security.pushRequiresGates) {
      const gates = task.gates;
      if (gates === null || !gates.allPassed) {
        throw new Error(
          `cannot approve: quality gates are not green for task "${task.title}" — run gates_run first and make every gate pass`,
        );
      }
    }
    this.assertCiGreen(task);
  }

  /**
   * `requireCiGreen` 独立于 `pushRequiresGates` 生效（不被它短路）。
   * 判定：CI 必须**真验证过** —— `ciStatus === null`（从未 pr_sync）视为未验证
   * 即拒，与 tools.ts 给模型的承诺一致。
   *
   * 只在 CI 真能查到的平台上门禁：`checkRunStatus` 只有 github 适配，其它平台
   * `pr_sync` 恒置 `'unknown'`，把它当未绿会让默认配置永远无法 approve。
   * 无法验证不等于验证通过，所以 README 里明确要求：非 github 平台请自行关掉
   * `requireCiGreen`。
   */
  private assertCiGreen(task: TaskRecord): void {
    if (!this.options.gates.requireCiGreen || !this.hasRemote) return;
    if (this.options.remote.platform !== 'github') return;
    if (task.ciStatus === 'success') return;
    throw new Error(
      task.ciStatus === null
        ? `cannot approve: requireCiGreen is on but CI was never checked for "${task.title}" — run pr_sync to push the branch and poll CI`
        : `cannot approve: remote CI status is "${task.ciStatus}" — wait for CI to go green (pr_sync polls it)`,
    );
  }

  /**
   * approve 前的改动体量门：单个任务的 `base..branch` 累计增删行数 / 变更文件数
   * 超过 `daemon.maxDiffLines` / `maxDiffFiles` 时不许 approve。
   *
   * 动机是大 diff 的浅审属于静默失败 —— reviewer 看了 3000 行然后 approve，
   * 面板上看不出任何异常。超限一律升级，让人决定是拆任务还是放宽上限。
   * 两个上限都是 0 时整道门关闭（默认），行为与不设时逐字节一致。
   */
  private async assertDiffSizeAllowed(team: TeamRecord, task: TaskRecord): Promise<void> {
    const maxLines = this.options.daemon.maxDiffLines;
    const maxFiles = this.options.daemon.maxDiffFiles;
    if (maxLines <= 0 && maxFiles <= 0) return;
    // 用本地 base 而不是 origin/base：评审时合并基线可能还没 push。
    const baseSha = await resolveRef(team.repoPath, team.baseBranch);
    const branchSha = await resolveRef(team.repoPath, task.branch);
    if (baseSha === null || branchSha === null) return;
    const stat = await diffShortstat(team.repoPath, baseSha, branchSha);
    const lines = stat.insertions + stat.deletions;
    const exceeded: string[] = [];
    if (maxLines > 0 && lines > maxLines) exceeded.push(`${lines} changed lines (limit ${maxLines})`);
    if (maxFiles > 0 && stat.files > maxFiles) exceeded.push(`${stat.files} changed files (limit ${maxFiles})`);
    if (exceeded.length === 0) return;
    await this.escalateTask({
      taskId: task.id,
      reason: 'change-too-large',
      message: `task "${task.title}" changes ${exceeded.join('; ')}`,
      suggestion: 'split the contract into per-domain tasks sized within daemon.maxDiffLines/maxDiffFiles, or have a human approve landing it as-is',
    });
    throw new Error(
      `cannot approve: ${exceeded.join('; ')} — the task was escalated as change-too-large instead of merged`,
    );
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

  // ── 知识回路（learnings） ─────────────────────────────────────────────────

  /** 生效的知识回路配置；用户只写部分字段时与默认值合并。 */
  private learningOptions(): LearningOptions | undefined {
    const raw = this.options.learnings;
    return raw === undefined ? undefined : { ...DEFAULT_LEARNINGS, ...raw };
  }

  /**
   * 内部唯一的捕获入口（评审打回、升级、learning_record 工具都走这里）。
   *
   * 结论与原文在此统一脱敏并截断 —— tools.ts 一行脱敏都不做，安全硬规则只能
   * 在服务侧落地。默认关闭时直接返回 null：不改状态、不写文件。
   */
  private async captureLearning(team: TeamRecord, input: LearningInput): Promise<LearningView | null> {
    const options = this.learningOptions();
    if (options === undefined || options.enabled !== true) return null;
    const summary = clip(this.redactor.redact(oneLine(input.summary)), 200) || input.kind;
    const detail = clip(this.redactor.redact(input.detail), LEARNING_DETAIL_LIMIT);
    const { records, learning } = applyLearning(team.learnings ?? [], { ...input, summary, detail }, options, shortId('learn'));
    team.learnings = records;
    await this.syncLearningsFile(team);
    this.changed(team.id);
    return viewOf(learning);
  }

  /**
   * 全量重写 `<stateDir>/learnings.md`（生成物，勿手改 —— 所以刻意不给任何工具
   * 「编辑这个文件」的能力）。
   *
   * 落在 stateDir 而不是目标仓库的 `.tasks/`：这是插件的运行态输出，按 AGENTS.md
   * 的约定绝不入库。文件只是给人看的便利视图，真相源始终在 state.json、注入走内存记录，
   * 所以写盘失败可以忽略（catch 掉），但状态变更本身必须照常落盘。
   */
  private async syncLearningsFile(team: TeamRecord): Promise<void> {
    const markdown = renderLearningsFile(team.learnings ?? []);
    await writeFile(join(this.options.stateDir, LEARNINGS_ARTIFACT), markdown, 'utf8').catch(() => {});
  }

  /**
   * 组装任务描述。委托给 `service/description.ts` 的纯函数（注入顺序与预算
   * 优先级见该模块的说明）。
   *
   * 这是 task.description 的唯一生产者（assignTask 与 adoptPendingContract 共用），
   * 所以注入只需这一处即可覆盖工具驱动与循环驱动两条派发路径。
   */
  private buildDescription(team: TeamRecord, raw: string, touches: readonly string[]): string {
    return buildDescription({
      raw,
      touches,
      learnings: team.learnings ?? [],
      profile: this.options.profile,
      learningOptions: this.learningOptions(),
    });
  }

  /** 定位学习记录归属的团队：任务 > 显式 teamId > 第一个团队。 */
  private learningTeamFor(taskId: string | null | undefined, teamId: string | undefined): TeamRecord | null {
    if (typeof taskId === 'string') {
      const found = this.tryFindTask(taskId);
      if (found !== null) return found.team;
    }
    if (teamId !== undefined) return this.teamOf(teamId);
    return [...this.teams.values()][0] ?? null;
  }

  /** learning_record 工具的落点：让任意成员主动记一条可复用的坑。 */
  async learningRecord(input: {
    teamId?: string;
    taskId?: string;
    kind: LearningKind;
    summary: string;
    detail?: string;
    touches?: string[];
    bucket?: LearningBucket;
  }): Promise<LearningView | null> {
    const team = this.learningTeamFor(input.taskId, input.teamId);
    if (team === null) throw new Error('no team yet — nothing to record a lesson against');
    const task = typeof input.taskId === 'string' ? this.tryFindTask(input.taskId)?.task : undefined;
    return this.captureLearning(team, {
      kind: input.kind,
      summary: input.summary,
      detail: input.detail ?? input.summary,
      touches: input.touches ?? task?.touches ?? [],
      taskId: task?.id ?? null,
      contractId: task?.contractId ?? null,
      ...(input.bucket !== undefined ? { bucket: input.bucket } : {}),
    });
  }

  /** learning_list 工具的落点：查当前沉淀，并报告待升格（hits 已达门槛、尚未落文档）的数量。 */
  learningList(input: { teamId?: string; touches?: string[]; kind?: LearningKind; limit?: number }): {
    items: LearningView[];
    total: number;
    pendingPromotion: LearningView[];
  } {
    const team = this.learningTeamFor(null, input.teamId);
    const records = team === null ? [] : team.learnings ?? [];
    const options = this.learningOptions() ?? DEFAULT_LEARNINGS;
    const filtered = input.kind === undefined ? records : records.filter((record) => record.kind === input.kind);
    const ranked = filtered.toSorted((a, b) => b.hits - a.hits || b.lastHitAt - a.lastHitAt);
    const limit = Math.max(1, input.limit ?? 20);
    return {
      items: ranked.slice(0, limit).map((record) => viewOf(record)),
      total: ranked.length,
      pendingPromotion: ranked
        .filter((record) => !record.promoted && record.hits >= options.promoteAfterHits)
        .map((record) => viewOf(record)),
    };
  }

  /**
   * learning_promote 工具的落点：确认某条教训已升格进项目文档（人或 leader 落的都算），
   * 或直接否掉它。只改台账标记，不代笔改 AGENTS.md / docs/ —— 落文档是另一次 docs-only 变更。
   */
  async learningPromote(input: { id: string; action: 'mark-promoted' | 'dismiss' }): Promise<LearningView> {
    for (const team of this.teams.values()) {
      const record = (team.learnings ?? []).find((candidate) => candidate.id === input.id);
      if (record === undefined) continue;
      if (input.action === 'mark-promoted') {
        record.promoted = true;
      } else {
        team.learnings = (team.learnings ?? []).filter((candidate) => candidate.id !== input.id);
      }
      await this.syncLearningsFile(team);
      this.changed(team.id);
      return viewOf(record);
    }
    throw new Error(`no learning record with id "${input.id}" (check learning_list)`);
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
    await this.withRemoteEnv(async (env) => {
      await fetchRemote(team.repoPath, env);
      await this.assertNoForbiddenChanges(team, task.branch, `origin/${team.baseBranch}`, task.id);
      await pushBranch(team.repoPath, task.branch, { env });
    });
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
   * 任何改动落地（推送 / 合并进 base）前的禁区检查（规范 §4.5.3）。
   * 三处调用共用这一份：`pr_sync`（比 `origin/base`）、reviewer 的 approve
   * （比本地 base —— 合并基线可能还没推）、以及 `team_branch` 的 merge。
   * 少任何一处，禁区改动都会进主干 —— 那正是这道规则要防的那件事。
   *
   * 策略由画像决定且区分模式：
   *  - `block` → 硬阻断并升级；
   *  - `needs-approval` / `high-conflict` → 先压住，等人或 owner 决策
   *    （走独立 PR），升级但不推。
   */
  private async assertNoForbiddenChanges(
    team: TeamRecord,
    source: string,
    baseRef: string,
    taskId: string | null,
  ): Promise<void> {
    const baseSha = await resolveRef(team.repoPath, baseRef);
    const branchSha = await resolveRef(team.repoPath, source);
    if (baseSha === null || branchSha === null) {
      // 解析不出来就无法证明干净 —— 门禁不能建立在"查不动就放过"上。
      const missing = baseSha === null ? baseRef : source;
      await this.escalateTask({
        taskId,
        reason: 'forbidden-paths',
        message: `cannot verify forbidden paths for "${source}": ref "${missing}" does not resolve in ${team.repoPath}`,
        suggestion: 'fetch the remote / recreate the branch so the diff can be checked, then retry',
      });
      throw new Error(`forbidden-path check failed: ref "${missing}" does not resolve`);
    }
    const rules = effectiveForbiddenRules(this.options.profile, this.options.security.forbiddenPaths);
    const files = await changedFiles(team.repoPath, baseSha, branchSha);
    const { blocks, approvals } = classifyForbiddenFiles(files, rules);
    if (blocks.length > 0) {
      await this.escalateTask({
        taskId,
        reason: 'forbidden-paths',
        message: `branch ${source} touches blocked paths: ${blocks.join(', ')}`,
        suggestion: `remove the forbidden changes from ${source}, rebase onto base, then retry`,
      });
      throw new Error(`forbidden paths modified: ${blocks.join(', ')}`);
    }
    if (approvals.length > 0) {
      await this.escalateTask({
        taskId,
        reason: 'manual',
        message: `branch ${source} touches paths needing owner/human approval or a dedicated PR: ${approvals.join(', ')}`,
        suggestion:
          'confirm the change may land only as a separate PR after owner/human approval, or split it out of this task',
      });
      throw new Error(`change held for approval: ${approvals.join(', ')}`);
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
    const found = input.taskId !== null ? this.tryFindTask(input.taskId) : null;
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
    // 升级是知识的天然来源：每一次 needs-human 都说明契约、质量门或环境里有
    // 模型自己搞不定的东西。记一条，让同域的下一个任务少踩一次（部署失败也已经
    // 收敛到这条唯一漏斗上，所以不再单独设一类）。
    const learningTeam = found?.team ?? [...this.teams.values()][0];
    if (learningTeam !== undefined) {
      // 升级原因直方图：与下面的知识捕获同源同漏斗，逐 reason 计数。
      const histogram = this.teamMetrics(learningTeam).escalations;
      histogram[input.reason] = (histogram[input.reason] ?? 0) + 1;
      const logTail = input.logTail ?? '';
      await this.captureLearning(learningTeam, {
        kind: 'escalation',
        summary: record.message,
        detail: logTail === '' ? record.message : `${record.message}\n${logTail}`,
        touches: found?.task.touches ?? [],
        taskId: found?.task.id ?? null,
        contractId: found?.task.contractId ?? null,
        reason: input.reason,
      });
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
    const metrics = this.teamMetrics(team);
    metrics.deploys += 1;
    if (view.status === 'rolled-back' || view.status === 'rollback-failed') metrics.rollbacks += 1;
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

  /**
   * 切换团队阶段（`autopilot_phase` 的后端）。
   *
   * 这是编排用的裸开关：任何阶段都能设，供人处置故障或组长推进流程。但它**不是**
   * 文档升格的合法路径 —— 从 `kickoff_pending_approval` 往前走应当由 M1 的
   * `doc_approve` 完成，那条路径带审批人记录与 `sha256` 比对（docs/design-interaction
   * §4.2、§8-10）。用本工具绕过去等于把"人批过了"变成一句模型自己的话。
   */
  setPhase(input: { teamId: string; phase: TeamPhase }): TeamView {
    const team = this.teamOf(input.teamId);
    if (team.phase === input.phase) return this.teamView(team.id);
    team.phase = input.phase;
    this.changed(team.id);
    return this.teamView(team.id);
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
    // 1. 恢复：报告上次崩溃时仍停在 in_progress 的任务。**刻意不改状态** ——
    //    抢回 pending 会把同一个任务分支二次派给另一个开发者。真正的收敛由
    //    同拍的 checkStuck 完成：无新 git 活动即升级成 needs-human 交人分诊。
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
      // 契约只扫一遍，同时供分诊与派发使用：派发时要按最新的契约正文重建任务
      // 描述（见 dispatch 内的说明）。坏文件只跳过它自己并进 events，
      // 绝不让一个坏文件拖垮整块看板。
      const { contracts, rejected } = await loadTaskContracts(team.repoPath);
      for (const item of rejected) {
        if (this.reportedRejectedContracts.has(item.path)) continue;
        this.reportedRejectedContracts.add(item.path);
        report.events.push(`contract-rejected:${item.path}`);
      }
      await this.checkAcceptedDrift(team, report);
      await this.syncContracts(team, contracts, report);
      await this.dispatch(team, report, contracts, signal);
      await this.checkReviewRounds(team, report);
      await this.checkStuck(team, report);
      await this.checkBudget(team, report);
      await this.maybeDeploy(team, report);
      await this.checkCompletion(team, report);
    }
    this.changed();
    return report;
  }

  /**
   * TECH-3（§11-2）：正式区文档被人手改（正文与批准时钉住的 sha256 不符）→
   * 整体退回 draft 区重批。这是文档真相的守门人，不是任务故障：不升级、
   * 不进直方图、不动 phase —— 在途任务照跑，要重批的是文档，不是团队阶段。
   */
  private async checkAcceptedDrift(team: TeamRecord, report: TickReport): Promise<void> {
    const drifted = await findAcceptedDrift(this.docflow, team);
    if (drifted.length === 0) return;
    const { reverted } = await revertAcceptedDrift(this.docflow, team, drifted);
    for (const path of reverted) report.events.push(`doc-drift-reverted:${path}`);
    this.changed(team.id);
  }

  /** 把仓库里的任务契约同步到看板；分诊挂起态的契约。 */
  private async syncContracts(team: TeamRecord, contracts: TaskContract[], report: TickReport): Promise<void> {
    for (const contract of contracts) {
      const existing = team.tasks.find((task) => task.contractId === contract.id);
      if (existing === undefined) {
        this.adoptPendingContract(team, contract, report);
      } else if (contract.status === 'cancelled' && CANCELLABLE_FROM_BOARD.includes(existing.status)) {
        // 人直接在契约文件里把任务标成废弃（§6.1：文件是真相源）。看板任务跟着走，
        // 挂着的升级一并解除 —— 废弃是处置结果，不是需要分诊的故障。
        existing.status = 'cancelled';
        existing.updatedAt = Date.now();
        for (const escalation of this.escalations.open) {
          if (escalation.taskId === existing.id || escalation.taskId === existing.contractId) {
            this.escalations.resolve(escalation.id);
          }
        }
        if (this.loopState === 'escalated') this.loopState = 'running';
        report.events.push(`cancelled:${existing.id}`);
      } else if (HELD_STATUSES.includes(existing.status) && !HELD_STATUSES.includes(contract.status)) {
        // 人直接改了契约文件把状态从挂起态挪走 → 重开任务。
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
    team.tasks.push(createTaskRecord({
      id: shortId('task'),
      contract,
      title: contract.title,
      branch: renderBranchName(this.options.profile.branchTemplate, contract.id, contract.title),
      assigneeId: leader.id,
      description: this.buildDescription(team, contract.body, contract.touches),
      now,
    }));
    report.events.push(`contract:${contract.id}`);
  }

  /** 派发 pending 任务（依赖已完成、领域锁空闲）给空闲开发者。 */
  private async dispatch(
    team: TeamRecord,
    report: TickReport,
    contracts: TaskContract[],
    signal?: AbortSignal,
  ): Promise<void> {
    // 阶段门（docs/design-interaction.md §2）：非开发阶段一律不派发。缺了这条，组长刚把
    // PRD 草稿写进仓库、人还没确认，契约就已经被派出去了。
    if (!DISPATCHABLE_PHASES.includes(teamPhase(team))) return;
    // 依赖判定要区分"还没完成"与"永不可能完成"，所以要看到任务本身而不只是 done 集合。
    // 键沿用 contractId ?? id（派发来的任务未必绑契约）；存记录而不是状态快照，是为了
    // 让同一轮里刚被升级成 needs-human 的前置立刻对下游可见，级联不用等下一个 tick。
    const tasksByKey = new Map<string, TaskRecord>(
      team.tasks.map((task) => [task.contractId ?? task.id, task]),
    );
    const lockedTouches = team.tasks
      .filter((task) => task.status === 'in_progress' || task.status === 'in_review')
      .flatMap((task) => task.touches);
    // 派发顺序（M3 §6.2「调 priority」）：候选按优先级降序做**稳定**排序 ——
    // priority 相同保持既有插入顺序（toSorted 稳定，不引入随机序）。前置没满足的
    // 任务在循环里照旧被跳过，所以「高优先级但依赖未满足」永远不会越过已就绪的
    // 低优先级任务（场景四：先派 Y）。
    const candidates = team.tasks
      .filter((task) => task.status === 'pending')
      .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    for (const task of candidates) {
      if (signal?.aborted === true) return;
      if (await this.escalateCrossDomain(task, report)) continue;
      if (await this.escalateForbiddenTouches(task, report)) continue;
      if (!task.dependsOn.every((dep) => tasksByKey.get(dep)?.status === 'done')) {
        // 前置「永不可能满足」必须出声：静默 continue 会让下游无限不派发、
        // 不报错、也永远凑不出"全部 done"。
        await this.escalateBlockedDependency(task, report, tasksByKey);
        continue;
      }
      if (task.touches.length > 0 && touchesOverlap(task.touches, lockedTouches)) {
        // 域锁推迟但不空转（TECH-2 / §11-3 已决口径）：被锁候选保持 pending 等
        // 下一拍，派发继续走锁外的候选；跳过要出声——否则一张高优契约一直
        // 没被派发时，面板与 autopilot_status 都看不出它在与谁等锁。这是正常
        // 等待，不升级、不进直方图。
        report.events.push(`deferred-domain-lock:${task.id}`);
        continue;
      }
      const developers = team.members.filter(
        (member) => member.role === 'developer' && member.status === 'idle' && member.currentTaskId === null,
      );
      const developer = this.pickDeveloper(developers, task.touches);
      if (developer === undefined) return; // 没有空闲开发者，下个 tick 再试
      // （重新）派发：syncContracts 建的占位任务在这里拿到真正的接手者、
      // 分支与工作区检出。
      task.assigneeId = developer.id;
      // 描述在派发这一刻重建：任务是在契约刚被收养时就建好的，而教训常常是
      // 之后别的任务被打回 / 升级才产生的 —— 只有"晚于教训、早于动工"的注入
      // 时机才真能避免重复踩坑。无对应契约（leader 手工建的任务）保持原样。
      const contract = task.contractId === null ? undefined : contracts.find((c) => c.id === task.contractId);
      if (contract !== undefined) {
        task.description = this.buildDescription(team, contract.body, contract.touches);
      }
      await this.refreshBranches(team);
      if (!team.branches.includes(task.branch)) {
        await createBranch(team.repoPath, task.branch, team.baseBranch);
      }
      await checkout(developer.workspacePath, task.branch);
      developer.branch = task.branch;
      developer.status = 'working';
      developer.currentTaskId = task.id;
      task.status = 'in_progress';
      task.dispatchedAt = Date.now();
      this.teamMetrics(team).dispatched += 1;
      this.touchTask(task);
      await this.updateContractStatus(team, task, 'in_progress', developer.name);
      lockedTouches.push(...task.touches);
      report.dispatched.push(task.id);
      report.events.push(`dispatched:${task.id}`);
    }
  }

  /**
   * 前置**永不可能**满足时升级，区别于"还没完成"。
   *
   * 不可满足有三种：看板上查无此 id（契约写错或前置被删）、前置停在
   * `needs-human`（等人分诊，自己动不了）、或前置已 `cancelled`（M3 §6.1 ——
   * 废弃态必须显式进这个判定，否则下游会退回到 §6.4 描述的静默阻塞）。
   * `needs-clarification` 刻意不算 —— 那是 leader 答一句就解的中间态，按这条升级
   * 会把人叫来看一件机器能自己处理的事。判定不出问题时安静返回，正常等待由后续
   * tick 继续。
   */
  private async escalateBlockedDependency(
    task: TaskRecord,
    report: TickReport,
    tasksByKey: Map<string, TaskRecord>,
  ): Promise<void> {
    const blockers: string[] = [];
    for (const dep of task.dependsOn) {
      const depTask = tasksByKey.get(dep);
      if (depTask === undefined) blockers.push(`${dep}（看板上不存在该任务/契约）`);
      else if (depTask.status === 'needs-human') blockers.push(`${dep}（停在 needs-human）`);
      else if (depTask.status === 'cancelled') blockers.push(`${dep}（已废弃 cancelled；修掉这条依赖或一并废弃本任务）`);
    }
    if (blockers.length === 0) return;
    report.escalated.push(task.id);
    report.events.push(`blocked-dependency:${task.id}`);
    await this.escalateTask({
      taskId: task.id,
      reason: 'blocked-dependency',
      message:
        `task "${task.title}" can never be dispatched: unsatisfiable dependency on ${blockers.join(', ')}; ` +
        `it has been waiting while its blockers are not going to finish on their own`,
      suggestion:
        'triage the blocking task(s) first, then fix or drop the dependency in the contract and requeue this task with task_update',
    });
  }

  /**
   * 跨域检查：触及的领域数超过阈值就升级并跳过派发。
   * @returns 是否已升级（true 表示本轮不要再派发这个任务）
   */
  private async escalateCrossDomain(task: TaskRecord, report: TickReport): Promise<boolean> {
    const threshold = this.options.profile.crossDomainThreshold;
    const { domainCount, exceeded } = domainLimitStatus(task.touches, threshold);
    if (!exceeded) return false;
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
   * 契约自洽检查（循环侧）：`touches` 踩到契约自己声明的 `forbidden` 禁区。
   * 与 assignTask 里的同名校验成对 —— 两条派发路径各自独立，必须都挡。
   * 复用 `forbidden-paths` 这个升级原因，语义精确且不必再手抄一份枚举。
   * @returns 是否已升级（true 表示本轮不要再派发这个任务）
   */
  private async escalateForbiddenTouches(task: TaskRecord, report: TickReport): Promise<boolean> {
    const hits = forbiddenTouchesViolation(task.touches, task.forbidden ?? []);
    if (hits.length === 0) return false;
    report.escalated.push(task.id);
    report.events.push(`forbidden-touches:${task.id}`);
    await this.escalateTask({
      taskId: task.id,
      reason: 'forbidden-paths',
      message: `task "${task.title}" touches paths its own contract declares forbidden: ${hits.join(', ')}`,
      suggestion: 'narrow the touches to stay outside the forbidden zone, or split that change into a separately approved contract',
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
      if (reviewRoundsExceeded(task, this.options.daemon.maxReviewRounds)) {
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
    // 「等人回答」不是「卡死」（§6.5）：挂着 open 问卷的任务一律豁免，否则一次
    // 合法的追问就把任务送进 needs-human，还给模型记一条根本不存在的教训。
    // 兜底是下面那个 checkBudget —— 它不豁免，所以永远没人答的问卷最终仍会升级，
    // 只是换一个更准确的原因（budget-exceeded）。
    const awaiting = new Set(
      this.questionnaires.open
        .filter((record) => record.teamId === team.id && record.taskId !== null)
        .map((record) => record.taskId!),
    );
    for (const task of team.tasks) {
      if (task.status !== 'in_progress') continue;
      if (awaiting.has(task.id)) continue;
      // 任务分支上的新提交即视为活动，用它刷新 lastActivityAt。
      const lastCommit = await lastCommitAt(team.repoPath, task.branch).catch(() => null);
      if (lastCommit !== null && lastCommit > task.lastActivityAt) {
        task.lastActivityAt = lastCommit;
      }
      if (taskStuck(task, this.options.daemon.stuckMinutes, Date.now())) {
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

  /**
   * 每任务墙钟预算（daemon.maxTaskHours，0 = 关闭）：派发后超过此时长仍是
   * in_progress 即升级 budget-exceeded。与 checkStuck 互补 —— 那里发现「空闲」，
   * 这里挡「活跃空转」。老 state.json 的任务没有 dispatchedAt，跳过不判。
   */
  private async checkBudget(team: TeamRecord, report: TickReport): Promise<void> {
    if (!(this.options.daemon.maxTaskHours > 0)) return;
    for (const task of team.tasks) {
      if (!budgetExceeded(task, this.options.daemon.maxTaskHours, Date.now())) continue;
      report.escalated.push(task.id);
      report.events.push(`budget:${task.id}`);
      await this.escalateTask({
        taskId: task.id,
        reason: 'budget-exceeded',
        message: `task "${task.title}" exceeded its wall-clock budget of ${this.options.daemon.maxTaskHours}h since dispatch`,
        suggestion: 'split the task into smaller ones or raise daemon.maxTaskHours, then move it back to pending',
      });
    }
  }

  /** 基础分支有推进且门/CI 允许时部署。 */
  private async maybeDeploy(team: TeamRecord, report: TickReport): Promise<void> {
    const deploy = this.options.deploy;
    if (deploy?.enabled !== true || deploy.command === undefined || deploy.command === '') return;
    const baseSha = await resolveRef(team.repoPath, team.baseBranch).catch(() => null);
    if (baseSha === null || baseSha === this.lastDeployBaseSha) return;
    // 任务单状态回写与看板重生成都会往 base 提交 `.tasks/` 改动。这些提交不含
    // 任何代码，部署它们只会误触回滚与升级 —— 先比对上一次部署点以来的变更面，
    // 纯文档就不部署。
    if (deploy.skipTasksOnlyCommits !== false && this.lastDeployBaseSha !== null) {
      const changed = await changedFiles(team.repoPath, this.lastDeployBaseSha, baseSha).catch(() => null);
      if (changed !== null && changed.length > 0 && changed.every((file) => file.startsWith(`${TASKS_DIR}/`))) {
        this.lastDeployBaseSha = baseSha;
        report.events.push(`deploy-skipped:tasks-only:${team.id}`);
        return;
      }
    }
    if (this.options.gates.requireCiGreen && this.hasRemote) {
      const ci = await this.ciStatusFor(team, team.baseBranch).catch(() => 'unknown' as CiStatus);
      if (ci !== 'success') return;
    }
    const view = await this.deployRun(team.id);
    report.deployed = view.id;
    report.events.push(`deploy:${view.id}:${view.status}`);
  }

  /** 全部任务收尾 → 写完成报告并把循环置为 completed。废弃的任务不挡完成（§6.1：它已被重规划处置）。 */
  private async checkCompletion(team: TeamRecord, report: TickReport): Promise<void> {
    if (team.tasks.length === 0) return;
    if (!team.tasks.every((task) => task.status === 'done' || task.status === 'cancelled')) return;
    report.completed = true;
    report.events.push('completed');
    this.loopState = 'completed';
    // 渲染是纯函数（见 service/report.ts）；这里只保留有副作用的部分。
    const summary = renderCompletionReport({
      team,
      deploys: this.deploys,
      promoteAfterHits: this.learningOptions()?.promoteAfterHits,
      finishedAt: Date.now(),
    });
    await writeFile(join(this.options.stateDir, COMPLETION_ARTIFACT), summary, 'utf8').catch(() => {});
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
      // 「哪里在等人决策」与「哪里坏了」是两句话，都要在这里说清：组长靠它决定
      // 该催谁，而不是对着一个不动的任务反复重排计划。
      awaitingHuman: this.awaitingHuman(),
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
  return assertSafeRef(branch);
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
