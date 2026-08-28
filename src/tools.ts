/**
 * Model-facing tools of dsh-ai-team, registered on ctx.tools. Every mutation
 * ends by appending an `ai-team/update` session event with the whole-state
 * snapshot, which is what drives both the `aiTeam` projection (the Web UI
 * panel) and any other consumer replaying the log.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import './events.js'
import type { TeamService } from './service.js'
import { ROLES } from './roles.js'

/**
 * View objects are plain JSON by construction but lack an index signature,
 * so they cannot satisfy the recursive JsonValue union structurally. This
 * cast is the single audited escape hatch.
 */
const asJson = (value: unknown): JsonValue => value as JsonValue

const jsonOutput = {
  schema: { type: 'json' },
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value, null, 2) },
  ],
} as const

/** Push the whole-state snapshot to the calling agent's session log. */
function publish(service: TeamService, exec?: ToolRunContext): void {
  exec?.agent?.session.append('ai-team/update', { state: service.projection() })
}

const present = (title: string) => () =>
  ({ card: 'generic', title, kind: 'other', rawInput: {} }) as const

/** Register all dsh-ai-team tools on the shared tool runtime. */
export function registerTeamTools(ctx: Context, service: TeamService): void {
  ctx.tools.register(
    defineTool({
      name: 'team_create',
      description:
        'Create an AI software team: a shared git repository plus an initial roster. ' +
        'Exactly one leader is required; developers and reviewers can be added now or ' +
        'later with team_add_member. Every member gets an isolated workspace (a git ' +
        'worktree of the shared repository). Returns the created team.',
      parameters: {
        name: { type: 'string', required: true, description: 'Human-readable team name' },
        members: {
          type: 'array',
          description:
            'Initial roster as {role, name?} objects; defaults to a single leader. Must contain exactly one leader.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              role: { type: 'string', required: true, enum: ROLES },
              name: { type: 'string', description: 'Display name; auto-generated when omitted' },
            },
          },
        },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const team = await service.createTeam({ name: args.name, members: args.members })
        publish(service, exec)
        return asJson(team)
      },
      presentCall: present('Create AI team'),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'team_add_member',
      description:
        'Add an AI agent member to a team. The role (leader / developer / reviewer) ' +
        'decides the member\'s system instructions; a fresh member branch and an ' +
        'isolated workspace are forked from the base branch. Returns the member ' +
        'including its systemPrompt — use it when spawning the member\'s agent.',
      parameters: {
        teamId: { type: 'string', required: true },
        role: { type: 'string', required: true, enum: ROLES },
        name: { type: 'string', description: 'Display name; auto-generated when omitted' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const member = await service.addMember(args)
        publish(service, exec)
        return asJson({ ...member, systemPrompt: service.memberSystemPrompt(args.teamId, member.id) })
      },
      presentCall: present('Add team member'),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'team_list',
      description: 'List every AI team with members, workspaces, branches and task board.',
      parameters: {},
      output: jsonOutput,
      async execute() {
        return asJson(service.projection().teams)
      },
      presentCall: present('List AI teams'),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'team_status',
      description:
        'Show one team in detail (members, workspace status, active branches, task ' +
        'board, reviews). Refreshes the branch list from the repository first.',
      parameters: {
        teamId: { type: 'string', required: true },
      },
      output: jsonOutput,
      async execute(args, exec) {
        await service.branch({ teamId: args.teamId, action: 'list' })
        publish(service, exec)
        return asJson(service.teamView(args.teamId))
      },
      presentCall: present('Show team status'),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'task_assign',
      description:
        'Leader assigns a task to a developer: creates a task branch (task/<id>) from ' +
        'the base branch, checks it out in the assignee\'s workspace, and puts the ' +
        'task on the board as pending. Fails when the assignee is a reviewer or ' +
        'already busy.',
      parameters: {
        teamId: { type: 'string', required: true },
        title: { type: 'string', required: true, description: 'Short imperative task title' },
        description: { type: 'string', description: 'Detailed requirements and acceptance criteria' },
        assigneeId: { type: 'string', required: true, description: 'Member id (from team_status)' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const task = await service.assignTask(args)
        publish(service, exec)
        return asJson(task)
      },
      presentCall: present('Assign task'),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'task_update',
      description:
        'Move a task along the board: pending → in_progress → in_review. The done and ' +
        'changes_requested states are owned by the review flow; use code_review for them.',
      parameters: {
        taskId: { type: 'string', required: true },
        status: {
          type: 'string',
          required: true,
          enum: ['pending', 'in_progress', 'in_review'],
        },
        note: { type: 'string', description: 'Optional progress note' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const task = await service.updateTask(args)
        publish(service, exec)
        return asJson(task)
      },
      presentCall: present('Update task status'),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'team_branch',
      description:
        'Git branch collaboration inside a team\'s shared repository. Actions: ' +
        'list (all branches), create (branch from target/base), switch (check out a ' +
        'branch in a member\'s workspace, needs memberId), merge (merge branch into ' +
        'target/base). Approved reviews merge automatically; use this for everything else.',
      parameters: {
        teamId: { type: 'string', required: true },
        action: { type: 'string', required: true, enum: ['list', 'create', 'switch', 'merge'] },
        memberId: { type: 'string', description: 'Required for switch' },
        branch: { type: 'string', description: 'Required for create / switch / merge' },
        target: { type: 'string', description: 'Start point (create) or merge destination; defaults to the base branch' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const result = await service.branch(args)
        publish(service, exec)
        return asJson(result)
      },
      presentCall: present('Branch operation'),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'code_review',
      description:
        'Reviewer verdict on a task that is in_review. approve merges the task branch ' +
        'into the base branch and closes the task; request_changes sends it back to ' +
        'the developer with comments. A merge conflict fails the approval — rebase ' +
        'the task branch and review again.',
      parameters: {
        taskId: { type: 'string', required: true },
        reviewerId: { type: 'string', required: true, description: 'Member id of the reviewer (or leader)' },
        verdict: { type: 'string', required: true, enum: ['approve', 'request_changes'] },
        comments: { type: 'string', description: 'Review comments; expected when requesting changes' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const result = await service.review(args)
        publish(service, exec)
        return asJson(result)
      },
      presentCall: present('Review code'),
    }),
  )
}
