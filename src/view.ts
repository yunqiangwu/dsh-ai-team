/**
 * 浏览器安全的视图类型，由 host 侧与 client 侧共享。
 * 本文件任何内容都不得 import node 内置模块：客户端 bundle 会内联它。
 *
 * 数据流：host 工具 / 守护循环变更 AutopilotService 状态 → 插件追加一条携带
 * {@link AutopilotProjection} 快照的 `autopilot/update` 会话事件 → `autopilot`
 * 会话投影把它折叠（last-write-wins）→ 浏览器面板用
 * useProjection('autopilot') 读取它。
 */

export const ROLES = ['leader', 'developer', 'reviewer', 'operator'] as const;
export type Role = (typeof ROLES)[number];

export type MemberStatus = 'idle' | 'working' | 'reviewing';

/**
 * 任务看板状态机（见目标仓库的 .tasks/README.md）：
 *   pending → in_progress → in_review → done
 *                 ↑  └→ changes_requested ─┘
 *                 ├→ needs-human (已升级，分诊后回到 pending)
 *                 └→ needs-clarification (契约含糊，退回 leader 澄清后回到 pending；
 *                    不计入返工轮次、不产生升级)
 */
export const TASK_STATUSES = [
  'pending',
  'in_progress',
  'in_review',
  'changes_requested',
  'needs-clarification',
  'done',
  'needs-human',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type ReviewVerdict = 'approve' | 'request_changes';

export type LoopState = 'stopped' | 'running' | 'paused' | 'escalated' | 'completed';

export interface MemberView {
  id: string;
  name: string;
  role: Role;
  workspacePath: string;
  branch: string;
  status: MemberStatus;
  currentTaskId: string | null;
}

export interface TaskView {
  id: string;
  /** 有任务契约时，来自 .tasks/<id>.md frontmatter 的契约 id。 */
  contractId: string | null;
  title: string;
  description: string;
  assigneeId: string;
  assigneeName: string;
  status: TaskStatus;
  branch: string;
  reviewRound: number;
  dependsOn: string[];
  touches: string[];
  /** 该任务最近一次的门判定，最新的在最后。 */
  gates: GateSummary | null;
  prUrl: string | null;
  ciStatus: CiStatus | null;
  lastActivityAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReviewView {
  id: string;
  taskId: string;
  reviewerId: string;
  reviewerName: string;
  verdict: ReviewVerdict;
  comments: string;
  createdAt: number;
}

export interface TeamView {
  id: string;
  name: string;
  repoPath: string;
  baseBranch: string;
  branches: string[];
  members: MemberView[];
  tasks: TaskView[];
  reviews: ReviewView[];
  /** 跨任务教训（已脱敏），同时是 .tasks/_learnings.md 的真相源。 */
  learnings: LearningView[];
  createdAt: number;
}

// ── autopilot 专属视图 ──────────────────────────────────────────────────────

export type CiStatus = 'pending' | 'success' | 'failure' | 'unknown';

export interface GateResult {
  command: string;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  /** 命令输出的尾部摘要，密钥已脱敏。 */
  logTail: string;
}

export interface GateSummary {
  taskId: string;
  branch: string;
  allPassed: boolean;
  results: GateResult[];
  ranAt: number;
}

/**
 * 升级原因的唯一清单。导出成数组是刻意的：这个枚举曾需要在
 * `projection.ts` 的 zod enum 与 `tools.ts` 的工具参数里各手抄一份全文，
 * 漏抄不会编译报错（zod 漏值表现为运行时 viewSchema 校验静默失败）。
 * 下游一律引用本数组，加一个值只需改这里。
 */
export const ESCALATION_REASONS = [
  'conflicting-requirements',
  'cross-domain',
  'paid-dependency',
  'foreign-gate-failure',
  'forbidden-paths',
  'review-rounds-exceeded',
  /** 单个任务的改动体量超过 daemon.maxDiffLines / maxDiffFiles：该拆任务而不是放行。 */
  'change-too-large',
  'task-stuck',
  'deploy-failed',
  'bootstrap-failed',
  'gate-failure',
  'manual',
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export interface EscalationView {
  id: string;
  taskId: string | null;
  reason: EscalationReason;
  message: string;
  /** 建议给人类的下一个动作。 */
  suggestion: string;
  logTail: string;
  webhookDelivered: boolean;
  createdAt: number;
  resolvedAt: number | null;
  /**
   * 人工通知状态。启用通知时，每次升级都会尝试邮件发一个工单链接；
   * 送达与答复状态在此呈现。
   */
  notification: EscalationNotification | null;
}

/** 一次升级通知的投递/答复状态。 */
export interface EscalationNotification {
  status: 'disabled' | 'sent' | 'failed';
  /** 承载 SMTP 用户的环境变量名（脱敏安全元数据）。 */
  mailTo: string;
  mailDelivered: boolean;
  ticketUrl: string | null;
  /** 通过工单表单提交的答复，已脱敏。 */
  submitted: Record<string, string> | null;
  submittedAt: number | null;
  /** 答复提交后守护循环是否已恢复。 */
  autoResumed: boolean;
  error: string | null;
}

export interface DeployView {
  id: string;
  branch: string;
  command: string;
  status: 'running' | 'healthy' | 'failed' | 'rolled-back';
  healthCheckUrl: string | null;
  logTail: string;
  startedAt: number;
  finishedAt: number | null;
}

// ── 知识沉淀（learnings）────────────────────────────────────────────────────

/**
 * 学习记录的来源。只有两个自动捕获点（评审打回、升级）—— 部署失败已经统一走
 * escalateTask(reason='deploy-failed')，升级是唯一漏斗，再设一类会把同一次失败
 * 计成两条；"是部署问题"这个语义由 bucket 'deploy' 承载。
 */
export const LEARNING_KINDS = ['review-change-request', 'escalation', 'manual'] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];

/**
 * 去重键的「意图」维度：封闭小词表。宁可粗一点也不要让模型自由措辞 ——
 * 自由文本做分桶会让同一个坑永远合不到一条。
 */
export const LEARNING_BUCKETS = [
  'quality-gate',
  'schema',
  'contract-ambiguity',
  'scope',
  'security',
  'docs',
  'testability',
  'flaky',
  'conflict',
  'env',
  'deploy',
  'other',
] as const;
export type LearningBucket = (typeof LEARNING_BUCKETS)[number];

/** 一条跨任务可复用的教训（面向视图：summary 已脱敏并截断）。 */
export interface LearningView {
  id: string;
  kind: LearningKind;
  /** 去重键；同 key 的记录会被合并成一条并累加 hits。 */
  key: string;
  bucket: LearningBucket;
  /** 折成一行的结论，会被注入后续任务描述。 */
  summary: string;
  /** 该坑所属的域签名（touches 折叠出的最小覆盖集）。 */
  domain: string;
  touches: string[];
  taskId: string | null;
  contractId: string | null;
  /** 同因命中次数：越高越值得人工升格进项目文档。 */
  hits: number;
  lastHitAt: number;
  createdAt: number;
  /** 已被人升格到 AGENTS.md / 项目文档：只出现在面板，不再参与注入。 */
  promoted: boolean;
}

export interface HeartbeatView {
  at: number;
  loopState: LoopState;
  tick: number;
}

export interface AutopilotProjection {
  loopState: LoopState;
  teams: TeamView[];
  activeTeamId: string | null;
  escalations: EscalationView[];
  deploys: DeployView[];
  heartbeat: HeartbeatView | null;
  /** 当前被阻塞的任务 id（needs-human / 等 leader 澄清 / 卡死 / 门红）。 */
  blocked: string[];
}

export const EMPTY_PROJECTION: AutopilotProjection = {
  loopState: 'stopped',
  teams: [],
  activeTeamId: null,
  escalations: [],
  deploys: [],
  heartbeat: null,
  blocked: [],
};
