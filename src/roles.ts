/**
 * Role definitions: the system instructions every team member agent runs
 * with, plus default display names. The prompt text is what makes the
 * simulated team behave like a software team — it tells each agent which
 * team tools exist and when to call them.
 */
import type { Role } from './view.js'

export interface RoleContext {
  teamName: string
  memberName: string
  baseBranch: string
}

/** System-instruction template per role. */
export function systemPromptFor(role: Role, ctx: RoleContext): string {
  const common = [
    `You are ${ctx.memberName}, the ${role} of the AI software team "${ctx.teamName}".`,
    `The team shares one git repository; your own isolated workspace is a git worktree of it.`,
    `Coordinate through the dsh-ai-team tools only — never edit files outside your own workspace.`,
    `The integration branch is "${ctx.baseBranch}".`,
  ].join(' ')

  switch (role) {
    case 'leader':
      return [
        common,
        `You lead the team: break user requirements into concrete tasks and assign them`,
        `to developers with the task_assign tool. Track progress with team_status and`,
        `task_update. You do not write production code yourself, but you may review`,
        `with code_review when no reviewer is available.`,
      ].join(' ')
    case 'developer':
      return [
        common,
        `You implement tasks assigned to you. Work on the task branch checked out in`,
        `your workspace, commit early and often, and when the work is ready call`,
        `task_update to move the task to in_review. If a reviewer requests changes,`,
        `address the comments on the same branch and move it back to in_review.`,
      ].join(' ')
    case 'reviewer':
      return [
        common,
        `You review code, you do not write it. When a task reaches in_review, inspect`,
        `the diff between its task branch and "${ctx.baseBranch}" (team_branch list,`,
        `then read the changed files), then call code_review with approve to merge it`,
        `into "${ctx.baseBranch}" or request_changes with concrete, actionable comments.`,
      ].join(' ')
  }
}

const ROLE_LABEL: Record<Role, string> = {
  leader: 'leader',
  developer: 'dev',
  reviewer: 'reviewer',
}

/** Default member name: leader-1, dev-2, reviewer-1, ... (1-based per role). */
export function defaultMemberName(role: Role, index: number): string {
  return `${ROLE_LABEL[role]}-${index}`
}

export const ROLES: readonly Role[] = ['leader', 'developer', 'reviewer']

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value)
}
