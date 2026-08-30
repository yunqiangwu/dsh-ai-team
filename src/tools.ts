import {
  defineTool,
  type InferArgs,
  type ParameterSchemaSpec,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '@deepseek-ai/dsh-session';
import type { AutopilotService } from './service.js';
import type { ContractDraft } from './service/contracts.js';
import type { RuntimeConfig } from './service/options.js';
import './events.js';
// 工具层的枚举一律引用唯一词表（经 view.ts 门面）：手抄一份漏掉新值，表现为模型报不出
// 那个原因 / 分类，而编译器和测试都不会响。
import {
  ANSWER_BINDING_TYPES,
  ESCALATION_REASONS,
  LEARNING_BUCKETS,
  LEARNING_KINDS,
  PAUSE_ON_ESCALATION,
  QUESTIONNAIRE_KINDS,
  QUESTIONNAIRE_MODES,
  QUESTION_TYPES,
  REMOTE_PLATFORMS,
  REVIEW_VERDICTS,
  ROLES,
  TASK_MOVEABLE_STATUSES,
  TEAM_PHASES,
} from './view.js';
import type { Question, QuestionBinding, TeamPhase } from './view.js';

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

/** session 句柄：只用到 `append`，类型从 ToolRunContext 反推，避免手抄宿主签名。 */
type SessionHandle = NonNullable<NonNullable<ToolRunContext['agent']>['session']>;

/**
 * 最近一次调用过本插件工具的 session，按服务实例索引。
 * 工单答卷由 TicketServer 的 HTTP 回调处理，那条路径上没有 `exec` —— 想找回到
 * 底该推给谁，只能靠这里记下的句柄。用 WeakMap 而不是模块级单例：一次进程里可能
 * 有多个 ctx/service（测试就会），既不能串台，也不该把已销毁的 service 钉在内存里。
 */
const lastSessions = new WeakMap<AutopilotService, SessionHandle>();

/** 把全量状态快照追加为一条 `autopilot/update` 事件。 */
function appendSnapshot(service: AutopilotService, session: SessionHandle): void {
  // `autopilot/update` 是本插件自己的信息型全量状态快照。传入 `{ ignorable: true }`
  // 后，读不懂该类型的读取方（例如内核持久化的读取守卫）可以选择跳过它，
  // 而不是拒绝整条日志。该选项只在提供了写入侧标记的 harness 构建上有类型定义，
  // 因此这里用一次受控的 cast：既能对旧版 `@deepseek-ai/dsh-session` 类型编译通过，
  // 又能在 harness 支持时在运行时打上该标记。
  (session.append as unknown as (
    type: string,
    data: unknown,
    opts?: { ignorable: true },
  ) => unknown)('autopilot/update', { state: service.projection() }, { ignorable: true });
}

/** 把全量状态快照推送到调用方 agent 的 session 日志。 */
function publish(service: AutopilotService, exec?: ToolRunContext): void {
  const session = exec?.agent?.session;
  if (session === undefined) return;
  lastSessions.set(service, session);
  appendSnapshot(service, session);
}

const present = (title: string) => () =>
  ({ card: 'generic', title, kind: 'other', rawInput: {} }) as const;

/** 在共享的工具运行时上注册全部 dsh-ai-team 工具。 */
export function registerAutopilotTools(ctx: Context, service: AutopilotService): void {
  // 带外变更的快照出口：工单答卷来自 TicketServer 的 HTTP 回调，那条栈里没有 `exec`，
  // 于是 `this.changed()` 只落了盘、没人往 session 追加事件 —— 人答完问卷要等到下一次
  // 工具调用才看得到面板刷新。登记一次，让那条路径也推一帧。
  service.setSnapshotPublisher(() => {
    const session = lastSessions.get(service);
    if (session === undefined) return;
    try {
      appendSnapshot(service, session);
    } catch (error) {
      // session 可能已经销毁。失败要留痕：静默吞掉的话，"答复没生效"就又变成一次人肉排查。
      ctx.logger.warn('autopilot: out-of-band snapshot publish failed', error);
    }
  });

  // 写侧工具的统一注册口：`output` 固定走 JSON 渲染，execute 返回原始视图对象
  //（不手写 asJson），返回前统一 publish 一次全量快照。只读工具（team_list /
  // learning_list）不走这里 —— 读操作不产生事件流量。`const S` 透传 defineTool
  // 的字面量推导，各 execute 体内的 args 类型与直接注册时一致。
  function registerPublishingTool<const S extends ParameterSchemaSpec>(spec: {
    name: string;
    description: string;
    parameters: S;
    presentCall?: ReturnType<typeof present>;
    execute: (args: InferArgs<S>, exec: ToolRunContext) => Promise<unknown>;
  }): void {
    ctx.tools.register(
      defineTool({
        ...spec,
        output: jsonOutput,
        async execute(args, exec) {
          const result = await spec.execute(args, exec);
          publish(service, exec);
          return asJson(result);
        },
      }),
    );
  }

  // ── 核心团队 / 协作工具 ──────────────────────────────────────────────────

  registerPublishingTool({
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
    async execute(args) {
      const team = await service.createTeam({ name: args.name, members: args.members });
      return team;
    },
    presentCall: present('Create AI team'),
  });

  registerPublishingTool({
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
    async execute(args) {
      const input = args as { teamId: string; role: never; name?: string; specialization?: string };
      const member = await service.addMember(input);
      return { ...member, systemPrompt: service.memberSystemPrompt(input.teamId, member.id) };
    },
    presentCall: present('Add team member'),
  });

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

  registerPublishingTool({
    name: 'team_status',
    description:
      'Show one team in detail (members, workspace status, active branches, task board, ' +
      'reviews). Refreshes the branch list from the repository first.',
    parameters: {
      teamId: { type: 'string', required: true },
    },
    async execute(args) {
      const teamId = args.teamId as string;
      await service.branch({ teamId, action: 'list' });
      return service.teamView(teamId);
    },
    presentCall: present('Show team status'),
  });

  registerPublishingTool({
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
    async execute(args) {
      const task = await service.assignTask(args);
      return task;
    },
    presentCall: present('Assign task'),
  });

  registerPublishingTool({
    name: 'task_update',
    description:
      'Move a task along the board: pending → in_progress → in_review, and/or adjust its dispatch ' +
      'priority (higher dispatches first among tasks whose dependencies are equally satisfied — it never ' +
      'jumps ahead of a task whose deps are ready while yours are not). Pass at least one of status / ' +
      'priority / note. The done and changes_requested states are owned by the review flow (code_review); ' +
      'needs-human is owned by the escalation flow (escalate); cancelling a task is task_cancel. This is ' +
      'also how the LEADER answers a clarification: for a task sitting in needs-clarification, only the ' +
      'leader (or a human) may move it back to pending, and the answer must be passed as `note` so it ' +
      'lands on the task contract — the developer reads it there, not from chat. ' +
      '`note` is written onto .tasks/<id>.md as a dated comment.',
    parameters: {
      taskId: { type: 'string', required: true },
        status: {
          type: 'string',
          // 刻意只开 TASK_MOVEABLE_STATUSES 子集，不是 TASK_STATUSES 的全集：
          // done 与 changes_requested 归评审流程所有，needs-human 归升级流程，
          // needs-clarification 由 task_clarify 进入；cancelled 归 task_cancel。
          enum: TASK_MOVEABLE_STATUSES,
        },
      priority: {
        type: 'number',
        description: 'Dispatch weight (M3 replanning): higher first among dependency-equal tasks; default 0',
      },
      note: { type: 'string', description: 'Progress note / clarification answer, written onto the task contract' },
      actorId: { type: 'string', description: 'Member id performing this move (required to answer a clarification)' },
    },
    async execute(args) {
      const task = await service.updateTask(args);
      return task;
    },
    presentCall: present('Update task status'),
  });

  registerPublishingTool({
    name: 'task_cancel',
    description:
      'Cancel a task that has NOT been dispatched yet (status pending). The contract file stays in ' +
      '.tasks/ with status cancelled — cancellation is traceable, never a deletion — and the board ' +
      'gains it in the cancelled section. This is an autonomous replanning move: no escalation, no ' +
      'notification. An in-flight task (in_progress / in_review) cannot be cancelled here — withdrawing ' +
      'it means losing its branch, and that requires a human via task_replan(disposition:"abort"). ' +
      'Downstream tasks that depend on this one will escalate as blocked-dependency until you fix or ' +
      'drop their depends_on.',
    parameters: {
      taskId: { type: 'string', required: true },
      reason: { type: 'string', description: 'Why this work is being dropped; written onto the task contract' },
    },
    async execute(args) {
      const task = await service.taskCancel({ taskId: args.taskId as string, reason: args.reason as string | undefined });
      return task;
    },
    presentCall: present('Cancel a pending task'),
  });

  registerPublishingTool({
    name: 'task_replan',
    description:
      'Apply a requirement change to an IN-FLIGHT task (in_progress / in_review), choosing one of the ' +
      'three dispositions: supersede (let the original land as-is via the normal review flow — branch ' +
      'kept — and derive a follow-up contract for the correction; the follow-up depends_on the original), ' +
      'continue (the original keeps going; a follow-up contract carries the increment), or abort (discard ' +
      'the in-flight work and its branch — losing work needs a human, so this opens a replan ' +
      'questionnaire and lands NOTHING until a person approves; a silent form defaults to "keep going"). ' +
      'supersede/continue never rewrite the original acceptance criteria: the change lands as a NEW ' +
      'derived contract (id continues the same domain sequence) plus a dated [replan] note on the ' +
      'original. Rate-limited by replan.maxPerHour together with task_cancel.',
    parameters: {
      taskId: { type: 'string', required: true },
      disposition: { type: 'string', required: true, enum: ['supersede', 'continue', 'abort'] },
      changeNote: { type: 'string', required: true, description: 'What changed in the requirements and why' },
      followup: {
        type: 'object',
        description: 'The derived contract for supersede/continue (required for those dispositions); fields default to the original task',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          body: { type: 'string', description: 'Gherkin acceptance criteria; defaults to a stub derived from changeNote' },
          owner: { type: 'string', description: 'Defaults to leader' },
          touches: { type: 'array', items: { type: 'string' }, description: 'Defaults to the original touches' },
          forbidden: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'Defaults to [original] for supersede, [] for continue' },
          priority: { type: 'number' },
        },
      },
    },
    async execute(args) {
      const result = await service.replanTask(args);
      return result;
    },
    presentCall: present('Replan an in-flight task'),
  });

  registerPublishingTool({
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
    async execute(args) {
      const result = await service.branch(args);
      return result;
    },
    presentCall: present('Branch operation'),
  });

  registerPublishingTool({
    name: 'code_review',
    description:
      'Reviewer verdict on a task that is in_review. approve REQUIRES green quality gates ' +
      '(call gates_run first; with a remote, CI must be green too — see pr_sync), then ' +
      'merges the task branch into the base branch with the profile merge strategy. Before ' +
      'merging, the branch diff vs base is checked against the forbidden paths ' +
      '(security.forbiddenPaths / the profile block rules): a hit refuses the merge and ' +
      'escalates the task to needs-human — green gates do not license a forbidden file. When ' +
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
    async execute(args) {
      const result = await service.review(args);
      return result;
    },
    presentCall: present('Review code'),
  });

  // ── autopilot tools ──────────────────────────────────────────────────────

  registerPublishingTool({
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
    async execute(args) {
      const result = await service.initAutopilot(args.teamName as string | undefined);
      return result;
    },
    presentCall: present('Bootstrap autopilot'),
  });

  registerPublishingTool({
    name: 'autopilot_run',
    description:
      'Start the unattended main loop: crash recovery, needs-human triage, dependency- and ' +
      'domain-lock-aware dispatch, review-round and stuck detection, deploy-on-green, and ' +
      'idle backoff. Idempotent — repeated calls return the current loop state.',
    parameters: {},
    async execute(_args) {
      const state = await service.startLoop();
      return state;
    },
    presentCall: present('Start autopilot loop'),
  });

  registerPublishingTool({
    name: 'autopilot_phase',
    description:
      'Read or move a team\'s document-first phase: intake → kickoff_pending_approval → ' +
      'scaffolding → developing ⇄ replanning. Omit `phase` to just read the current one. ' +
      'The daemon only dispatches tasks while the team is in developing or replanning — in ' +
      'any other phase the loop recovers, triages and deploys but hands out no new work. ' +
      'Do NOT use this to get past a pending document approval: that transition belongs to ' +
      'the approval flow (which records who approved and verifies the document hash), and ' +
      'jumping the phase by hand turns "a human signed off" into an unverified claim.',
    parameters: {
      teamId: { type: 'string', required: true },
      phase: { type: 'string', enum: TEAM_PHASES, description: 'Target phase; omit to query' },
    },
    async execute(args) {
      const teamId = args.teamId as string;
      const phase = args.phase as TeamPhase | undefined;
      const team = phase === undefined ? service.teamView(teamId) : service.setPhase({ teamId, phase });
      return team;
    },
    presentCall: present('Set team phase'),
  });

  registerPublishingTool({
    name: 'autopilot_pause',
    description: 'Pause the unattended main loop (a human or another plugin is stepping in).',
    parameters: {},
    async execute(_args) {
      const loopState = service.pauseLoop();
      return { loopState };
    },
    presentCall: present('Pause autopilot'),
  });

  registerPublishingTool({
    name: 'autopilot_resume',
    description: 'Resume a paused or escalated main loop.',
    parameters: {},
    async execute(_args) {
      const loopState = service.resumeLoop();
      return { loopState };
    },
    presentCall: present('Resume autopilot'),
  });

  registerPublishingTool({
    name: 'gates_run',
    description:
      "Run the configured quality-gate commands in the assignee's worktree for a task. " +
      'Returns each gate with pass/fail, exit code, duration and a redacted log tail. ' +
      'REQUIRED before code_review approve — approve is rejected while gates are red.',
    parameters: {
      taskId: { type: 'string', required: true },
    },
    async execute(args) {
      const summary = await service.runGatesForTask({ taskId: args.taskId as string });
      return summary;
    },
    presentCall: present('Run quality gates'),
  });

  registerPublishingTool({
    name: 'pr_sync',
    description:
      'Push the task branch to the configured remote and (on github) create/update the PR, ' +
      'backfilling the PR URL onto the task; also refreshes CI status. Blocked when gates ' +
      'are red (pushRequiresGates) or the branch diff touches forbidden paths — the latter ' +
      'escalates automatically.',
    parameters: {
      taskId: { type: 'string', required: true },
    },
    async execute(args) {
      const result = await service.prSync({ taskId: args.taskId as string });
      return result;
    },
    presentCall: present('Sync PR'),
  });

  registerPublishingTool({
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
    async execute(args) {
      const input = args as { taskId?: string; reason: never; message: string; suggestion: string };
      const record = await service.escalateTask({
        taskId: input.taskId ?? null,
        reason: input.reason,
        message: input.message,
        suggestion: input.suggestion,
      });
      return record;
    },
    presentCall: present('Escalate to human'),
  });

  registerPublishingTool({
    name: 'escalation_resolve',
    description:
      'Triage an escalation after a human acted: marks it resolved and moves the task back ' +
      'to pending so the loop can dispatch it again.',
    parameters: {
      escalationId: { type: 'string', required: true },
    },
    async execute(args) {
      await service.resolveEscalation({ escalationId: args.escalationId as string });
      return { resolved: args.escalationId as string };
    },
    presentCall: present('Resolve escalation'),
  });

  registerPublishingTool({
    name: 'deploy_run',
    description:
      'Deploy from the base branch: runs the configured deploy command, then probes the ' +
      'health-check URL with exponential backoff; three failed probes run the rollback ' +
      'command and escalate. Only meaningful after a green base branch.',
    parameters: {
      teamId: { type: 'string', description: 'Team to deploy; defaults to the first team' },
    },
    async execute(args) {
      const view = await service.deployRun(args.teamId as string | undefined);
      return view;
    },
    presentCall: present('Deploy'),
  });

  registerPublishingTool({
    name: 'autopilot_status',
    description:
      'Full autopilot status: loop state and tick, team boards, per-member workspace ' +
      'health, last heartbeat, blocked task list, escalation history and deploy history.',
    parameters: {},
    async execute(_args) {
      const status = await service.status();
      return status;
    },
    presentCall: present('Autopilot status'),
  });

  // ── 运行时配置（热改，免重启）─────────────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'config_show',
      description:
        'Show the EFFECTIVE runtime configuration (config file baseline merged with ' +
        'runtime overrides). Values are env var names and paths, not secrets — they are ' +
        'still redacted before rendering. Call this to see what the team is actually ' +
        'configured with, then change it with config_set without restarting the host.',
      parameters: {},
      output: jsonOutput,
      async execute() {
        return asJson(service.runtimeConfigView());
      },
      presentCall: present('Show effective config'),
    }),
  );

  registerPublishingTool({
    name: 'config_set',
    description:
      'Change the EFFECTIVE runtime configuration at runtime — no host restart needed. ' +
      'Only pass the fields you want to override; omitted groups keep their current values. ' +
      'Purely scalar/array fields replace wholesale; group objects (remote / gates / ' +
      'daemon / security …) merge per key. This is how a leader configures the repo ' +
      'address, branch name, gate commands etc. in plain language instead of editing a ' +
      'config file. Takes effect on the next operation — the running loop reads the ' +
      'merged options fresh each time. Returns the new effective config.',
    parameters: {
      baseBranch: { type: 'string', description: 'Integration branch (default main)' },
      remote: {
        type: 'object',
        additionalProperties: false,
        description: 'Remote repo details',
        properties: {
          url: { type: 'string', description: 'Clone/push URL, e.g. git@github.com:o/r.git or a local /path/repo.git' },
          sshKeyEnv: { type: 'string', description: 'Env var name holding the SSH private key TEXT' },
          platform: { type: 'string', enum: REMOTE_PLATFORMS },
          apiTokenEnv: { type: 'string', description: 'Env var name for a platform API token (github)' },
        },
      },
      bootstrap: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          toolchain: { type: 'array', items: { type: 'string' } },
          setupCommand: { type: 'string' },
          verifyCommand: { type: 'string' },
        },
      },
      gates: {
        type: 'object',
        additionalProperties: false,
        properties: {
          commands: { type: 'array', items: { type: 'string' }, description: 'Quality-gate commands, ran in order' },
          requireCiGreen: { type: 'boolean', description: 'Reject approve unless CI is green (github only)' },
          timeoutMinutes: { type: 'number' },
        },
      },
      daemon: {
        type: 'object',
        additionalProperties: false,
        properties: {
          maxReviewRounds: { type: 'number' },
          stuckMinutes: { type: 'number' },
          pollIntervalSeconds: { type: 'number' },
          maxDiffLines: { type: 'number' },
          maxDiffFiles: { type: 'number' },
          maxTaskHours: { type: 'number' },
        },
      },
      escalation: {
        type: 'object',
        additionalProperties: false,
        properties: {
          webhookUrlEnv: { type: 'string' },
          label: { type: 'string' },
          pauseOnEscalation: { type: 'string', enum: PAUSE_ON_ESCALATION },
        },
      },
      security: {
        type: 'object',
        additionalProperties: false,
        properties: {
          forbiddenPaths: { type: 'array', items: { type: 'string' } },
          commandAllowlist: { type: 'array', items: { type: 'string' } },
          pushRequiresGates: { type: 'boolean' },
        },
      },
      learnings: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          injectMaxCount: { type: 'number' },
          injectCharBudget: { type: 'number' },
          promoteAfterHits: { type: 'number' },
          maxEntries: { type: 'number' },
        },
      },
    },
    async execute(args) {
      const input = args as unknown as RuntimeConfig;
      return service.setRuntimeConfig(input);
    },
    presentCall: present('Set runtime config'),
  });

  registerPublishingTool({
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
    async execute(args) {
      const task = await service.clarifyTask(args);
      return task;
    },
    presentCall: present('Ask leader to clarify'),
  });

  registerPublishingTool({
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
    async execute(args) {
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
      return learning ?? { recorded: false, reason: 'learnings.enabled is false' };
    },
    presentCall: present('Record a lesson'),
  });

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

  registerPublishingTool({
    name: 'learning_promote',
    description:
      'Close the loop on one lesson: mark-promoted once it has actually landed in the ' +
      'project docs (AGENTS.md / docs/ / ownership rules) — it then stops being injected ' +
      'into task descriptions because the project itself carries it; or dismiss it when it ' +
      'was a one-off. This only flips the ledger: it does not edit project documents. Landing ' +
      'one is its own docs-only change, because rewriting docs from the loop has no objective ' +
      'signal to verify against.',
    parameters: {
      id: { type: 'string', required: true, description: 'Learning id from learning_list' },
      action: { type: 'string', required: true, enum: ['mark-promoted', 'dismiss'] },
    },
    async execute(args) {
      const input = args as { id: string; action: 'mark-promoted' | 'dismiss' };
      const learning = await service.learningPromote(input);
      return learning;
    },
    presentCall: present('Promote or dismiss a lesson'),
  });

  // ── 人工决策 / 文档先行（docs/design-interaction.md §3、§4）──────────────

  registerPublishingTool({
    name: 'ask_human',
    description:
      'Ask a human for a DECISION and get a structured answer back. This is NOT an ' +
      'escalation: nothing is broken, the choice simply belongs to a human (a product ' +
      'tradeoff, a version number, whether to pay for a dependency). Each question is ' +
      '`select` / `multiselect` / `text` / `textarea`, may carry options with per-option ' +
      '`impact` (the cost of choosing it, shown under the option) and a `defaultValue` ' +
      '(what happens if nobody answers). `mode: "interactive"` blocks this call until the ' +
      'answer arrives or questionnaire.timeoutMinutes elapse, so your turn stays open; ' +
      '`mode: "async"` returns right away after mailing the ticket, and a human must then ' +
      'come back to the session and tell you to continue (the plugin cannot wake an agent). ' +
      'With a `binding`, the answer is written into that draft document section or task ' +
      'contract as a dated [decision] note — decisions belong in git, not only in state.json. ' +
      '`kind: "approval"` is the document sign-off flow: it appends the approve/reject ' +
      'question itself and stamps the drafts\' hashes, and you may NOT answer it (see doc_approve).',
    parameters: {
      teamId: { type: 'string', required: true },
      title: { type: 'string', required: true, description: 'One line: what is being decided' },
      questions: {
        type: 'array',
        required: true,
        description: 'The questions a human must answer (max 12; more means several rounds)',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: {
              type: 'string',
              required: true,
              description: 'Stable key for the answer (also the form field name); [A-Za-z][A-Za-z0-9_.-]*',
            },
            label: { type: 'string', required: true, description: 'The question, phrased for a human reader' },
            type: { type: 'string', required: true, enum: QUESTION_TYPES },
            options: {
              type: 'array',
              description: 'Required for select/multiselect (2+ options), forbidden otherwise',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  value: { type: 'string', required: true, description: 'Answer token; must not contain a comma' },
                  label: { type: 'string', required: true },
                  impact: { type: 'string', description: 'What choosing this costs — help them decide with consequences visible' },
                  recommended: { type: 'boolean', description: 'Your recommendation: preselected in the form' },
                },
              },
            },
            required: { type: 'boolean', description: 'Default true; false means the defaultValue covers a skip' },
            defaultValue: {
              type: 'string',
              description: 'Must be one of the option values (multi-selections joined by ", "). Used on timeout, and written to no document',
            },
          },
        },
      },
      kind: {
        type: 'string',
        enum: QUESTIONNAIRE_KINDS,
        description: 'intake (requirements), approval (document sign-off), replan (re-scoping); default intake',
      },
      binding: {
        type: 'object',
        additionalProperties: false,
        description:
          'Where the answer lands: {type:"doc", path, section} inside the draft area, or {type:"task", contractId}',
          properties: {
            // 取值以 vocab.ts 的 ANSWER_BINDING_TYPES 为准（schema 的
            // questionBindingSchema 是同一集合的 discriminatedUnion）。
            type: { type: 'string', required: true, enum: ANSWER_BINDING_TYPES },
          path: { type: 'string', description: 'doc binding: a path under the draft area (accepted docs are read-only)' },
          section: { type: 'string', description: 'doc binding: heading to append under; empty = end of file' },
          contractId: { type: 'string', description: 'task binding: the .tasks/<id>.md contract to note on' },
        },
      },
      taskId: { type: 'string', description: 'Task this decision blocks (marks it "waiting for you" on the board and exempts it from stuck detection)' },
      mode: {
        type: 'string',
        enum: QUESTIONNAIRE_MODES,
        description: 'Defaults to questionnaire.mode; interactive blocks this call, async returns immediately',
      },
    },
    async execute(args) {
      const input = args as {
        teamId: string;
        title: string;
        questions: Question[];
        kind?: (typeof QUESTIONNAIRE_KINDS)[number];
        binding?: QuestionBinding;
        taskId?: string;
        mode?: (typeof QUESTIONNAIRE_MODES)[number];
      };
      const result = await service.askHuman(input);
      return result;
    },
    presentCall: present('Ask a human'),
  });

  registerPublishingTool({
    name: 'answer_questionnaire',
    description:
      'Apply a human\'s answer to an open questionnaire (the same funnel the ticket page ' +
      'POSTs into), then write it back to its bound document or task contract. Use it when ' +
      'a human answered you in the session instead of on the ticket page. Pass `actorId` ' +
      'when you are the leader relaying an answer; omit it when you ARE the human. The ' +
      'boundary that matters: an `approval` questionnaire relayed from the session must ' +
      'carry the one-time `code` that only appears in the ticket page or email — a model ' +
      'cannot approve its own documents (§8-10). Answering "reject" sends the drafts back to ' +
      'editable and the phase to intake. Missing required questions are refused with a list, ' +
      'so nobody has to re-answer the whole form.',
    parameters: {
      questionnaireId: { type: 'string', required: true },
      answers: {
        type: 'json',
        required: true,
        description: 'Map of question name → answer value (multi-selections joined by ", ")',
      },
      actorId: { type: 'string', description: 'Member id relaying the answer; must be the leader. Omit when you are the human' },
      code: { type: 'string', description: 'One-time approval code from the ticket/email; required to relay an approval' },
    },
    async execute(args) {
      const input = args as {
        questionnaireId: string;
        answers: Record<string, string>;
        actorId?: string;
        code?: string;
      };
      const result = await service.answerQuestionnaire({ ...input, source: 'tool' });
      return result;
    },
    presentCall: present('Answer a questionnaire'),
  });

  registerPublishingTool({
    name: 'doc_write',
    description:
      'Write a markdown document into the DRAFT area (docs.draftDir, default docs/drafts) — ' +
      'this is the only way any role creates or changes project documents. Formal documents ' +
      'are read-only for the team: they exist only because a human approved specific bytes, ' +
      'and doc_approve is what moves a draft into place. Paths outside the draft area are ' +
      'refused, and so is editing an already-accepted document: write a new draft revision ' +
      'instead. The result carries the stored path, status, version and the sha256 of the ' +
      'body. Warning: touching drafts that are currently pending approval cancels those ' +
      'approval questionnaires — the code a human was shown no longer describes the file, ' +
      'so it is void rather than silently re-stamped.',
    parameters: {
      teamId: { type: 'string', required: true },
      path: { type: 'string', required: true, description: 'Repo-relative .md path under the draft area, e.g. docs/drafts/prd.md' },
      body: { type: 'string', required: true, description: 'Markdown body (no frontmatter — status/version are managed here)' },
    },
    async execute(args) {
      const result = await service.docWrite(args as { teamId: string; path: string; body: string });
      return result;
    },
    presentCall: present('Write a draft document'),
  });

  registerPublishingTool({
    name: 'doc_approve',
    description:
      'Promote the pending draft bundle into the formal document area, recording who ' +
      'approved and re-verifying every document\'s sha256 against the bytes the approver was ' +
      'shown. A human runs this — a model may not: pass `code` (the one-time code from the ' +
      'approval ticket/email) or call it yourself with no actorId. If any draft changed ' +
      'after its code was issued, the promotion is refused, the drafts return to editable, ' +
      'the codes are voided and a fresh approval questionnaire is reopened: approving bundle ' +
      'A and merging bundle B is exactly the failure this gate exists to make impossible. ' +
      'Promotion is also blocked when a target path is in security.forbiddenPaths — an ' +
      'approval can never unlock a configured boundary. On success the team phase moves to ' +
      'scaffolding and the promoted set is versioned.',
    parameters: {
      teamId: { type: 'string', required: true },
      code: {
        type: 'string',
        description: 'One-time approval code; omit only when you are the human approving in the session',
      },
    },
    async execute(args) {
      const input = args as { teamId: string; code?: string };
      const result = await service.docApprove(input);
      return result;
    },
    presentCall: present('Approve and promote drafts'),
  });

  registerPublishingTool({
    name: 'contract_create',
    description:
      'Create task contracts (.tasks/<id>.md) from a structured batch instead of hand-writing ' +
      'files. Everything is validated BEFORE anything is written, and one bad contract ' +
      'refuses the whole batch with a per-field reason: id must be `<DOMAIN>-<number>`, ' +
      'status may only be pending, depends_on must resolve (within the batch or on the ' +
      'board) and must not cycle, touches must not intersect the contract\'s own forbidden ' +
      'list nor security.forbiddenPaths, and one contract may not span more domains than ' +
      'daemon.crossDomainThreshold (split it per domain). Accepted contracts are committed ' +
      'and picked up by the next tick, so task_assign can bind to them right away.',
    parameters: {
      teamId: { type: 'string', required: true },
      contracts: {
        type: 'array',
        required: true,
        description: 'The batch of contracts to create',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Contract id as <DOMAIN>-<number>, e.g. AUTH-12' },
            title: { type: 'string', required: true },
            owner: { type: 'string', description: 'Owning role or agent id' },
            dependsOn: { type: 'array', items: { type: 'string' }, description: 'Contract ids that must be done first' },
            touches: {
              type: 'array',
              items: { type: 'string' },
              description: 'Directories this change may touch — the domain lock and overlap checks read this',
            },
            forbidden: {
              type: 'array',
              items: { type: 'string' },
              description: 'Paths this contract must not touch, on top of security.forbiddenPaths',
            },
            priority: {
              type: 'number',
              description: 'Dispatch weight: higher dispatches first among dependency-equal tasks; default 0',
            },
            body: { type: 'string', description: 'Markdown body: requirements + Gherkin acceptance criteria' },
          },
        },
      },
    },
    async execute(args) {
      const input = args as { teamId: string; contracts: ContractDraft[] };
      const result = await service.contractCreate(input);
      return result;
    },
    presentCall: present('Create task contracts'),
  });
}
