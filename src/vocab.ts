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
 *                 ├→ needs-clarification (契约含糊，退回 leader 澄清后回到 pending；
 *                 │  不计入返工轮次、不产生升级)
 *                 └→ cancelled (重规划废弃：契约文件保留不删，可追溯 —— §6.1)
 */
export const TASK_STATUSES = [
  'pending',
  'in_progress',
  'in_review',
  'changes_requested',
  'needs-clarification',
  'done',
  'needs-human',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const REVIEW_VERDICTS = ['approve', 'request_changes'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** 守护循环状态：崩溃恢复时持久化的 running 一律降为 paused。 */
export const LOOP_STATES = ['stopped', 'running', 'paused', 'escalated', 'completed'] as const;
export type LoopState = (typeof LOOP_STATES)[number];

/**
 * 团队阶段：与 `loopState` 正交的维度 —— loopState 说"循环在不在转"，phase 说
 * "转到哪一步了"（见 docs/design-interaction.md §2）。
 *
 * `dispatch` 只在 `developing` / `replanning` 下工作。这条门必须存在：否则组长刚
 * 把 PRD 草稿写出来、人还没确认，契约就已经被派出去了。
 *
 * 默认值是 `developing`，不是 `intake` —— 存量团队与"init → 加成员 → run"的既有
 * 用法必须一字不变地继续跑。"新团队从 intake 起步"是文档先行策略的一部分，随 M1
 * 的流程工具与配置开关一起引入，不在这里悄悄改行为。
 */
export const TEAM_PHASES = [
  'intake',
  'kickoff_pending_approval',
  'scaffolding',
  'developing',
  'replanning',
] as const;
export type TeamPhase = (typeof TEAM_PHASES)[number];

/** 允许派发任务的阶段。其余阶段 dispatch 直接返回。 */
export const DISPATCHABLE_PHASES: readonly TeamPhase[] = ['developing', 'replanning'];

/**
 * 周期状态机（docs/design-cycles.md §2.2）：
 *   planned → in_progress → in_review → done
 * `planned` 的周期内契约不派发（§5.4）；`in_progress` 是当前活跃周期；`in_review`
 * 等验收；`done` 周期结束。状态推进与验收逻辑归 CYC-3，这里只定词表 —— 与
 * `TeamPhase` 正交：周期是 developing 内的子推进，不是新 phase（§1.2）。
 */
export const CYCLE_STATUSES = ['planned', 'in_progress', 'in_review', 'done'] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

/**
 * 问卷（questionnaire）：AI 需要人给一个**决策**才能继续时走这里。它与 escalation
 * 是两件事，绝不能混用同一个记录 —— 升级说「我卡住了，来个人分诊」，问卷说「一切正常，
 * 只是这个选择得由人来做」。把问卷塞进升级会付出三重代价：任务被错误打上
 * `needs-human`、进升级直方图、并被 captureLearning 记成一条教训（见
 * docs/design-interaction.md §3.1）。
 *
 * `cycle`：周期边界推进问卷（docs/design-cycles.md §6.3）。周期验收通过后，
 * `checkpoint` 周期停在 `in_review` 等人点「继续 / 结束」，或等规划周期置 `done`
 * 后请人确认「roadmap 还有下一期吗」。与 `approval` 刻意分开 —— 后者钉的是文档
 * sha256、走 `doc_approve` 升格；周期推进不涉及任何文档字节，开工审批已随
 * `requireApproval` 移除（§8），开工恒机械。
 */
export const QUESTIONNAIRE_KINDS = ['intake', 'approval', 'replan', 'cycle'] as const;
export type QuestionnaireKind = (typeof QUESTIONNAIRE_KINDS)[number];

export const QUESTIONNAIRE_STATUSES = ['open', 'answered', 'expired', 'cancelled'] as const;
export type QuestionnaireStatus = (typeof QUESTIONNAIRE_STATUSES)[number];

/**
 * 两种交付模式的差别只在「谁把 agent 那一轮叫醒」（§3.2）：
 * - `interactive`：`ask_human` 内部 await 答案，组长这一轮不结束；
 * - `async`：落一条 open 问卷就走，答案回来后要人开口让组长继续 —— 插件没有
 *   「向会话投一条消息」的写入口，这条边界不是工程能绕过的（§1.1）。
 */
export const QUESTIONNAIRE_MODES = ['interactive', 'async'] as const;
export type QuestionnaireMode = (typeof QUESTIONNAIRE_MODES)[number];

/**
 * 题目类型。`select` 单选、`multiselect` 多选（recommended 项预勾选），
 * `text` / `textarea` 是填空。刻意不做条件分段（branching）：一分段，回写映射与
 * 前端渲染成本立刻翻倍，而试点期的问题集完全可以是静态的（§3.3）。
 */
export const QUESTION_TYPES = ['select', 'multiselect', 'text', 'textarea'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/**
 * 多选答案的序列化分隔符：选项值本身不允许含它（创建时校验）。
 *
 * 住在这里而不是 `questionnaire.ts`，是因为 M2 之后两端都要用它 —— 面板把复选框组
 * 发成字符串数组、工单端点把它序列化成同一个形状。而 `questionnaire.ts` 导入了
 * `node:crypto`，浏览器产物碰不得；词表是两端唯一都能安全 import 的模块。
 */
export const MULTI_VALUE_SEP = ', ';

/** 答案从哪儿来。`ticket` = 工单页 POST；`tool` = 会话里人直接调 answer_questionnaire。 */
export const ANSWER_SOURCES = ['ticket', 'tool'] as const;
export type AnswerSource = (typeof ANSWER_SOURCES)[number];

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
  /**
   * 前置依赖**永不可能**满足：引用了看板上不存在的 id，或前置停在 needs-human。
   * 与"还没完成"是两回事 —— 后者正常等待，前者若不出声，下游会无限静默不派发，
   * 既不报错也不升级，还永远凑不出"全部 done"的完成报告。
   */
  'blocked-dependency',
  'task-stuck',
  /** 单任务墙钟超过 daemon.maxTaskHours 仍未完成：活跃空转（区别于 task-stuck 的空闲），烧钱失控信号。 */
  'budget-exceeded',
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

/**
 * 面板内作答用的工单路由前缀，挂在宿主 `ctx.webServer` 上（同源，见
 * docs/design-interaction.md §7.1）。服务端注册路由与客户端 `fetch` 必须是同一个
 * 字符串，而这个前缀住在 `src/` 根、两端都会 import 它 —— 词表是本仓库唯一
 * 既零依赖又浏览器安全的模块（`view.ts` 整体 re-export，客户端产物因此带上它，
 * 但绝不会带上 node）。写死两份必然漂移，漂一次的后果是面板按钮静默 404。
 */
export const TICKET_ROUTE_PREFIX = '/autopilot/ticket';

/** 远端 git 平台。只有 github 有 PR upsert 与 CI 状态查询；其余按 generic 语义。 */
export const REMOTE_PLATFORMS = ['github', 'cnb', 'gitlab', 'generic'] as const;
export type RemotePlatform = (typeof REMOTE_PLATFORMS)[number];

/** 升级时的暂停粒度：只挂起触发任务（task），或整个团队停发（team）。 */
export const PAUSE_ON_ESCALATION = ['task', 'team'] as const;
export type PauseOnEscalation = (typeof PAUSE_ON_ESCALATION)[number];

/**
 * 问卷答案的落地位置（docs/design-interaction.md §3.4）：`doc` 绑定写进 draft
 * 文档章节，`task` 绑定把决策留言到任务契约。ask_human 工具参数读这份；
 * `schema.ts` 的 questionBindingSchema 用 discriminatedUnion（每个分支仍要
 * zod.literal），两处改时必须同步。
 */
export const ANSWER_BINDING_TYPES = ['doc', 'task'] as const;
export type AnswerBindingType = (typeof ANSWER_BINDING_TYPES)[number];

/**
 * task_update 允许模型手动迁移的状态子集：done 与 changes_requested 归评审流程
 * 所有，needs-human 归升级流程，needs-clarification 由 task_clarify 进入。
 * `as const` 保持字面量元组 —— 工具参数的 enum 靠它收窄 args 类型。
 */
export const TASK_MOVEABLE_STATUSES = ['pending', 'in_progress', 'in_review'] as const satisfies readonly TaskStatus[];
