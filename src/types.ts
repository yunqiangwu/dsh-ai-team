// Shared domain types for the dsh-ai-team plugin.
// Kept framework-agnostic on purpose: no DSH / Cordis imports here so the
// business logic in `service.ts` can be unit-tested in isolation.

export type MemberRole = 'leader' | 'developer' | 'reviewer' | (string & {});

export type MemberStatus = 'idle' | 'busy' | 'reviewing' | 'done';

export interface Member {
  id: string;
  name: string;
  role: MemberRole;
  /** System instruction that shapes this agent member's behaviour. */
  systemInstruction: string;
  /** Absolute path of this member's isolated git worktree (workspace). */
  workspacePath: string;
  /** Current branch the member is checked out on. */
  branch: string;
  status: MemberStatus;
  createdAt: number;
}

export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked';

export type TaskPriority = 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  title: string;
  description: string;
  /** Member assigned to the task (usually a developer). */
  assigneeId?: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Branch the work is expected to happen on. */
  branch?: string;
  /** Ids of tasks that must complete before this one starts. */
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Team {
  id: string;
  name: string;
  /** Shared git repository root that every member workspace (worktree) links to. */
  repositoryPath: string;
  stateDir: string;
  members: Member[];
  tasks: Task[];
  createdAt: number;
  leaderId?: string;
}

export type ReviewSeverity = 'info' | 'warning' | 'error';

export interface ReviewComment {
  file: string;
  line?: number;
  severity: ReviewSeverity;
  message: string;
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export interface ReviewResult {
  branch: string;
  base: string;
  diffStat: DiffStat;
  comments: ReviewComment[];
  approved: boolean;
}

/** Lightweight, serialisable snapshot consumed by the client panel. */
export interface TeamSnapshot {
  id: string;
  name: string;
  leaderId?: string;
  members: Array<Pick<Member, 'id' | 'name' | 'role' | 'branch' | 'status' | 'workspacePath'>>;
  tasks: Task[];
  branches: string[];
  repositoryPath: string;
  updatedAt: number;
}

export interface PluginSnapshot {
  teams: TeamSnapshot[];
  updatedAt: number;
}
