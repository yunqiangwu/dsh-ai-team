// TeamService — the framework-agnostic core of dsh-ai-team.
//
// Responsibilities:
//   * manage teams, members, isolated workspaces (git worktrees) and a shared repo
//   * branch collaboration (create / switch / merge)
//   * a simple task board with assignment + status
//   * code review (diff stat + heuristic comments)
//   * persist state to disk and emit update events for the UI panel
//
// It deliberately imports nothing from @deepseek-ai/* so it can be unit-tested
// without the harness runtime. The Cordis glue lives in `index.ts`.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GitBackend } from './git.js';
import type {
  Member,
  MemberRole,
  PluginSnapshot,
  ReviewComment,
  ReviewResult,
  Task,
  TaskPriority,
  TaskStatus,
  Team,
  TeamSnapshot,
} from './types.js';

export interface TeamServiceOptions {
  stateDir: string;
  git: GitBackend;
  /** Optional event emitter used to push live snapshots to the client. */
  events?: { emit(event: string, payload: unknown): void };
}

const SHORT = (id: string) => id.slice(0, 8);

export interface CreateTeamInput {
  name: string;
  members: Array<{ role: MemberRole; name?: string; systemInstruction?: string }>;
}

export interface AddMemberInput {
  role: MemberRole;
  name?: string;
  systemInstruction?: string;
}

export interface AssignTaskInput {
  title: string;
  description: string;
  assigneeId?: string;
  assigneeRole?: MemberRole;
  priority?: TaskPriority;
  branch?: string;
  dependsOn?: string[];
}

export class TeamService {
  private teams = new Map<string, Team>();
  private readonly teamsDir: string;

  constructor(private readonly opts: TeamServiceOptions) {
    this.teamsDir = join(opts.stateDir, 'teams');
  }

  // ---- lifecycle / persistence -------------------------------------------

  async load(): Promise<void> {
    if (!existsSync(this.teamsDir)) return;
    const files = await readdir(this.teamsDir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const raw = await readFile(join(this.teamsDir, file), 'utf8');
      try {
        const team = JSON.parse(raw) as Team;
        this.teams.set(team.id, team);
      } catch {
        // Corrupt state file: skip rather than crash the plugin.
      }
    }
  }

  private async persist(team: Team): Promise<void> {
    await mkdir(this.teamsDir, { recursive: true });
    await writeFile(join(this.teamsDir, `${team.id}.json`), JSON.stringify(team, null, 2), 'utf8');
  }

  private emitUpdate(): void {
    this.opts.events?.emit('ai-team/update', this.snapshot());
  }

  // ---- team / member management ------------------------------------------

  async createTeam(input: CreateTeamInput): Promise<Team> {
    const id = randomUUID();
    const repoPath = join(this.opts.stateDir, id, 'repo');
    await this.opts.git.init(repoPath);

    const team: Team = {
      id,
      name: input.name,
      repositoryPath: repoPath,
      stateDir: this.opts.stateDir,
      members: [],
      tasks: [],
      createdAt: Date.now(),
    };

    // The first member (or an explicit leader) becomes the team leader.
    const ordered = [...input.members];
    if (!ordered.some((m) => m.role === 'leader') && ordered.length > 0) {
      ordered[0] = { ...ordered[0], role: 'leader' };
    }

    for (const m of ordered) {
      const member = await this.spawnMember(team, m.role, m.name, m.systemInstruction);
      if (member.role === 'leader' && !team.leaderId) team.leaderId = member.id;
    }

    this.teams.set(id, team);
    await this.persist(team);
    this.emitUpdate();
    return team;
  }

  private async spawnMember(
    team: Team,
    role: MemberRole,
    name?: string,
    systemInstruction?: string,
  ): Promise<Member> {
    const id = randomUUID();
    const branch = `agent/${SHORT(id)}`;
    const workspacePath = join(this.opts.stateDir, team.id, 'members', SHORT(id));
    await this.opts.git.addWorktree(team.repositoryPath, workspacePath, branch);
    const member: Member = {
      id,
      name: name ?? `${role}-${SHORT(id)}`,
      role,
      systemInstruction: systemInstruction ?? defaultInstruction(role),
      workspacePath,
      branch,
      status: 'idle',
      createdAt: Date.now(),
    };
    team.members.push(member);
    return member;
  }

  async addMember(teamId: string, input: AddMemberInput): Promise<Member> {
    const team = this.requireTeam(teamId);
    if (team.members.length >= 64) throw new Error('member limit reached for team');
    const member = await this.spawnMember(team, input.role, input.name, input.systemInstruction);
    if (input.role === 'leader' && !team.leaderId) team.leaderId = member.id;
    await this.persist(team);
    this.emitUpdate();
    return member;
  }

  // ---- branch collaboration ----------------------------------------------

  async createBranch(teamId: string, memberId: string, branch: string): Promise<void> {
    const member = this.requireMember(teamId, memberId);
    await this.opts.git.createBranch(member.workspacePath, branch);
    member.branch = branch;
    await this.persist(this.requireTeam(teamId));
    this.emitUpdate();
  }

  async switchBranch(teamId: string, memberId: string, branch: string): Promise<void> {
    const member = this.requireMember(teamId, memberId);
    await this.opts.git.checkout(member.workspacePath, branch);
    member.branch = branch;
    await this.persist(this.requireTeam(teamId));
    this.emitUpdate();
  }

