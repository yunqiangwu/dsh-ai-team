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
  CI_STATUSES,
  DEPLOY_STATUSES,
  ESCALATION_REASONS,
  LEARNING_BUCKETS,
  LEARNING_KINDS,
  LOOP_STATES,
  MEMBER_STATUSES,
  NOTIFICATION_STATUSES,
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
  branch: zod.string(),
  command: zod.string(),
  status: zod.enum(DEPLOY_STATUSES),
  healthCheckUrl: zod.string().nullable(),
  logTail: zod.string(),
  startedAt: zod.number(),
  finishedAt: zod.number().nullable(),
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
export type HeartbeatView = zod.infer<typeof heartbeatViewSchema>;
export type AutopilotProjection = zod.infer<typeof autopilotProjectionSchema>;
