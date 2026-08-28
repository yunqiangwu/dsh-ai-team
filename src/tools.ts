import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '@deepseek-ai/dsh-session';
import type { AutopilotService } from './service.js';
import './events.js';
import { ROLES } from './roles.js';

/**
 * View objects are plain JSON by construction but lack an index signature,
 * so they cannot satisfy the recursive JsonValue union structurally. This
 * cast is the single audited escape hatch.
 */
const asJson = (value: unknown): JsonValue => value as JsonValue;

const jsonOutput = {
  schema: { type: 'json' },
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value, null, 2) },
  ],
} as const;

/** Push the whole-state snapshot to the calling agent's session log. */
function publish(service: AutopilotService, exec?: ToolRunContext): void {
  exec?.agent?.session.append('autopilot/update', { state: service.projection() });
}

const present = (title: string) => () =>
  ({ card: 'generic', title, kind: 'other', rawInput: {} }) as const;

/** Register all dsh-ai-team tools on the shared tool runtime. */
export function registerAutopilotTools(ctx: Context, service: AutopilotService): void {
  // ── dsh-ai-team compatible tool set ──────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'team_create',
      description:
        'Create an AI software team: a shared git repository plus an initial roster. ' +
        'Exactly one leader is required; developers, reviewers and operators can be added ' +
        'now or later with team_add_member. Every member gets an isolated workspace (a git ' +
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
        const team = await service.createTeam({ name: args.name, members: args.members });
        publish(service, exec);
        return asJson(team);
      },
      presentCall: present('Create AI team'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'team_add_member',
      description:
        'Add an AI agent member to a team. The role (leader / developer / reviewer / operator) ' +
        "decides the member's system instructions; a fresh member branch and an isolated " +
        'workspace are forked from the base branch. Returns the member including its ' +
        "systemPrompt — use it when spawning the member's agent.",
      parameters: {
        teamId: { type: 'string', required: true },
        role: { type: 'string', required: true, enum: ROLES },
        name: { type: 'string', description: 'Display name; auto-generated when omitted' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const input = args as { teamId: string; role: never; name?: string };
        const member = await service.addMember(input);
        publish(service, exec);
        return asJson({ ...member, systemPrompt: service.memberSystemPrompt(input.teamId, member.id) });
      },
      presentCall: present('Add team member'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'team_list',
      description: 'List every AI team with members, workspaces, branches and task board.',
      parameters: {},
      output: jsonOutput,
      async execute() {
        return asJson(service.projection().teams);
      },
      presentCall: present('List AI teams'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'team_status',
      description:
        'Show one team in detail (members, workspace status, active branches, task board, ' +
        'reviews). Refreshes the branch list from the repository first.',
      parameters: {
        teamId: { type: 'string', required: true },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const teamId = args.teamId as string;
        await service.branch({ teamId, action: 'list' });
        publish(service, exec);
        return asJson(service.teamView(teamId));
      },
      presentCall: present('Show team status'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'task_assign',
      description:
        'Assign a task to a developer: creates a task branch from the base branch, checks it ' +
        "out in the assignee's workspace, and puts the task on the board. When contractId is " +
        'given, the matching .tasks/<contractId>.md contract must exist in the repo and be ' +
        'pending — its title/depends_on/touches become the task truth. Fails when the ' +
        'assignee is a reviewer/operator or already busy.',
      parameters: {
        teamId: { type: 'string', required: true },
        title: { type: 'string', required: true, description: 'Short imperative task title' },
        description: { type: 'string', description: 'Detailed requirements and acceptance criteria' },
        assigneeId: { type: 'string', required: true, description: 'Member id (from team_status)' },
        contractId: {
          type: 'string',
          description: 'Task-contract id from .tasks/<id>.md frontmatter; binds the task to the contract file',
        },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const task = await service.assignTask(args);
        publish(service, exec);
        return asJson(task);
      },
      presentCall: present('Assign task'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'task_update',
      description:
        'Move a task along the board: pending → in_progress → in_review. The done and ' +
        'changes_requested states are owned by the review flow (code_review); needs-human ' +
        'is owned by the escalation flow (escalate).',
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
        const task = await service.updateTask(args);
        publish(service, exec);
        return asJson(task);
      },
      presentCall: present('Update task status'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'team_branch',
      description:
        "Git branch collaboration inside a team's shared repository. Actions: list (all " +
        'branches), create (branch from target/base), switch (check out a branch in a ' +
        "member's workspace, needs memberId), merge (merge branch into target/base). " +
        'Approved reviews merge automatically; use this for everything else.',
      parameters: {
        teamId: { type: 'string', required: true },
        action: { type: 'string', required: true, enum: ['list', 'create', 'switch', 'merge'] },
        memberId: { type: 'string', description: 'Required for switch' },
        branch: { type: 'string', description: 'Required for create / switch / merge' },
        target: { type: 'string', description: 'Start point (create) or merge destination; defaults to the base branch' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const result = await service.branch(args);
        publish(service, exec);
        return asJson(result);
      },
      presentCall: present('Branch operation'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'code_review',
      description:
        'Reviewer verdict on a task that is in_review. approve REQUIRES green quality gates ' +
        '(call gates_run first; with a remote, CI must be green too — see pr_sync), then ' +
        'merges the task branch into the base branch with --no-ff. request_changes sends it ' +
        'back to the developer with comments; after maxReviewRounds rejections the task ' +
        'escalates automatically. A merge conflict fails the approval — rebase and review again.',
      parameters: {
        taskId: { type: 'string', required: true },
        reviewerId: { type: 'string', required: true, description: 'Member id of the reviewer (or leader)' },
        verdict: { type: 'string', required: true, enum: ['approve', 'request_changes'] },
        comments: { type: 'string', description: 'Review comments; expected when requesting changes' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const result = await service.review(args);
        publish(service, exec);
        return asJson(result);
      },
      presentCall: present('Review code'),
    }),
  );

  // ── autopilot tools ──────────────────────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'autopilot_init',
      description:
        'Unattended bootstrap of a bare machine + repository: clones the configured remote ' +
        '(authenticating via the env var named by remote.sshKeyEnv — never pass key material ' +
        'directly), detects and rootless-installs the toolchain, runs the repo setup command ' +
        'and the environment verify command. Idempotent: re-calling after success is a no-op. ' +
        'Failures escalate with the bootstrap report.',
      parameters: {
        teamName: { type: 'string', description: 'Team name for the bootstrapped team (first run only)' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const result = await service.initAutopilot(args.teamName as string | undefined);
        publish(service, exec);
        return asJson(result);
      },
      presentCall: present('Bootstrap autopilot'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'autopilot_run',
      description:
        'Start the unattended main loop: crash recovery, needs-human triage, dependency- and ' +
        'domain-lock-aware dispatch, review-round and stuck detection, deploy-on-green, and ' +
        'idle backoff. Idempotent — repeated calls return the current loop state.',
      parameters: {},
      output: jsonOutput,
      async execute(_args, exec) {
        const state = await service.startLoop();
        publish(service, exec);
        return asJson(state);
      },
      presentCall: present('Start autopilot loop'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'autopilot_pause',
      description: 'Pause the unattended main loop (a human or another plugin is stepping in).',
      parameters: {},
      output: jsonOutput,
      async execute(_args, exec) {
        const loopState = service.pauseLoop();
        publish(service, exec);
        return asJson({ loopState });
      },
      presentCall: present('Pause autopilot'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'autopilot_resume',
      description: 'Resume a paused or escalated main loop.',
      parameters: {},
      output: jsonOutput,
      async execute(_args, exec) {
        const loopState = service.resumeLoop();
        publish(service, exec);
        return asJson({ loopState });
      },
      presentCall: present('Resume autopilot'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'gates_run',
      description:
        "Run the configured quality-gate commands in the assignee's worktree for a task. " +
        'Returns each gate with pass/fail, exit code, duration and a redacted log tail. ' +
        'REQUIRED before code_review approve — approve is rejected while gates are red.',
      parameters: {
        taskId: { type: 'string', required: true },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const summary = await service.runGatesForTask({ taskId: args.taskId as string });
        publish(service, exec);
        return asJson(summary);
      },
      presentCall: present('Run quality gates'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'pr_sync',
      description:
        'Push the task branch to the configured remote and (on github) create/update the PR, ' +
        'backfilling the PR URL onto the task; also refreshes CI status. Blocked when gates ' +
        'are red (pushRequiresGates) or the branch diff touches forbidden paths — the latter ' +
        'escalates automatically.',
      parameters: {
        taskId: { type: 'string', required: true },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const result = await service.prSync({ taskId: args.taskId as string });
        publish(service, exec);
        return asJson(result);
      },
      presentCall: present('Sync PR'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'escalate',
      description:
        'Stop and ask for a human: labels the task needs-human, writes a note onto the task ' +
        'contract, fires the notification webhook (context + log tail + suggested action), ' +
        'and pauses per escalation.pauseOnEscalation. Use on ANY escalation trigger: ' +
        'conflicting requirements, cross-domain change, new paid dependency/secret, gate ' +
        'failure not caused by this task, forbidden paths, repeated rework, stuck task. ' +
        'Never improvise around these.',
      parameters: {
        taskId: { type: 'string', description: 'Task to escalate; omit for team-level escalations' },
        reason: {
          type: 'string',
          required: true,
          enum: [
            'conflicting-requirements',
            'cross-domain',
            'paid-dependency',
            'foreign-gate-failure',
            'forbidden-paths',
            'review-rounds-exceeded',
            'task-stuck',
            'deploy-failed',
            'bootstrap-failed',
            'gate-failure',
            'manual',
          ],
        },
        message: { type: 'string', required: true, description: 'What happened, concisely' },
        suggestion: { type: 'string', required: true, description: 'Suggested next action for the human' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const input = args as { taskId?: string; reason: never; message: string; suggestion: string };
        const record = await service.escalateTask({
          taskId: input.taskId ?? null,
          reason: input.reason,
          message: input.message,
          suggestion: input.suggestion,
        });
        publish(service, exec);
        return asJson(record);
      },
      presentCall: present('Escalate to human'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'escalation_resolve',
      description:
        'Triage an escalation after a human acted: marks it resolved and moves the task back ' +
        'to pending so the loop can dispatch it again.',
      parameters: {
        escalationId: { type: 'string', required: true },
      },
      output: jsonOutput,
      async execute(args, exec) {
        await service.resolveEscalation({ escalationId: args.escalationId as string });
        publish(service, exec);
        return asJson({ resolved: args.escalationId as string });
      },
      presentCall: present('Resolve escalation'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'deploy_run',
      description:
        'Deploy from the base branch: runs the configured deploy command, then probes the ' +
        'health-check URL with exponential backoff; three failed probes run the rollback ' +
        'command and escalate. Only meaningful after a green base branch.',
      parameters: {
        teamId: { type: 'string', description: 'Team to deploy; defaults to the first team' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const view = await service.deployRun(args.teamId as string | undefined);
        publish(service, exec);
        return asJson(view);
      },
      presentCall: present('Deploy'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'autopilot_status',
      description:
        'Full autopilot status: loop state and tick, team boards, per-member workspace ' +
        'health, last heartbeat, blocked task list, escalation history and deploy history.',
      parameters: {},
      output: jsonOutput,
      async execute(_args, exec) {
        const status = await service.status();
        publish(service, exec);
        return asJson(status);
      },
      presentCall: present('Autopilot status'),
    }),
  );
}
