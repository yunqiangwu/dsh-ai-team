/**
 * 投影的形状真相：zod schema。
 *
 * 与 `view.ts` 的关系是**单向派生** —— 视图类型由这里的 schema 用 `z.infer`
 * 反推出来，所以「面板能看到什么」与「宿主校验得过什么」不可能再分叉。
 * 改之前它们是 110 行逐字段镜像，唯一的约束只有零星几处 `satisfies`，
 * 漏抄一个字段表现为运行时 parse 静默失败（`z.object` 默认剥掉未声明的键），
 * 面板上就是一片空白。
 *
 * 枚举一律取自 `vocab.ts`，不在这里重抄字面量。
 *
 * 依赖方向：本文件只依赖 zod 与 vocab，**绝不 import 任何 node 内置模块** ——
 * 客户端会 type-only 引用它。
 */
import { z as zod } from 'zod';
import {
  ANSWER_SOURCES,
  CI_STATUSES,
  DEPLOY_STATUSES,
  ESCALATION_REASONS,
  LEARNING_BUCKETS,
  LEARNING_KINDS,
  LOOP_STATES,
  MEMBER_STATUSES,
  NOTIFICATION_STATUSES,
  QUESTION_TYPES,
  QUESTIONNAIRE_KINDS,
  QUESTIONNAIRE_MODES,
  QUESTIONNAIRE_STATUSES,
  REVIEW_VERDICTS,
  ROLES,
  TASK_STATUSES,
  TEAM_PHASES,
} from './vocab.js';

export const gateResultSchema = zod.object({
  command: zod.string(),
  passed: zod.boolean(),
  exitCode: zod.number(),
  durationMs: zod.number(),
  logTail: zod.string(),
});

export const gateSummarySchema = zod.object({
  taskId: zod.string(),
  branch: zod.string(),
  allPassed: zod.boolean(),
  results: zod.array(gateResultSchema),
  ranAt: zod.number(),
});

export const memberViewSchema = zod.object({
  id: zod.string(),
  name: zod.string(),
  role: zod.enum(ROLES),
  workspacePath: zod.string(),
  branch: zod.string(),
  status: zod.enum(MEMBER_STATUSES),
  currentTaskId: zod.string().nullable(),
});

export const taskViewSchema = zod.object({
  id: zod.string(),
  /** 有任务契约时，来自 .tasks/<id>.md frontmatter 的契约 id。 */
  contractId: zod.string().nullable(),
  title: zod.string(),
  description: zod.string(),
  assigneeId: zod.string(),
  assigneeName: zod.string(),
  status: zod.enum(TASK_STATUSES),
  branch: zod.string(),
  reviewRound: zod.number().int().nonnegative(),
  dependsOn: zod.array(zod.string()),
  touches: zod.array(zod.string()),
  /** 该任务最近一次的门判定，最新的在最后。 */
  gates: gateSummarySchema.nullable(),
  prUrl: zod.string().nullable(),
  ciStatus: zod.enum(CI_STATUSES).nullable(),
  lastActivityAt: zod.number(),
  createdAt: zod.number(),
  updatedAt: zod.number(),
});

export const reviewViewSchema = zod.object({
  id: zod.string(),
  taskId: zod.string(),
  reviewerId: zod.string(),
  reviewerName: zod.string(),
  verdict: zod.enum(REVIEW_VERDICTS),
  comments: zod.string(),
  createdAt: zod.number(),
});

export const learningViewSchema = zod.object({
  id: zod.string(),
  kind: zod.enum(LEARNING_KINDS),
  /** 去重键；同 key 的记录会被合并成一条并累加 hits。 */
  key: zod.string(),
  bucket: zod.enum(LEARNING_BUCKETS),
  /** 折成一行的结论，会被注入后续任务描述。 */
  summary: zod.string(),
  /** 该坑所属的域签名（touches 折叠出的最小覆盖集）。 */
  domain: zod.string(),
  touches: zod.array(zod.string()),
  taskId: zod.string().nullable(),
  contractId: zod.string().nullable(),
  /** 同因命中次数：越高越值得升格进项目文档。 */
  hits: zod.number().int().nonnegative(),
  lastHitAt: zod.number(),
  createdAt: zod.number(),
  /** 已升格进 AGENTS.md / 项目文档：只出现在面板，不再参与注入。 */
  promoted: zod.boolean(),
});

