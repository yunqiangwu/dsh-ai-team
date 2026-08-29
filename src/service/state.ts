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

/** 一个团队的内存记录：成员、任务、评审与学习记录都随它整体落盘。 */
export interface TeamRecord {
  id: string;
  name: string;
  repoPath: string;
  workspaceRoot: string;
  baseBranch: string;
  branches: string[];
  members: MemberRecord[];
  tasks: TaskRecord[];
  reviews: ReviewRecord[];
  /**
   * 跨任务教训。可选：老 state.json 里没有这个字段，读取处一律 `?? []` 兜底
   * （同 TaskRecord.contractPath）。`<stateDir>/learnings.md` 是它的全量生成物。
   */
  learnings?: LearningRecord[] | undefined;
  createdAt: number;
}

export interface PersistedState {
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