  async mergeBranch(teamId: string, memberId: string, source: string): Promise<{ conflict: boolean }> {
    const member = this.requireMember(teamId, memberId);
    const result = await this.opts.git.merge(member.workspacePath, source);
    await this.persist(this.requireTeam(teamId));
    this.emitUpdate();
    return result;
  }

  // ---- task board ---------------------------------------------------------

  async assignTask(teamId: string, input: AssignTaskInput): Promise<Task> {
    const team = this.requireTeam(teamId);
    let assigneeId = input.assigneeId;
    if (!assigneeId && input.assigneeRole) {
      const candidate = team.members.find((m) => m.role === input.assigneeRole);
      if (!candidate) throw new Error(`no member with role "${input.assigneeRole}"`);
      assigneeId = candidate.id;
    }
    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      title: input.title,
      description: input.description,
      assigneeId,
      status: assigneeId ? 'in_progress' : 'todo',
      priority: input.priority ?? 'medium',
      branch: input.branch,
      dependsOn: input.dependsOn ?? [],
      createdAt: now,
      updatedAt: now,
    };
    if (assigneeId) {
      const member = team.members.find((m) => m.id === assigneeId);
      if (member) member.status = 'busy';
    }
    team.tasks.push(task);
    await this.persist(team);
    this.emitUpdate();
    return task;
  }

  async updateTaskStatus(teamId: string, taskId: string, status: TaskStatus): Promise<Task> {
    const team = this.requireTeam(teamId);
    const task = team.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    task.status = status;
    task.updatedAt = Date.now();
    if (status === 'done' && task.assigneeId) {
      const member = team.members.find((m) => m.id === task.assigneeId);
      if (member) member.status = 'idle';
    }
    await this.persist(team);
    this.emitUpdate();
    return task;
  }

  // ---- code review --------------------------------------------------------

  async reviewCode(
    teamId: string,
    input: { reviewerId?: string; branch: string; base?: string },
  ): Promise<ReviewResult> {
    const team = this.requireTeam(teamId);
    const reviewer = input.reviewerId
      ? this.requireMember(teamId, input.reviewerId)
      : team.members.find((m) => m.role === 'reviewer');
    if (!reviewer) throw new Error('no reviewer available for code review');
    reviewer.status = 'reviewing';

    const base = input.base ?? 'main';
    const diffStat = await this.opts.git.diffStat(team.repositoryPath, base, input.branch);
    const comments = review(reviewer.workspacePath, diffStat);

    const approved = diffStat.files > 0 && comments.every((c) => c.severity !== 'error');
    reviewer.status = 'idle';

    // Move any task tied to this branch into review.
    for (const task of team.tasks) {
      if (task.branch === input.branch && task.status === 'in_progress') {
        task.status = 'in_review';
        task.updatedAt = Date.now();
      }
    }
    await this.persist(team);
    this.emitUpdate();
    return { branch: input.branch, base, diffStat, comments, approved };
  }

  // ---- queries ------------------------------------------------------------

  getTeam(teamId: string): Team {
    return this.requireTeam(teamId);
  }

  listTeams(): Team[] {
    return [...this.teams.values()];
  }

  snapshot(): PluginSnapshot {
    return { teams: this.listTeams().map(toSnapshot), updatedAt: Date.now() };
  }

  // ---- helpers ------------------------------------------------------------

  private requireTeam(teamId: string): Team {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team ${teamId} not found`);
    return team;
  }

  private requireMember(teamId: string, memberId: string): Member {
    const member = this.requireTeam(teamId).members.find((m) => m.id === memberId);
    if (!member) throw new Error(`member ${memberId} not found in team ${teamId}`);
    return member;
  }

  /** Best-effort cleanup of a team's on-disk workspaces (used by tests). */
  async disposeTeam(teamId: string): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) return;
    await rm(join(this.opts.stateDir, teamId), { recursive: true, force: true }).catch(() => {});
    this.teams.delete(teamId);
  }
}

function toSnapshot(team: Team): TeamSnapshot {
  return {
    id: team.id,
    name: team.name,
    leaderId: team.leaderId,
    members: team.members.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      branch: m.branch,
      status: m.status,
      workspacePath: m.workspacePath,
    })),
    tasks: team.tasks,
    branches: team.members.map((m) => m.branch),
    repositoryPath: team.repositoryPath,
    updatedAt: Date.now(),
  };
}

function defaultInstruction(role: MemberRole): string {
  switch (role) {
    case 'leader':
      return 'You are the team leader. Decompose goals into tasks, assign them to developers, and integrate results.';
    case 'developer':
      return 'You are a developer. Implement the tasks assigned to you on your own branch and keep your workspace clean.';
    case 'reviewer':
      return 'You are a code reviewer. Inspect diffs, flag risks and suggest concrete improvements before merge.';
    default:
      return `You are a team member with role "${role}". Follow the leader's assignments.`;
  }
}

/** Heuristic review comments derived from the diff stat. Replace with an LLM call in production. */
function review(_workspacePath: string, stat: { files: number; insertions: number; deletions: number }): ReviewComment[] {
  const comments: ReviewComment[] = [];
  if (stat.files === 0) {
    comments.push({ file: '(repository)', severity: 'warning' as const, message: 'No changes detected against the base branch.' });
  }
  if (stat.insertions > 400) {
    comments.push({ file: '(diff)', severity: 'info' as const, message: `Large change (+${stat.insertions}). Consider splitting into smaller, reviewable commits.` });
  }
  if (stat.deletions > stat.insertions * 3) {
    comments.push({ file: '(diff)', severity: 'info' as const, message: 'Significant deletion volume — confirm no dead code or accidental removal.' });
  }
  return comments;
}