export const teamViewSchema = zod.object({
  id: zod.string(),
  name: zod.string(),
  repoPath: zod.string(),
  baseBranch: zod.string(),
  // v6 才新增的字段：文档先行的团队阶段。旧 session 重放出的事件负载里没有这个
  // 键，缺省补 'developing'（= 本字段出现之前的唯一行为），而不是抛错。
  phase: zod.enum(TEAM_PHASES).default('developing'),
  branches: zod.array(zod.string()),
  members: zod.array(memberViewSchema),
  tasks: zod.array(taskViewSchema),
  reviews: zod.array(reviewViewSchema),
  // v3 才新增的字段：旧 session 的事件负载里没有这个键，缺省补空数组而不是抛错。
  learnings: zod.array(learningViewSchema).default([]),
  // v5 才新增的字段：团队累计运行指标，旧负载缺省补零值。
  metrics: zod
    .object({
      dispatched: zod.number().int().nonnegative(),
      completed: zod.number().int().nonnegative(),
      reviewRounds: zod.number().int().nonnegative(),
      gateRuns: zod.number().int().nonnegative(),
      gateFailures: zod.number().int().nonnegative(),
      deploys: zod.number().int().nonnegative(),
      rollbacks: zod.number().int().nonnegative(),
      /** 按 EscalationReason 分桶的升级直方图。 */
      escalations: zod.record(zod.string(), zod.number().int().nonnegative()),
    })
    .default({
      dispatched: 0,
      completed: 0,
      reviewRounds: 0,
      gateRuns: 0,
      gateFailures: 0,
      deploys: 0,
      rollbacks: 0,
      escalations: {},
    }),
  createdAt: zod.number(),
});

export const escalationNotificationSchema = zod.object({
  status: zod.enum(NOTIFICATION_STATUSES),
  /** 承载 SMTP 用户的环境变量名（脱敏安全元数据）。 */
  mailTo: zod.string(),
  mailDelivered: zod.boolean(),
  ticketUrl: zod.string().nullable(),
  /** 通过工单表单提交的答复，已脱敏。 */
  submitted: zod.record(zod.string(), zod.string()).nullable(),
  submittedAt: zod.number().nullable(),
  /** 答复提交后守护循环是否已恢复。 */
  autoResumed: zod.boolean(),
  error: zod.string().nullable(),
});

export const escalationViewSchema = zod.object({
  id: zod.string(),
  /**
   * 归属团队（TECH-4）：面板是单团队视图，升级流要按当前团队过滤。
   * nullable 兼容旧持久化记录（restore 无此字段）；渲染时 null 也显示 ——
   * 升级是全局信号，归属不明的旧记录宁可多显示，不能被过滤吞掉。
   */
  teamId: zod.string().nullable().default(null),
  taskId: zod.string().nullable(),
  reason: zod.enum(ESCALATION_REASONS),
  message: zod.string(),
  /** 建议给人类的下一个动作。 */
  suggestion: zod.string(),
  logTail: zod.string(),
  webhookDelivered: zod.boolean(),
  createdAt: zod.number(),
  resolvedAt: zod.number().nullable(),
  /**
   * 人工通知状态。启用通知时，每次升级都会尝试邮件发一个工单链接；
   * 送达与答复状态在此呈现。
   */
  notification: escalationNotificationSchema.nullable(),
});

export const deployViewSchema = zod.object({
  id: zod.string(),
  /** 归属团队（TECH-4）：与 escalationViewSchema.teamId 同一语义与兜底。 */
  teamId: zod.string().nullable().default(null),
  branch: zod.string(),
  command: zod.string(),
  status: zod.enum(DEPLOY_STATUSES),
  healthCheckUrl: zod.string().nullable(),
  logTail: zod.string(),
  startedAt: zod.number(),
  finishedAt: zod.number().nullable(),
});

// ── 问卷（docs/design-interaction.md §3）─────────────────────────────────────

export const questionOptionSchema = zod.object({
  value: zod.string(),
  label: zod.string(),
  /** 选这个方案的代价，渲染成选项副文案 —— 让人在看得到后果的地方做选择。 */
  impact: zod.string().default(''),
  /** 组长的推荐项：多选题里预勾选，单选题里排首位。 */
  recommended: zod.boolean().default(false),
});

export const questionSchema = zod.object({
  /** 稳定 key：答案索引与文档回写都靠它，改名等于换了一道题。 */
  name: zod.string(),
  label: zod.string(),
  type: zod.enum(QUESTION_TYPES),
  options: zod.array(questionOptionSchema).default([]),
  required: zod.boolean().default(true),
  /**
   * 「人不回答时按什么办」。async 模式下这是唯一的兜底 —— 没有它，一条没人答的问卷
   * 就把流程永久冻住了，而强制必填只会逼人随手点一下。
   */
  defaultValue: zod.string().default(''),
});

export const answerSchema = zod.object({
  /** 多选的多个值以 `, ` 连接（题目选项值本身不允许含逗号，创建时校验）。 */
  value: zod.string(),
  at: zod.number(),
  source: zod.enum(ANSWER_SOURCES),
});

/** 答案落地的位置（§3.4）：回写进文档章节，或落到某张任务契约的留言里。 */
export const questionBindingSchema = zod.discriminatedUnion('type', [
  zod.object({
    type: zod.literal('doc'),
    path: zod.string(),
    /** 目标章节标题，空串表示追加到文末。 */
    section: zod.string().default(''),
  }),
  zod.object({ type: zod.literal('task'), contractId: zod.string() }),
]);

