/**
 * TeamService — the heart of dsh-ai-team.
 *
 * Manages teams of AI agent members: every member gets an isolated workspace
 * (a git worktree) that shares one repository with the rest of the team, so
 * members collaborate through ordinary git branches. On top of that it keeps
 * the task board (leader → developer assignment) and the review flow
 * (reviewer verdicts gate merges into the base branch).
 *
 * The service is runtime-agnostic on purpose: it never touches cordis or the
 * session log. The plugin entry (index.ts) provides it as the `aiTeams`
 * service and the tool layer (tools.ts) translates mutations into session
 * events. This keeps the service unit-testable without a DSH host.
 *
 * State persists to `<stateDir>/teams.json` (debounced); dispose() flushes.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  addWorktree,
  checkout,
  createBranch,
  deleteBranch,
  ensureRepo,
  listBranches,
  mergeBranch,
} from './git.js'
import { defaultMemberName, isRole, systemPromptFor } from './roles.js'
import type {
  AiTeamProjection,
  MemberStatus,
  MemberView,
  ReviewVerdict,
  ReviewView,
  Role,
  TaskStatus,
  TaskView,
  TeamView,
} from './view.js'

export interface TeamServiceOptions {
  /** Root directory for repositories, workspaces and (by default) state. */
  rootDir: string
  /** Where teams.json lives. Defaults to rootDir. */
  stateDir?: string
  baseBranch: string
  maxMembers: number
  maxTasks: number
}

interface MemberRecord {
  id: string
  name: string
  role: Role
  systemPrompt: string
  workspacePath: string
  branch: string
  status: MemberStatus
  currentTaskId: string | null
}

interface TaskRecord {
  id: string
  title: string
  description: string
  assigneeId: string
  status: TaskStatus
  branch: string
  reviewRound: number
  createdAt: number
  updatedAt: number
}

interface ReviewRecord {
  id: string
  taskId: string
  reviewerId: string
  verdict: ReviewVerdict
  comments: string
  createdAt: number
}

interface TeamRecord {
  id: string
  name: string
  repoPath: string
  workspaceRoot: string
  baseBranch: string
  branches: string[]
  members: MemberRecord[]
  tasks: TaskRecord[]
  reviews: ReviewRecord[]
  createdAt: number
}

interface PersistedState {
  version: 1
  teams: TeamRecord[]
  activeTeamId: string | null
}

const shortId = (prefix: string): string => `${prefix}_${randomUUID().slice(0, 8)}`

export class TeamService {
  private readonly teams = new Map<string, TeamRecord>()
  private readonly listeners = new Set<() => void>()
  private activeTeamId: string | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  private constructor(private readonly options: Required<TeamServiceOptions>) {}

  /** Create the service and reload any persisted team state. */
  static async create(options: TeamServiceOptions): Promise<TeamService> {
    const resolved: Required<TeamServiceOptions> = {
      ...options,
      rootDir: resolve(options.rootDir),
      stateDir: resolve(options.stateDir ?? options.rootDir),
    }
    const service = new TeamService(resolved)
    await mkdir(resolved.stateDir, { recursive: true })
    await service.load()
    return service
  }

  // ── persistence ────────────────────────────────────────────────────────

  private get stateFile(): string {
    return join(this.options.stateDir, 'teams.json')
  }

