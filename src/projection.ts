import { z as zod } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
// oxlint-disable-next-line unicorn/require-module-specifiers
import type {} from '@deepseek-ai/dsh-session-projection';
import './events.js';
import type { AutopilotProjection } from './view.js';
import { ESCALATION_REASONS, LEARNING_BUCKETS, LEARNING_KINDS, TASK_STATUSES } from './view.js';

const roleSchema = zod.enum(['leader', 'developer', 'reviewer', 'operator']);
const memberStatusSchema = zod.enum(['idle', 'working', 'reviewing']);
// 引用 view.ts 的唯一清单，而不是在这里重抄一遍枚举值：重抄漏一个不会编译报错，
// 只会在运行时表现为 viewSchema 校验静默失败、面板永远拿不到该值。
const taskStatusSchema = zod.enum(TASK_STATUSES);
const ciStatusSchema = zod.enum(['pending', 'success', 'failure', 'unknown']);

const gateResultSchema = zod.object({
  command: zod.string(),
  passed: zod.boolean(),
  exitCode: zod.number(),
  durationMs: zod.number(),
  logTail: zod.string(),
});

const gateSummarySchema = zod.object({
  taskId: zod.string(),
  branch: zod.string(),
  allPassed: zod.boolean(),
  results: zod.array(gateResultSchema),
  ranAt: zod.number(),
});

const memberViewSchema = zod.object({
  id: zod.string(),
  name: zod.string(),
  role: roleSchema,
  workspacePath: zod.string(),
  branch: zod.string(),
  status: memberStatusSchema,
  currentTaskId: zod.string().nullable(),
});

const taskViewSchema = zod.object({
  id: zod.string(),
  contractId: zod.string().nullable(),
  title: zod.string(),
  description: zod.string(),
  assigneeId: zod.string(),
  assigneeName: zod.string(),
  status: taskStatusSchema,
  branch: zod.string(),
  reviewRound: zod.number().int().nonnegative(),
  dependsOn: zod.array(zod.string()),
  touches: zod.array(zod.string()),
  gates: gateSummarySchema.nullable(),
  prUrl: zod.string().nullable(),
  ciStatus: ciStatusSchema.nullable(),
  lastActivityAt: zod.number(),
  createdAt: zod.number(),
  updatedAt: zod.number(),
});

const reviewViewSchema = zod.object({
  id: zod.string(),
  taskId: zod.string(),
  reviewerId: zod.string(),
  reviewerName: zod.string(),
  verdict: zod.enum(['approve', 'request_changes']),
  comments: zod.string(),
  createdAt: zod.number(),
});

const learningViewSchema = zod.object({
  id: zod.string(),
  kind: zod.enum(LEARNING_KINDS),
  key: zod.string(),
  bucket: zod.enum(LEARNING_BUCKETS),
  summary: zod.string(),
  domain: zod.string(),
  touches: zod.array(zod.string()),
  taskId: zod.string().nullable(),
  contractId: zod.string().nullable(),
  hits: zod.number().int().nonnegative(),
  lastHitAt: zod.number(),
  createdAt: zod.number(),
  promoted: zod.boolean(),
});

const teamViewSchema = zod.object({
  id: zod.string(),
  name: zod.string(),
  repoPath: zod.string(),
  baseBranch: zod.string(),
  branches: zod.array(zod.string()),
  members: zod.array(memberViewSchema),
  tasks: zod.array(taskViewSchema),
  reviews: zod.array(reviewViewSchema),
  learnings: zod.array(learningViewSchema),
  createdAt: zod.number(),
});

const escalationViewSchema = zod.object({
  id: zod.string(),
  taskId: zod.string().nullable(),
  reason: zod.enum(ESCALATION_REASONS),
  message: zod.string(),
  suggestion: zod.string(),
  logTail: zod.string(),
  webhookDelivered: zod.boolean(),
  createdAt: zod.number(),
  resolvedAt: zod.number().nullable(),
  notification: zod
    .object({
      status: zod.enum(['disabled', 'sent', 'failed']),
      mailTo: zod.string(),
      mailDelivered: zod.boolean(),
      ticketUrl: zod.string().nullable(),
      submitted: zod.record(zod.string(), zod.string()).nullable(),
      submittedAt: zod.number().nullable(),
      autoResumed: zod.boolean(),
      error: zod.string().nullable(),
    })
    .nullable(),
});

const deployViewSchema = zod.object({
  id: zod.string(),
  branch: zod.string(),
  command: zod.string(),
  status: zod.enum(['running', 'healthy', 'failed', 'rolled-back']),
  healthCheckUrl: zod.string().nullable(),
  logTail: zod.string(),
  startedAt: zod.number(),
  finishedAt: zod.number().nullable(),
});

const heartbeatSchema = zod.object({
  at: zod.number(),
  loopState: zod.enum(['stopped', 'running', 'paused', 'escalated', 'completed']),
  tick: zod.number(),
});

const autopilotProjectionSchema = zod.object({
  loopState: zod.enum(['stopped', 'running', 'paused', 'escalated', 'completed']),
  teams: zod.array(teamViewSchema),
  activeTeamId: zod.string().nullable(),
  escalations: zod.array(escalationViewSchema),
  deploys: zod.array(deployViewSchema),
  heartbeat: heartbeatSchema.nullable(),
  blocked: zod.array(zod.string()),
});

/** 当投影缝可用时注册投影单元。 */
export function registerAutopilotProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: 'autopilot',
      stateSchema: autopilotProjectionSchema.nullable(),
      init: (): AutopilotProjection | null => null,
      apply: (state, event) => (event.type === 'autopilot/update' ? event.data.state : state),
      wire: {
        viewSchema: autopilotProjectionSchema.nullable(),
        view: (state): AutopilotProjection | null => state,
      },
      // v3：teamView 新增 `learnings`；任务状态新增 `needs-clarification`；
      // 升级原因新增 `change-too-large`。变更形状时需递增。
      stateVersion: 3,
    });
  });
}

export { autopilotProjectionSchema };
