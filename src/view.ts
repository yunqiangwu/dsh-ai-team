/**
 * Browser-safe view types shared by the host half and the client half.
 * Nothing in this file may import node builtins: the client bundle inlines it.
 *
 * Data flow: host tools / the daemon loop mutate AutopilotService state → the
 * plugin appends an `autopilot/update` session event carrying an
 * {@link AutopilotProjection} snapshot → the `autopilot` session projection
 * folds it (last-write-wins) → the browser panel reads it with
 * useProjection('autopilot').
 */

export const ROLES = ['leader', 'developer', 'reviewer', 'operator'] as const;
export type Role = (typeof ROLES)[number];

export type MemberStatus = 'idle' | 'working' | 'reviewing';

/**
 * Task board state machine (see .tasks/README.md of the target repository):
 *   pending → in_progress → in_review → done
 *                 ↑  └→ changes_requested ─┘
 *                 └→ needs-human (escalated, triaged back to pending)
 */
export const TASK_STATUSES = [
  'pending',
  'in_progress',
  'in_review',
  'changes_requested',
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
  /** Task-contract id from .tasks/<id>.md frontmatter, when present. */
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
  /** Last gate verdicts for this task, newest last. */
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
  createdAt: number;
}

// ── autopilot-specific views ────────────────────────────────────────────────

export type CiStatus = 'pending' | 'success' | 'failure' | 'unknown';

export interface GateResult {
  command: string;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  /** Tail of the command output, secrets redacted. */
  logTail: string;
}

export interface GateSummary {
  taskId: string;
  branch: string;
  allPassed: boolean;
  results: GateResult[];
  ranAt: number;
}

export type EscalationReason =
  | 'conflicting-requirements'
  | 'cross-domain'
  | 'paid-dependency'
  | 'foreign-gate-failure'
  | 'forbidden-paths'
  | 'review-rounds-exceeded'
  | 'task-stuck'
  | 'deploy-failed'
  | 'bootstrap-failed'
  | 'gate-failure'
  | 'manual';

export interface EscalationView {
  id: string;
  taskId: string | null;
  reason: EscalationReason;
  message: string;
  /** Suggested next action for the human. */
  suggestion: string;
  logTail: string;
  webhookDelivered: boolean;
  createdAt: number;
  resolvedAt: number | null;
  /**
   * Human-notification status. When notification is enabled, every escalation
   * tries to email a ticket link; delivery and answer state surface here.
   */
  notification: EscalationNotification | null;
}

/** Delivery/answer state for one escalation's notification. */
export interface EscalationNotification {
  status: 'disabled' | 'sent' | 'failed';
  /** env var name backing the SMTP user (redacted-safe metadata). */
  mailTo: string;
  mailDelivered: boolean;
  ticketUrl: string | null;
  /** Answers submitted through the ticket form, redacted. */
  submitted: Record<string, string> | null;
  submittedAt: number | null;
  /** True when the daemon resumed the loop after a submission. */
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
  /** Task ids currently blocked (needs-human / stuck / failing gates). */
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
