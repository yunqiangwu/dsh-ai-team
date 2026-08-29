/**
 * AutopilotService 的内部数据形状与几个纯函数工具。
 *
 * 这些记录就是 state.json 的内容（`PersistedState` 是它的完整形状），与
 * `view.ts` 里的对外视图类型刻意分开：视图是「能推给浏览器」的子集，记录是
 * 「服务端自己要用」的超集（`MemberRecord.systemPrompt`、`LearningRecord.detail`
 * 这类只留在服务侧）。
 *
 * 兼容约定：给这些记录**新增字段一律用可选字段**，并在读取处 `?? 默认值` 兜底
 * —— 老用户的 state.json 里没有新字段，而 `load()` 不会替谁做迁移。
 */
import { randomUUID } from 'node:crypto';
import type { QuestionnaireRecord } from '../questionnaire.js';
import type { LearningRecord } from '../learnings.js';
import type {
  CiStatus,
  DeployView,
  EscalationView,
  GateSummary,
  LoopState,
  MemberStatus,
  ReviewVerdict,
  Role,
  TaskStatus,
  TeamPhase,
} from '../view.js';

/** 仓库内任务契约目录。 */
export const TASKS_DIR = '.tasks';

/** 「挂起等待」状态：needs-human 等人分诊，needs-clarification 等 leader 回答契约。 */
export const HELD_STATUSES: readonly TaskStatus[] = ['needs-human', 'needs-clarification'];

/** 生成短 id（team_xxxxxxxx / task_xxxxxxxx / m_xxxxxxxx / rev_xxxxxxxx）。 */
export const shortId = (prefix: string): string => `${prefix}_${randomUUID().slice(0, 8)}`;

/**
 * 截断到上限并留省略号：任何要注入提示词或推给前端的文本都必须有硬边界。
 * 上限非正时返回空串 —— 否则 `slice(0, limit - 1)` 在 0 时等价于「几乎全文」，
 * 让精心算出的剩余预算形同虚设。
 */
export const clip = (text: string, limit: number): string =>
  limit <= 0 ? '' : text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/** 取第一行非空文本并折叠空白：把多行评审意见压成一行可注入的结论。 */
