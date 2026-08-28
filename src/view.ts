/**
 * Browser-safe view types shared by the host half and the client half.
 * Nothing in this file may import node builtins: the client bundle inlines it.
 *
 * Data flow: host tools mutate TeamService state → the plugin appends an
 * `ai-team/update` session event carrying an {@link AiTeamProjection}
 * snapshot → the `aiTeam` session projection folds it → the browser panel
 * reads it with useProjection('aiTeam').
 */

/** Team member role. Exactly one leader per team. */
export type Role = 'leader' | 'developer' | 'reviewer'

/** What a member is currently doing (drives the workspace status column). */
export type MemberStatus = 'idle' | 'working' | 'reviewing'

/**
 * Task lifecycle. `done` and `changes_requested` are only reachable through
 * the code_review tool; the kanban renders one column per status.
 */
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'in_review'
  | 'changes_requested'
  | 'done'

export const TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'in_progress',
  'in_review',
  'changes_requested',
  'done',
]

/** Reviewer verdict. `approve` merges the task branch into the base branch. */
export type ReviewVerdict = 'approve' | 'request_changes'

export interface MemberView {
  id: string
  name: string
  role: Role
  /** Absolute path of this member's isolated git worktree. */
  workspacePath: string
  /** Branch currently checked out in the member's workspace. */
  branch: string
  status: MemberStatus
  /** Task the member is actively working on, if any. */
  currentTaskId: string | null
}

export interface TaskView {
  id: string
  title: string
  description: string
  assigneeId: string
  assigneeName: string
  status: TaskStatus
  /** Feature branch backing this task (task/<id>). */
  branch: string
  /** How many times a reviewer requested changes. */
  reviewRound: number
  createdAt: number
  updatedAt: number
}

export interface ReviewView {
  id: string
  taskId: string
  reviewerId: string
  reviewerName: string
  verdict: ReviewVerdict
  comments: string
  createdAt: number
}

export interface TeamView {
  id: string
  name: string
  /** Shared repository every member workspace (git worktree) points at. */
  repoPath: string
  baseBranch: string
  /** Cached branch list, refreshed after every branch-affecting operation. */
  branches: string[]
  members: MemberView[]
  tasks: TaskView[]
  reviews: ReviewView[]
  createdAt: number
}

/** Value of the `aiTeam` session projection; the panel renders this. */
export interface AiTeamProjection {
  teams: TeamView[]
  /** Most recently touched team — the panel focuses it by default. */
  activeTeamId: string | null
}

export const EMPTY_PROJECTION: AiTeamProjection = {
  teams: [],
  activeTeamId: null,
}