export const questionnaireViewSchema = zod.object({
  id: zod.string(),
  teamId: zod.string(),
  kind: zod.enum(QUESTIONNAIRE_KINDS),
  title: zod.string(),
  mode: zod.enum(QUESTIONNAIRE_MODES),
  questions: zod.array(questionSchema).default([]),
  answers: zod.record(zod.string(), answerSchema).default({}),
  status: zod.enum(QUESTIONNAIRE_STATUSES),
  binding: questionBindingSchema.nullable().default(null),
  /** 工单页链接：投递渠道，不是实体本身（§3.1）。 */
  ticketUrl: zod.string().nullable().default(null),
  mailDelivered: zod.boolean().default(false),
  /**
   * 绑定的任务 id（可空）：面板要能在任务卡上说出「在等人回答」，
   * 而 checkStuck 要靠它豁免 interactive 问卷的等待期（§6.5）。
   */
  taskId: zod.string().nullable().default(null),
  createdAt: zod.number(),
  answeredAt: zod.number().nullable().default(null),
  /** 仅 interactive 模式有意义：await 的上限，超时转 open-but-expired 而不是永久挂住。 */
  expiresAt: zod.number().nullable().default(null),
});

export const heartbeatViewSchema = zod.object({
  at: zod.number(),
  loopState: zod.enum(LOOP_STATES),
  tick: zod.number(),
});

export const autopilotProjectionSchema = zod.object({
  loopState: zod.enum(LOOP_STATES),
  teams: zod.array(teamViewSchema),
  activeTeamId: zod.string().nullable(),
  escalations: zod.array(escalationViewSchema),
  /**
   * 待答与已答的问卷。与 escalations 平级而非挂在团队下：一份快照要能同时说明
   * 「哪里坏了」和「哪里在等人决策」。
   *
   * ⚠️ `doc_approve` 的**一次性审批码刻意不在这里**。全量快照会作为 session 事件
   * 进模型读得到的日志，写进视图等于让组长自己批准自己的文档（§8-10）。码只活在
   * 服务侧记录 + 工单页 / 邮件里，那两个出口只有人都碰得着。
   *
   * 工单**访问凭据（`?t=<token>`）同理**：视图里的 `ticketUrl` 是无凭据那一份，
   * 带 token 的只出现在邮件与 webhook 文案里，token 本身住在 `AutopilotService`
   * 的旁路表（`state.json` 的 `ticketTokens`，不是视图字段）。同源面板路由因此只
   * 放开「作答」这一条写侧，读侧（表单页）仍然要 token —— 否则本机进程拿围栏就能
   * 换到一张写着审批码的页面。
   *
   * 边界要说清：读侧现在谁都绕不过（无 token 抓不到页面），但**写侧的围栏挡不住本机
   * 进程** —— `node` 在默认命令白名单里，它自己就能把 `Host` 设成 `127.0.0.1` 走过
   * 围栏，替一张 id 已知的工单写答案。所以这道门挡的是网络侧攻击者、跨站表单与「顺手
   * 绕过」，不挡已被注入的模型，与全仓库的命令白名单同一个定位（见 AGENTS.md 安全硬
   * 规则 2）。要硬保证请自己收紧 `security.commandAllowlist` 与工单端点的绑定地址。
   */
  questionnaires: zod.array(questionnaireViewSchema).default([]),
  deploys: zod.array(deployViewSchema),
  heartbeat: heartbeatViewSchema.nullable(),
  /** 当前被阻塞的任务 id（needs-human / 等 leader 澄清 / 卡死 / 门红）。 */
  blocked: zod.array(zod.string()),
});

/**
 * 视图类型 = schema 的输出类型。`z.infer` 只能在本文件做（这里允许值导入 zod）；
 * `view.ts` 用纯类型 re-export 转出这些名字，客户端产物里因此不会有 zod。
 */
export type GateResult = zod.infer<typeof gateResultSchema>;
export type GateSummary = zod.infer<typeof gateSummarySchema>;
export type MemberView = zod.infer<typeof memberViewSchema>;
export type TaskView = zod.infer<typeof taskViewSchema>;
export type ReviewView = zod.infer<typeof reviewViewSchema>;
export type LearningView = zod.infer<typeof learningViewSchema>;
export type TeamView = zod.infer<typeof teamViewSchema>;
export type EscalationNotification = zod.infer<typeof escalationNotificationSchema>;
export type EscalationView = zod.infer<typeof escalationViewSchema>;
export type DeployView = zod.infer<typeof deployViewSchema>;
export type QuestionOption = zod.infer<typeof questionOptionSchema>;
export type Question = zod.infer<typeof questionSchema>;
export type Answer = zod.infer<typeof answerSchema>;
export type QuestionBinding = zod.infer<typeof questionBindingSchema>;
export type QuestionnaireView = zod.infer<typeof questionnaireViewSchema>;
export type HeartbeatView = zod.infer<typeof heartbeatViewSchema>;
export type AutopilotProjection = zod.infer<typeof autopilotProjectionSchema>;
