/**
 * 视图投影的纯映射：内部记录（`service/state.ts`）→ 对外视图（schema.ts 派生
 * 类型）。从 AutopilotService 搬出来是为了能脱离 git 工作区与状态机直接单测 ——
 * 视图形状是 `stateVersion` 升版的连带面，schema 演进时的形状断言直接打这里
 * （tests/test-service-modules.ts）。
 *
 * 与 service/report.ts 同一条分工约定：这里是纯函数，编排与副作用留在 service.ts。
 */
import type { CycleView, MemberView, ReviewView, TaskView } from '../view.js';
import {
  requireTeamMember,
  type CycleRecord,
  type MemberRecord,
  type ReviewRecord,
  type TaskRecord,
  type TeamRecord,
} from './state.js';

export function memberView(member: MemberRecord): MemberView {
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    workspacePath: member.workspacePath,
    branch: member.branch,
    status: member.status,
    currentTaskId: member.currentTaskId,
  };
}

export function taskView(team: TeamRecord, task: TaskRecord): TaskView {
  return {
    id: task.id,
    contractId: task.contractId,
    title: task.title,
    description: task.description,
    assigneeId: task.assigneeId,
    assigneeName: requireTeamMember(team, task.assigneeId).name,
    status: task.status,
    branch: task.branch,
    reviewRound: task.reviewRound,
    dependsOn: task.dependsOn,
    touches: task.touches,
    gates: task.gates,
    prUrl: task.prUrl,
    ciStatus: task.ciStatus,
    lastActivityAt: task.lastActivityAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function reviewView(team: TeamRecord, review: ReviewRecord): ReviewView {
  return {
    id: review.id,
    taskId: review.taskId,
    reviewerId: review.reviewerId,
    reviewerName: requireTeamMember(team, review.reviewerId).name,
    verdict: review.verdict,
    comments: review.comments,
    createdAt: review.createdAt,
  };
}

export function cycleView(cycle: CycleRecord): CycleView {
  return {
    id: cycle.id,
    name: cycle.name,
    status: cycle.status,
    goal: cycle.goal,
    scope: [...cycle.scope],
    taskIds: [...cycle.taskIds],
    startedAt: cycle.startedAt ?? null,
    completedAt: cycle.completedAt ?? null,
    createdAt: cycle.createdAt,
  };
}