  private async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.stateFile, 'utf8')
    } catch {
      return // first run: no state yet
    }
    try {
      const state = JSON.parse(raw) as PersistedState
      for (const team of state.teams ?? []) this.teams.set(team.id, team)
      this.activeTeamId = state.activeTeamId ?? null
      // Refresh cached branch lists from disk (branches may have changed
      // while the host was down); failures just keep the cached list.
      for (const team of this.teams.values()) {
        team.branches = await listBranches(team.repoPath).catch(() => team.branches)
      }
    } catch {
      // Corrupt state file: start empty rather than crash the host.
    }
  }

  /** Debounced persist; dispose() flushes synchronously-ish. */
  private persist(): void {
    if (this.disposed) return
    if (this.persistTimer !== null) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      const state: PersistedState = {
        version: 1,
        teams: [...this.teams.values()],
        activeTeamId: this.activeTeamId,
      }
      void writeFile(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8').catch(
        () => {},
      )
    }, 100)
  }

  /** Flush pending state and stop the service. Register via ctx.effect(). */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
      const state: PersistedState = {
        version: 1,
        teams: [...this.teams.values()],
        activeTeamId: this.activeTeamId,
      }
      await writeFile(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8').catch(
        () => {},
      )
    }
    this.listeners.clear()
  }

  // ── change notification (the plugin entry turns these into session events) ──

  /** Subscribe to state changes; returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(teamId: string): void {
    this.activeTeamId = teamId
    this.persist()
    for (const listener of this.listeners) listener()
  }

  // ── views ──────────────────────────────────────────────────────────────

  private memberView(member: MemberRecord): MemberView {
    return {
      id: member.id,
      name: member.name,
      role: member.role,
      workspacePath: member.workspacePath,
      branch: member.branch,
      status: member.status,
      currentTaskId: member.currentTaskId,
    }
  }

  private taskView(team: TeamRecord, task: TaskRecord): TaskView {
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      assigneeId: task.assigneeId,
      assigneeName: this.memberOf(team, task.assigneeId).name,
      status: task.status,
      branch: task.branch,
      reviewRound: task.reviewRound,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }
  }

  private reviewView(team: TeamRecord, review: ReviewRecord): ReviewView {
    return {
      id: review.id,
      taskId: review.taskId,
      reviewerId: review.reviewerId,
      reviewerName: this.memberOf(team, review.reviewerId).name,
      verdict: review.verdict,
      comments: review.comments,
      createdAt: review.createdAt,
    }
  }

  teamView(teamId: string): TeamView {
    const team = this.teamOf(teamId)
    return {
      id: team.id,
      name: team.name,
      repoPath: team.repoPath,
      baseBranch: team.baseBranch,
      branches: [...team.branches],
      members: team.members.map((member) => this.memberView(member)),
      tasks: team.tasks.map((task) => this.taskView(team, task)),
      reviews: team.reviews.map((review) => this.reviewView(team, review)),
      createdAt: team.createdAt,
    }
  }

  /** The role-derived system instructions of one member (for spawning its agent). */
  memberSystemPrompt(teamId: string, memberId: string): string {
    return this.memberOf(this.teamOf(teamId), memberId).systemPrompt
  }

  /** Whole-state projection snapshot — the value pushed to the Web UI. */
  projection(): AiTeamProjection {
    return {
      teams: [...this.teams.keys()].map((id) => this.teamView(id)),
      activeTeamId: this.activeTeamId,
    }
  }

  // ── lookups ────────────────────────────────────────────────────────────

  private teamOf(teamId: string): TeamRecord {
    const team = this.teams.get(teamId)
    if (team === undefined) {
      throw new Error(
        `unknown team "${teamId}"${this.teams.size > 0 ? `; known teams: ${[...this.teams.keys()].join(', ')}` : ' (no teams yet — call team_create first)'}`,
      )
    }
    return team
  }

  private memberOf(team: TeamRecord, memberId: string): MemberRecord {
    const member = team.members.find((candidate) => candidate.id === memberId)
    if (member === undefined) {
      throw new Error(
        `team "${team.name}" has no member "${memberId}"; members: ${team.members.map((m) => `${m.name}(${m.id})`).join(', ') || '(none)'}`,
      )
    }
    return member
  }

  private findTask(taskId: string): { team: TeamRecord; task: TaskRecord } {
    for (const team of this.teams.values()) {
      const task = team.tasks.find((candidate) => candidate.id === taskId)
      if (task !== undefined) return { team, task }
    }
    throw new Error(`unknown task "${taskId}"`)
  }

  // ── team & member management ───────────────────────────────────────────

  /**
   * Create a team: shared repository at <rootDir>/<id>/repo plus the leader
   * member (exactly one per team). Extra members may be given up front;
   * their roles must be valid and contain at most one leader.
   */
  async createTeam(input: {
    name: string
    members?: { role: string; name?: string }[]
  }): Promise<TeamView> {
    const id = shortId('team')
    const repoPath = join(this.options.rootDir, id, 'repo')
    const workspaceRoot = join(this.options.rootDir, id, 'workspaces')
    await ensureRepo(repoPath, this.options.baseBranch)

    const team: TeamRecord = {
      id,
      name: input.name,
      repoPath,
      workspaceRoot,
      baseBranch: this.options.baseBranch,
      branches: await listBranches(repoPath),
      members: [],
      tasks: [],
      reviews: [],
      createdAt: Date.now(),
    }
    this.teams.set(id, team)

    const requested = input.members ?? [{ role: 'leader' }]
    if (requested.filter((m) => m.role === 'leader').length !== 1) {
      this.teams.delete(id)
      throw new Error('a team needs exactly one leader member')
    }
    for (const member of requested) {
      await this.addMember({ teamId: id, role: member.role, name: member.name })
    }
    return this.teamView(id)
  }

  /**
   * Add a member: allocates an isolated worktree on a fresh member branch
   * forked from the base branch, and derives the member's system prompt from
   * its role.
   */
  async addMember(input: { teamId: string; role: string; name?: string }): Promise<MemberView> {
    const team = this.teamOf(input.teamId)
    if (!isRole(input.role)) {
      throw new Error(`invalid role "${input.role}"; expected leader, developer or reviewer`)
    }
    if (team.members.length >= this.options.maxMembers) {
      throw new Error(`team "${team.name}" already has the maximum of ${this.options.maxMembers} members`)
    }
    if (input.role === 'leader' && team.members.some((m) => m.role === 'leader')) {
      throw new Error(`team "${team.name}" already has a leader`)
    }

    const id = shortId('m')
    const role = input.role
    const index = team.members.filter((m) => m.role === role).length + 1
    const name = input.name ?? defaultMemberName(role, index)
    const branch = `member/${id}`
    const workspacePath = join(team.workspaceRoot, id)

    await addWorktree(team.repoPath, workspacePath, branch, team.baseBranch)

    const member: MemberRecord = {
      id,
      name,
      role,
      systemPrompt: systemPromptFor(role, {
        teamName: team.name,
        memberName: name,
        baseBranch: team.baseBranch,
      }),
      workspacePath,
      branch,
      status: 'idle',
      currentTaskId: null,
    }
    team.members.push(member)
    team.branches = await listBranches(team.repoPath)
    this.changed(team.id)
    return this.memberView(member)
  }

  // ── task board ─────────────────────────────────────────────────────────

  /**
   * Leader assigns a task: creates the task branch (task/<id>) from the base
   * branch and checks it out in the assignee's workspace, so the developer
   * can start committing immediately.
   */
  async assignTask(input: {
    teamId: string
    title: string
    description?: string
    assigneeId: string
  }): Promise<TaskView> {
    const team = this.teamOf(input.teamId)
    if (team.tasks.length >= this.options.maxTasks) {
      throw new Error(`team "${team.name}" already has the maximum of ${this.options.maxTasks} tasks`)
    }
    const assignee = this.memberOf(team, input.assigneeId)
    if (assignee.role === 'reviewer') {
      throw new Error('reviewers do not write code; assign the task to a developer')
    }
    if (assignee.currentTaskId !== null) {
      throw new Error(
        `${assignee.name} is already working on ${assignee.currentTaskId}; finish or update that task first`,
      )
    }

    const id = shortId('task')
    const branch = `task/${id}`
    await createBranch(team.repoPath, branch, team.baseBranch)
    await checkout(assignee.workspacePath, branch)

    const now = Date.now()
    const task: TaskRecord = {
      id,
      title: input.title,
      description: input.description ?? '',
      assigneeId: assignee.id,
      status: 'pending',
      branch,
      reviewRound: 0,
      createdAt: now,
      updatedAt: now,
    }
    team.tasks.push(task)
    assignee.branch = branch
    assignee.status = 'working'
    assignee.currentTaskId = id
    team.branches = await listBranches(team.repoPath)
    this.changed(team.id)
    return this.taskView(team, task)
  }

  /**
   * Move a task along the board. Manual transitions are restricted to
   * pending / in_progress / in_review — done and changes_requested are owned
   * by the review flow (code_review tool).
   */
  async updateTask(input: { taskId: string; status: string; note?: string }): Promise<TaskView> {
    const { team, task } = this.findTask(input.taskId)
    const target = input.status as TaskStatus
    if (!['pending', 'in_progress', 'in_review'].includes(target)) {
      throw new Error(
        `cannot set a task to "${input.status}" directly; use code_review to approve (done) or request changes`,
      )
    }
    task.status = target
    task.updatedAt = Date.now()
    this.changed(team.id)
    return this.taskView(team, task)
  }

  // ── branch collaboration ───────────────────────────────────────────────

  /** Branch operations shared by all members of a team. */
  async branch(input: {
    teamId: string
    memberId?: string
    action: 'list' | 'create' | 'switch' | 'merge'
    branch?: string
    target?: string
  }): Promise<{ action: string; branches: string[]; detail: string }> {
    const team = this.teamOf(input.teamId)

    switch (input.action) {
      case 'list': {
        team.branches = await listBranches(team.repoPath)
        this.changed(team.id)
        return { action: 'list', branches: team.branches, detail: `${team.branches.length} branches` }
      }
      case 'create': {
        const branch = requireBranch(input.branch)
        await createBranch(team.repoPath, branch, input.target ?? team.baseBranch)
        team.branches = await listBranches(team.repoPath)
        this.changed(team.id)
        return { action: 'create', branches: team.branches, detail: `created ${branch} from ${input.target ?? team.baseBranch}` }
      }
      case 'switch': {
        const branch = requireBranch(input.branch)
        const member = this.memberOf(team, requireMember(input.memberId))
        const branches = await listBranches(team.repoPath)
        if (!branches.includes(branch)) {
          throw new Error(`branch "${branch}" does not exist; known branches: ${branches.join(', ')}`)
        }
        await checkout(member.workspacePath, branch)
        member.branch = branch
        this.changed(team.id)
        return { action: 'switch', branches, detail: `${member.name} switched to ${branch}` }
      }
      case 'merge': {
        const branch = requireBranch(input.branch)
        const target = input.target ?? team.baseBranch
        await mergeBranch(
          team.repoPath,
          branch,
          target,
          team.baseBranch,
          `merge: ${branch} into ${target} (dsh-ai-team)`,
        )
        team.branches = await listBranches(team.repoPath)
        this.changed(team.id)
        return { action: 'merge', branches: team.branches, detail: `merged ${branch} into ${target}` }
      }
    }
  }

  // ── code review ────────────────────────────────────────────────────────

  /**
   * Reviewer verdict on a task in review. `approve` merges the task branch
   * into the base branch and frees the assignee; `request_changes` sends the
   * task back to the developer with comments and bumps the review round.
   */
  async review(input: {
    taskId: string
    reviewerId: string
    verdict: ReviewVerdict
    comments?: string
  }): Promise<{ review: ReviewView; task: TaskView; merged: boolean }> {
    const { team, task } = this.findTask(input.taskId)
    const reviewer = this.memberOf(team, input.reviewerId)
    if (reviewer.role === 'developer') {
      throw new Error('developers cannot review their own workflow; use a reviewer (or the leader)')
    }
    if (reviewer.id === task.assigneeId) {
      throw new Error('a member cannot review their own task')
    }
    if (task.status !== 'in_review' && task.status !== 'changes_requested') {
      throw new Error(`task "${task.title}" is ${task.status}; only in_review tasks can be reviewed`)
    }

    const assignee = this.memberOf(team, task.assigneeId)
    const review: ReviewRecord = {
      id: shortId('rev'),
      taskId: task.id,
      reviewerId: reviewer.id,
      verdict: input.verdict,
      comments: input.comments ?? '',
      createdAt: Date.now(),
    }
    team.reviews.push(review)

    let merged = false
    if (input.verdict === 'approve') {
      // The merge is the point of no return: conflicts surface as an error
      // and the task stays in_review so the developer can rebase and retry.
      await mergeBranch(
        team.repoPath,
        task.branch,
        team.baseBranch,
        team.baseBranch,
        `merge: ${task.branch} — ${task.title} (approved by ${reviewer.name})`,
      )
      merged = true
      task.status = 'done'
      assignee.status = 'idle'
      assignee.currentTaskId = null
      // Bring the member workspace back to its own branch, up to date with
      // the freshly merged base branch.
      await checkout(assignee.workspacePath, `member/${assignee.id}`).catch(() => {})
      await mergeBranch(
        team.repoPath,
        team.baseBranch,
        `member/${assignee.id}`,
        team.baseBranch,
      ).catch(() => {})
      assignee.branch = `member/${assignee.id}`
    } else {
      task.status = 'changes_requested'
      task.reviewRound += 1
      assignee.status = 'working'
    }
    task.updatedAt = Date.now()
    team.branches = await listBranches(team.repoPath)
    this.changed(team.id)
    return { review: this.reviewView(team, review), task: this.taskView(team, task), merged }
  }

  /** Remove a merged task branch from the shared repository. */
  async pruneTaskBranch(taskId: string): Promise<void> {
    const { team, task } = this.findTask(taskId)
    if (task.status !== 'done') {
      throw new Error(`task "${task.title}" is not done; only merged task branches can be pruned`)
    }
    await deleteBranch(team.repoPath, task.branch)
    team.branches = await listBranches(team.repoPath)
    this.changed(team.id)
  }
}

function requireBranch(branch: string | undefined): string {
  if (branch === undefined || branch === '') throw new Error('the "branch" parameter is required for this action')
  return branch
}

function requireMember(memberId: string | undefined): string {
  if (memberId === undefined || memberId === '') throw new Error('the "memberId" parameter is required for this action')
  return memberId
}
