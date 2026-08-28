// Model-facing tools registered on ctx.tools via defineTool.
// Every tool is a thin, validated wrapper over TeamService so the LLM (the
// "leader" agent) can drive team orchestration through natural language.
//
// defineTool contract (per @deepseek-ai/dsh-tools):
//   * parameters  -> a flat map { name: ValueSchemaSpec & { required?: true } }
//   * output.schema -> a single ValueSchemaSpec (objects need additionalProperties)
//   * output.render(args, value) -> ContentBlock[]  (the model-facing text)
//   * execute(args, exec) -> the canonical JSON value declared by output.schema

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { TeamService } from './service.js';

/** Local mirror of the dsh-llm TextBlock; structurally identical so it is
 *  assignable to the SDK's ContentBlock union without an extra dependency. */
type TextBlock = { type: 'text'; text: string };

function summary(text: string): TextBlock[] {
  return [{ type: 'text', text }];
}

export function buildTools(service: TeamService): ReturnType<typeof defineTool>[] {
  return [
    defineTool({
      name: 'team_create',
      description:
        'Create an AI software team with isolated member workspaces that share one git repository. ' +
        'Provide a team name and the initial members with their roles (leader / developer / reviewer). ' +
        'The first member becomes the leader unless one is explicitly named.',
      parameters: {
        teamName: { type: 'string', description: 'Human-readable team name.', required: true },
        members: {
          type: 'array',
          description: 'Initial members of the team.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              role: { type: 'string', description: 'Role, e.g. leader / developer / reviewer.', required: true },
              name: { type: 'string', description: 'Optional display name.' },
              systemInstruction: { type: 'string', description: 'Optional system instruction for the agent.' },
            },
          },
          required: true,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            teamId: { type: 'string' },
            name: { type: 'string' },
            memberCount: { type: 'number' },
          },
        },
        render: (_args, value) =>
          summary(`Team "${value.name}" created (${value.memberCount} members). teamId=${value.teamId}`),
      },
      async execute(args) {
        const team = await service.createTeam({ name: args.teamName, members: args.members });
        return { teamId: team.id, name: team.name, memberCount: team.members.length };
      },
    }),

    defineTool({
      name: 'team_add_member',
      description: 'Add a new AI agent member (with its own role + system instruction) to an existing team. ' +
        'A fresh, isolated git workspace is created for the member on its own branch.',
      parameters: {
        teamId: { type: 'string', required: true },
        role: { type: 'string', description: 'Member role, e.g. developer / reviewer.', required: true },
        name: { type: 'string', description: 'Optional display name.' },
        systemInstruction: { type: 'string', description: 'Optional system instruction.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            memberId: { type: 'string' },
            role: { type: 'string' },
            workspacePath: { type: 'string' },
          },
        },
        render: (_args, value) => summary(`Added ${value.role} member ${value.memberId} at ${value.workspacePath}`),
      },
      async execute(args) {
        const member = await service.addMember(args.teamId, {
          role: args.role,
          name: args.name,
          systemInstruction: args.systemInstruction,
        });
        return { memberId: member.id, role: member.role, workspacePath: member.workspacePath };
      },
    }),

    defineTool({
      name: 'task_assign',
      description: 'Assign a task to a team member. The leader decomposes work and assigns it to a developer. ' +
        'You can target a member by id or by role; if omitted, it goes to an available developer.',
      parameters: {
        teamId: { type: 'string', required: true },
        title: { type: 'string', required: true },
        description: { type: 'string', required: true },
        assigneeId: { type: 'string', description: 'Exact member id.' },
        assigneeRole: { type: 'string', description: 'Or assign to the first member with this role.' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Task priority.' },
        branch: { type: 'string', description: 'Optional branch the work happens on.' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Task ids this depends on.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string' },
            status: { type: 'string' },
            assigneeId: { type: 'string' },
          },
        },
        render: (_args, value) => summary(`Task ${value.taskId} assigned (status=${value.status})`),
      },
      async execute(args) {
        const task = await service.assignTask(args.teamId, {
          title: args.title,
          description: args.description,
          assigneeId: args.assigneeId,
          assigneeRole: args.assigneeRole,
          priority: args.priority,
          branch: args.branch,
          dependsOn: args.dependsOn,
        });
        return { taskId: task.id, status: task.status, assigneeId: task.assigneeId ?? '' };
      },
    }),

    defineTool({
      name: 'code_review',
      description: 'Request a code review from a reviewer agent on a given branch. ' +
        'Returns the diff stat, heuristic review comments and an approval decision.',
      parameters: {
        teamId: { type: 'string', required: true },
        reviewerId: { type: 'string', description: 'Optional reviewer member id; picks a reviewer role otherwise.' },
        branch: { type: 'string', required: true, description: 'Branch to review.' },
        base: { type: 'string', description: 'Base branch to diff against (defaults to main).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            branch: { type: 'string' },
            approved: { type: 'boolean' },
            files: { type: 'number' },
            comments: { type: 'json' },
          },
        },
        render: (_args, value) =>
          summary(`Review of ${value.branch}: ${value.approved ? 'APPROVED' : 'CHANGES REQUESTED'} (${value.files} files)`),
      },
      async execute(args) {
        const result = await service.reviewCode(args.teamId, {
          reviewerId: args.reviewerId,
          branch: args.branch,
          base: args.base,
        });
        return {
          branch: result.branch,
          approved: result.approved,
          files: result.diffStat.files,
          // type:'json' output infers JsonValue; serialize the typed comments to
          // a lossless-JSON-safe form so the model can read them verbatim.
          comments: JSON.parse(JSON.stringify(result.comments)),
        };
      },
    }),

    defineTool({
      name: 'git_branch_create',
      description: 'Create and check out a new git branch inside a member workspace.',
      parameters: {
        teamId: { type: 'string', required: true },
        memberId: { type: 'string', required: true },
        branch: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { branch: { type: 'string' } } },
        render: (_a, v) => summary(`Branch ${v.branch} created`),
      },
      async execute(args) {
        await service.createBranch(args.teamId, args.memberId, args.branch);
        return { branch: args.branch };
      },
    }),

    defineTool({
      name: 'git_branch_switch',
      description: 'Switch a member workspace to an existing branch.',
      parameters: {
        teamId: { type: 'string', required: true },
        memberId: { type: 'string', required: true },
        branch: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { branch: { type: 'string' } } },
        render: (_a, v) => summary(`Switched to ${v.branch}`),
      },
      async execute(args) {
        await service.switchBranch(args.teamId, args.memberId, args.branch);
        return { branch: args.branch };
      },
    }),

    defineTool({
      name: 'git_branch_merge',
      description: 'Merge a source branch into a member workspace current branch (shared repository).',
      parameters: {
        teamId: { type: 'string', required: true },
        memberId: { type: 'string', required: true },
        source: { type: 'string', required: true, description: 'Branch to merge from.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { conflict: { type: 'boolean' } } },
        render: (_a, v) => summary(v.conflict ? 'Merge resulted in conflicts' : 'Merge completed'),
      },
      async execute(args) {
        const r = await service.mergeBranch(args.teamId, args.memberId, args.source);
        return { conflict: r.conflict };
      },
    }),

    defineTool({
      name: 'team_status',
      description: 'Return the current state of a team: members, their branches, tasks and active git branches.',
      parameters: {
        teamId: { type: 'string', required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            memberCount: { type: 'number' },
            taskCount: { type: 'number' },
          },
        },
        render: (_a, v) => summary(`Team ${v.name}: ${v.memberCount} members, ${v.taskCount} tasks`),
      },
      async execute(args) {
        const team = service.getTeam(args.teamId);
        return { name: team.name, memberCount: team.members.length, taskCount: team.tasks.length };
      },
    }),
  ];
}
