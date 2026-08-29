import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '@deepseek-ai/dsh-session';
import type { AutopilotService } from './service.js';
import './events.js';
// 工具层的枚举一律引用唯一词表（经 view.ts 门面）：手抄一份漏掉新值，表现为模型报不出
// 那个原因 / 分类，而编译器和测试都不会响。
import { ESCALATION_REASONS, LEARNING_BUCKETS, LEARNING_KINDS, REVIEW_VERDICTS, ROLES } from './view.js';

/**
 * View 对象在构造上就是纯 JSON，但缺少索引签名，
 * 因此结构上无法满足递归的 JsonValue 联合类型。
 * 这里的 cast 是唯一经过审计的逃生出口。
 */
const asJson = (value: unknown): JsonValue => value as JsonValue;

const jsonOutput = {
  schema: { type: 'json' },
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value, null, 2) },
  ],
} as const;

/** 把全量状态快照推送到调用方 agent 的 session 日志。 */
function publish(service: AutopilotService, exec?: ToolRunContext): void {
  // `autopilot/update` 是本插件自己的信息型全量状态快照。传入 `{ ignorable: true }`
  // 后，读不懂该类型的读取方（例如内核持久化的读取守卫）可以选择跳过它，
  // 而不是拒绝整条日志。该选项只在提供了写入侧标记的 harness 构建上有类型定义，
  // 因此这里用一次受控的 cast：既能对旧版 `@deepseek-ai/dsh-session` 类型编译通过，
  // 又能在 harness 支持时在运行时打上该标记。
  const session = exec?.agent?.session;
  if (session !== undefined) {
    (session.append as unknown as (
      type: string,
      data: unknown,
      opts?: { ignorable: true },
    ) => unknown)('autopilot/update', { state: service.projection() }, { ignorable: true });
  }
}

const present = (title: string) => () =>
  ({ card: 'generic', title, kind: 'other', rawInput: {} }) as const;

