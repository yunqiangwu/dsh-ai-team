/**
 * 运行时词表：封闭枚举的**唯一**清单。零依赖（不 import zod、不 import node）。
 *
 * 为什么单独一个文件而不是留在 view.ts 里：view.ts 现在要从 schema.ts 派生视图
 * 类型（`z.infer`），而 schema.ts 反过来要用这里的数组构造 `zod.enum()`。数组留
 * 在 view.ts 会形成 view ↔ schema 的环形依赖；更要紧的是客户端 bundle 会内联
 * view.ts —— 一旦 view.ts 有值层面的 zod 依赖，整个 zod 就被打进前端产物。
 * 分层因此是单向的：
 *
 *   vocab.ts（值，浏览器安全）← schema.ts（zod）← view.ts（类型门面）
 *
 * 加一个枚举值只需改这里；下游 `zod.enum(...)` 与工具参数、面板渲染都读这一份。
 * 手抄副本曾在 projection.ts 与 tools.ts 各存一份，漏抄不报编译错，只表现为
 * 运行时 viewSchema 校验静默失败、面板永远拿不到那个值。
 */

export const ROLES = ['leader', 'developer', 'reviewer', 'operator'] as const;
export type Role = (typeof ROLES)[number];

export const MEMBER_STATUSES = ['idle', 'working', 'reviewing'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

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

export const REVIEW_VERDICTS = ['approve', 'request_changes'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** 守护循环状态：崩溃恢复时持久化的 running 一律降为 paused。 */
export const LOOP_STATES = ['stopped', 'running', 'paused', 'escalated', 'completed'] as const;
export type LoopState = (typeof LOOP_STATES)[number];

export const CI_STATUSES = ['pending', 'success', 'failure', 'unknown'] as const;
export type CiStatus = (typeof CI_STATUSES)[number];

export const DEPLOY_STATUSES = [
  'running',
  'healthy',
  'failed',
  'rolled-back',
  // 健康检查没过、回滚命令自己也以非零退出：线上既没升上去也没退回来。
  'rollback-failed',
] as const;
export type DeployStatus = (typeof DEPLOY_STATUSES)[number];

export const NOTIFICATION_STATUSES = ['disabled', 'sent', 'failed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * 升级原因的唯一清单。`escalate` 工具的 enum 参数与投影 schema 都读这里。
 * 新增一项要连带确认服务端真会产出它 —— 见 reviewChangeRequest / deployRun 等
 * 唯一漏斗，无人产出的分类只会让模型多一个错选项。
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