export const oneLine = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim().replace(/^[-*>#]+\s*/, ''))
    .find((line) => line !== '') ?? '';

/** 把一段自由文本压成 markdown 留言行（带 `> ` 前缀；逐行脱敏由调用方负责）。 */
export const noteLines = (text: string, max = 20): string[] =>
  text
    .split('\n')
    .slice(0, max)
    .map((line) => `> ${line}`);

/** 成员的个人分支名：任务之外成员默认停留在这里。 */
export const memberBranch = (memberId: string): string => `member/${memberId}`;

/** 按 id 找成员；找不到返回 undefined —— 视图与查找各自决定兜底方式。 */
export function findMember(team: TeamRecord, memberId: string): MemberRecord | undefined {
  return team.members.find((candidate) => candidate.id === memberId);
}

/**
 * 按 id 取成员，找不到即抛错。这是成员查找错误文案的**唯一**出处：
 * `AutopilotService.memberOf` 与 `service/views.ts` 都走这里，第二份迟早漂移。
 */
export function requireTeamMember(team: TeamRecord, memberId: string): MemberRecord {
  const member = findMember(team, memberId);
  if (member === undefined) {
    throw new Error(
      `team "${team.name}" has no member "${memberId}"; members: ${team.members.map((m) => `${m.name}(${m.id})`).join(', ') || '(none)'}`,
    );
  }
  return member;
}

export interface MemberRecord {
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

export interface TaskRecord {
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
  /**
   * 契约自己声明的禁区（派发前自洽校验用）。可选：老 state.json 里没这个字段，
   * 读取处一律 `?? []`。dispatch 只拿得到任务记录、拿不到磁盘契约，所以必须在
   * 建记录时从契约带过来。
   */
  forbidden?: string[] | undefined;
  gates: GateSummary | null;
  prUrl: string | null;
  ciStatus: CiStatus | null;
  lastActivityAt: number;
  /** 最近一次派发时刻；老 state.json 里没有，读取处兜底跳过（如预算检查）。 */
  dispatchedAt?: number | undefined;
  /** 任务置为 done 的时刻；未完成的任务没有。 */
  completedAt?: number | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface ReviewRecord {
  id: string;
  taskId: string;
  reviewerId: string;
  verdict: ReviewVerdict;
  comments: string;
  createdAt: number;
}

/** {@link createTaskRecord} 的入参：契约字段之外、两条派发路径各不相同的来源。 */
export interface TaskRecordSeed {
  id: string;
  /** 无契约绑定时为 null，title/dependsOn/touches 等回落到 seed.title 与空数组。 */
  contract: {
    id: string;
    path: string;
    title: string;
    dependsOn: string[];
    touches: string[];
    forbidden: string[];
  } | null;
  /** 无契约时的任务标题（有契约时以契约为准）。 */
  title: string;
  branch: string;
  assigneeId: string;
  description: string;
  now: number;
}

/**
 * TaskRecord 的唯一工厂。两条派发路径（`assignTask` 的人工派发与
 * `adoptPendingContract` 的契约收养）以前各写一个 20 行字面量，除五个来源不同
 * 的字段外逐行相同 —— 新增 TaskRecord 字段时漏改一处，新旧派发路径就悄悄分叉。
 */
export function createTaskRecord(seed: TaskRecordSeed): TaskRecord {
  return {
    id: seed.id,
    contractId: seed.contract?.id ?? null,
    contractPath: seed.contract?.path,
    title: seed.contract?.title ?? seed.title,
    description: seed.description,
    assigneeId: seed.assigneeId,
    status: 'pending',
    branch: seed.branch,
    reviewRound: 0,
    dependsOn: seed.contract?.dependsOn ?? [],
    touches: seed.contract?.touches ?? [],
    forbidden: seed.contract?.forbidden ?? [],
    gates: null,
    prUrl: null,
    ciStatus: null,
    lastActivityAt: seed.now,
    createdAt: seed.now,
    updatedAt: seed.now,
  };
}

/**
 * 一个团队的累计运行指标（无人值守试点的观测面）。全部是只增计数器，
 * 随 TeamRecord 整体落盘。可选：老 state.json 里没有，`load()` 归一化兜底。
 */
export interface TeamMetrics {
  dispatched: number;
  completed: number;
  reviewRounds: number;
  gateRuns: number;
  gateFailures: number;
  deploys: number;
  rollbacks: number;
  /** 按 EscalationReason 分桶的升级直方图。 */
  escalations: Record<string, number>;
}

export function emptyTeamMetrics(): TeamMetrics {
  return {
    dispatched: 0,
    completed: 0,
    reviewRounds: 0,
    gateRuns: 0,
    gateFailures: 0,
    deploys: 0,
    rollbacks: 0,
    escalations: {},
  };
}

/**
 * 团队阶段的**唯一**缺省口径：老 state.json 里没有 `phase`，一律按 `developing`
 * 处理 —— 那正是本字段出现之前唯一可能的行为。收敛成一个函数而不是三处各写
 * `?? 'developing'`，否则读盘、出视图、判派发迟早会用到不同的默认值。
 */
export const teamPhase = (team: Pick<TeamRecord, 'phase'>): TeamPhase => team.phase ?? 'developing';

/** 一个团队的内存记录：成员、任务、评审与学习记录都随它整体落盘。 */
export interface TeamRecord {
  id: string;
  name: string;
  repoPath: string;
  workspaceRoot: string;
  baseBranch: string;
  /**
   * 文档先行的团队阶段。可选：老 state.json 里没有这个字段，`load()` 一律
   * `?? 'developing'` 兜底（同 metrics / learnings 的兼容约定），因此升级插件
   * 不会把正在跑的团队冻住。
   */
  phase?: TeamPhase | undefined;
  branches: string[];
  members: MemberRecord[];
  tasks: TaskRecord[];
  reviews: ReviewRecord[];
  /**
   * 跨任务教训。可选：老 state.json 里没有这个字段，读取处一律 `?? []` 兜底
   * （同 TaskRecord.contractPath）。`<stateDir>/learnings.md` 是它的全量生成物。
   */
  learnings?: LearningRecord[] | undefined;
  metrics?: TeamMetrics | undefined;
  createdAt: number;
}

export interface PersistedState {
  version: 1;
  teams: TeamRecord[];
  activeTeamId: string | null;
  escalations: EscalationView[];
  /** 可选：老 state.json 没这个字段，`load()` 用 `?? []` 兜底。 */
  questionnaires?: QuestionnaireRecord[];
  /**
   * 工单凭据（ticket id → token）。可选：老 state.json 没这个字段，`load()` 用
   * `?? {}` 兜底，所以它是**内部记录字段而不是视图字段** —— 投影与 `stateVersion`
   * 都不受影响。为什么不能进视图：见 `AutopilotService` 里 `ticketTokens` 的注释
   * （快照会进模型读得到的 session 日志）。
   */
  ticketTokens?: Record<string, string>;
  deploys: DeployView[];
  loopState: LoopState;
  tick: number;
  bootstrapped: boolean;
  lastDeployBaseSha: string | null;
}

/** 一轮守护循环干了什么。设为公开是为了让测试能脱离时序驱动 tickOnce。 */
export interface TickReport {
  tick: number;
  events: string[];
  recovered: string[];
  dispatched: string[];
  escalated: string[];
  deployed: string | null;
  completed: boolean;
}