/** 在共享的工具运行时上注册全部 dsh-ai-team 工具。 */
export function registerAutopilotTools(ctx: Context, service: AutopilotService): void {
  // ── 核心团队 / 协作工具 ──────────────────────────────────────────────────

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
        specialization: {
          type: 'string',
          description: 'Domain specialization (matches an ownership rule role, e.g. @agent-database)',
        },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const input = args as { teamId: string; role: never; name?: string; specialization?: string };
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
        'is owned by the escalation flow (escalate). This is also how the LEADER answers a ' +
        'clarification: for a task sitting in needs-clarification, only the leader (or a ' +
        'human) may move it back to pending, and the answer must be passed as `note` so it ' +
        'lands on the task contract — the developer reads it there, not from chat. ' +
        '`note` is written onto .tasks/<id>.md as a dated comment.',
      parameters: {
        taskId: { type: 'string', required: true },
        status: {
          type: 'string',
          required: true,
          // 刻意只开三态，不是 TASK_STATUSES 的全集：done 与 changes_requested 归
          // 评审流程所有，needs-human 归升级流程，needs-clarification 由 task_clarify 进入。
          enum: ['pending', 'in_progress', 'in_review'],
        },
        note: { type: 'string', description: 'Progress note / clarification answer, written onto the task contract' },
        actorId: { type: 'string', description: 'Member id performing this move (required to answer a clarification)' },
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
        "member's workspace, needs memberId), merge (merge branch into target/base; like " +
        'approve, the diff vs the target is refused when it touches forbidden paths). ' +
        'Approved reviews merge automatically; use this for everything else.',
      parameters: {
        teamId: { type: 'string', required: true },
        action: { type: 'string', required: true, enum: ['list', 'create', 'switch', 'merge'] },
        memberId: { type: 'string', description: 'Required for switch' },
        branch: {
          type: 'string',
          description:
            'Required for create / switch / merge. Must start with a letter or digit and use only . _ - + / @ (no leading "-", no spaces, no "..")',
        },
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
        'merges the task branch into the base branch with the profile merge strategy. Before ' +
        'merging, the branch diff vs base is checked against the forbidden paths ' +
        '(security.forbiddenPaths / the profile human-only rules): a hit refuses the merge and ' +
        'escalates the task to needs-human — green gates do not license a human-only file. When ' +
        'daemon.maxDiffLines/maxDiffFiles are set, an oversized diff is refused and escalated ' +
        'as change-too-large instead. request_changes writes your comments onto the task ' +
        'contract (.tasks/<id>.md) and captures them as a lesson for later tasks; after ' +
        'maxReviewRounds rejections the task escalates automatically. A merge conflict fails ' +
        'the approval — rebase and review again.',
      parameters: {
        taskId: { type: 'string', required: true },
        reviewerId: { type: 'string', required: true, description: 'Member id of the reviewer (or leader)' },
        verdict: { type: 'string', required: true, enum: REVIEW_VERDICTS },
        comments: { type: 'string', description: 'Review comments; expected when requesting changes' },
        contractAmbiguity: {
          type: 'boolean',
          description: 'Set when the root cause is the task contract being ambiguous/self-contradictory rather than the code',
        },
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
        'failure not caused by this task, forbidden paths, repeated rework, stuck task, ' +
        'change too large for one task. Never improvise around these. ' +
        'If the task contract itself is ambiguous or self-contradictory, prefer task_clarify ' +
        '(send it back to the leader; it costs you no rework round).',
      parameters: {
        taskId: { type: 'string', description: 'Task to escalate; omit for team-level escalations' },
        reason: {
          type: 'string',
          required: true,
          enum: ESCALATION_REASONS,
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

  ctx.tools.register(
    defineTool({
      name: 'task_clarify',
      description:
        'Send a task back to the leader because its CONTRACT is ambiguous or ' +
        'self-contradictory (acceptance criteria that conflict, touches that cannot hold, ' +
        'a dependency that is not specified). Use this INSTEAD of escalate for that case: ' +
        'it does NOT count against your rework rounds, creates no escalation and does not ' +
        'label the task needs-human. The task moves to needs-clarification, your workspace ' +
        'is released so you can take other work, and the question is written onto the task ' +
        'contract. Only the leader (or a human) can move it back to pending, and the answer ' +
        'lands as a contract note. Not for "I am stuck" — that is escalate.',
      parameters: {
        taskId: { type: 'string', required: true },
        memberId: { type: 'string', required: true, description: 'The developer asking (must be the assignee role)' },
        question: { type: 'string', required: true, description: 'What exactly must be decided before this can be built' },
        ambiguousPoints: { type: 'array', items: { type: 'string' }, description: 'Each contradictory or underspecified point' },
        proposedResolutions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Options you see, so the leader can pick one instead of re-deriving them',
        },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const task = await service.clarifyTask(args);
        publish(service, exec);
        return asJson(task);
      },
      presentCall: present('Ask leader to clarify'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'learning_record',
      description:
        'Record one reusable pitfall so the NEXT task touching these directories does not ' +
        'repeat it. One concrete pitfall per call. Write the summary as a rule a reader can ' +
        'follow without any context: what breaks, why, and what to do instead (e.g. "touching ' +
        'server/db/ requires pnpm run db:check-parity before the gate will pass"). Summaries ' +
        'are injected into later task descriptions, so vague entries actively hurt people. ' +
        'Never paste secrets or raw env values — they are redacted, but the record loses its ' +
        'point. Captured automatically for review rejections and escalations; use this for ' +
        'what you learned the hard way outside those. No-op when learnings.enabled is false.',
      parameters: {
        kind: { type: 'string', required: true, enum: LEARNING_KINDS, description: 'Where this lesson came from' },
        summary: { type: 'string', required: true, description: 'One line, imperative, self-contained' },
        detail: { type: 'string', description: 'The original evidence: error text, comment, log tail' },
        touches: { type: 'array', items: { type: 'string' }, description: 'Directories this lesson applies to' },
        taskId: { type: 'string', description: 'Task you learned it on (also selects the team)' },
        teamId: { type: 'string', description: 'Team to record against when there is no task' },
        bucket: {
          type: 'string',
          enum: LEARNING_BUCKETS,
          description: 'Intent class; used to merge repeats of the same pitfall',
        },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const input = args as {
          kind: (typeof LEARNING_KINDS)[number];
          summary: string;
          detail?: string;
          touches?: string[];
          taskId?: string;
          teamId?: string;
          bucket?: (typeof LEARNING_BUCKETS)[number];
        };
        const learning = await service.learningRecord(input);
        publish(service, exec);
        return asJson(learning ?? { recorded: false, reason: 'learnings.enabled is false' });
      },
      presentCall: present('Record a lesson'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'learning_list',
      description:
        'Read the lessons captured so far: newest and most-corroborated first, with hit ' +
        'counts and the pending-promotion queue (a lesson confirmed promoteAfterHits times ' +
        'deserves a place in the project docs — decided by a human, never by the agent). ' +
        'Call it before starting work in an unfamiliar area, and again when a task description ' +
        'mentions "另有 N 条未注入".',
      parameters: {
        teamId: { type: 'string' },
        touches: { type: 'array', items: { type: 'string' }, description: 'Rank by relevance to these directories' },
        kind: { type: 'string', enum: LEARNING_KINDS },
        limit: { type: 'number', description: 'Max entries to return; default 20' },
      },
      output: jsonOutput,
      async execute(args) {
        const input = args as { teamId?: string; touches?: string[]; kind?: (typeof LEARNING_KINDS)[number]; limit?: number };
        // 纯读工具：不发快照（与 team_list 一致，避免读操作产生事件流量）。
        return asJson(service.learningList(input));
      },
      presentCall: present('List lessons'),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'learning_promote',
      description:
        'Close the loop on one lesson: mark-promoted once a HUMAN has written it into the ' +
        'project docs (AGENTS.md / docs/ / ownership rules) — it then stops being injected ' +
        'into task descriptions because the project itself carries it; or dismiss it when it ' +
        'was a one-off. This only flips the ledger: it never edits project documents, since ' +
        'those paths are human-only and rewriting docs from the loop has no objective signal ' +
        'to verify against.',
      parameters: {
        id: { type: 'string', required: true, description: 'Learning id from learning_list' },
        action: { type: 'string', required: true, enum: ['mark-promoted', 'dismiss'] },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const input = args as { id: string; action: 'mark-promoted' | 'dismiss' };
        const learning = await service.learningPromote(input);
        publish(service, exec);
        return asJson(learning);
      },
      presentCall: present('Promote or dismiss a lesson'),
    }),
  );
}
