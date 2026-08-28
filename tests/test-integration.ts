/**
 * dsh-ai-team integration test: simulates a full multi-agent collaboration
 * cycle against TeamService (no DSH host needed — the service is
 * runtime-agnostic by design):
 *
 *   leader  → creates the team, adds a developer and a reviewer
 *   leader  → assigns a task (task branch forked into the dev's workspace)
 *   dev     → commits work on the task branch, moves it to in_review
 *   reviewer→ requests changes; dev fixes; reviewer approves → auto-merge
 *   leader  → inspects branches, prunes the merged task branch
 *   host    → restarts (state persists to teams.json and reloads)
 *
 * Run: pnpm test
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../src/git.js'
import { TeamService } from '../src/service.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-ai-team-test-'))
const OPTIONS = {
  rootDir: root,
  baseBranch: 'main',
  maxMembers: 8,
  maxTasks: 256,
}

/** Commit a file inside a member's isolated workspace, as that member. */
async function memberCommit(
  workspacePath: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(workspacePath, file), content, 'utf8')
  await git(['add', file], workspacePath)
  await git(
    ['-c', 'user.name=dev-1', '-c', 'user.email=dev-1@localhost', 'commit', '-m', message],
    workspacePath,
  )
}

let passed = 0
function step(label: string): void {
  passed += 1
  console.log(`  ✓ ${String(passed).padStart(2)}. ${label}`)
}

try {
  const service = await TeamService.create(OPTIONS)

  // ── team & roster ──────────────────────────────────────────────────────
  const team = await service.createTeam({
    name: 'checkout-team',
    members: [{ role: 'leader', name: 'lead' }],
  })
  assert.equal(team.members.length, 1)
  assert.equal(team.members[0]!.role, 'leader')
  assert.ok(team.branches.includes('main'))
  step('team_create: shared repository + leader, base branch main')

  await assert.rejects(
    () => service.createTeam({ name: 'broken', members: [{ role: 'developer' }] }),
    /exactly one leader/,
  )
  step('team_create without a leader is rejected')

  const dev = await service.addMember({ teamId: team.id, role: 'developer' })
  const reviewer = await service.addMember({ teamId: team.id, role: 'reviewer' })
  assert.ok(dev.workspacePath.includes('workspaces'))
  assert.ok(service.memberSystemPrompt(team.id, dev.id).includes('implement tasks'))
  assert.ok(service.memberSystemPrompt(team.id, reviewer.id).includes('review code'))
  await assert.rejects(
    () => service.addMember({ teamId: team.id, role: 'leader' }),
    /already has a leader/,
  )
  step('team_add_member: isolated worktrees, role prompts, single-leader rule')

  // Isolation: every member workspace is a distinct directory on its own branch.
  assert.notEqual(dev.workspacePath, reviewer.workspacePath)
  assert.equal(await git(['branch', '--show-current'], dev.workspacePath), `member/${dev.id}`)
  step('workspaces are isolated git worktrees on member branches')

  // ── task assignment ────────────────────────────────────────────────────
  const task = await service.assignTask({
    teamId: team.id,
    title: 'Add coupon support to checkout',
    description: 'Apply percentage coupons before payment.',
    assigneeId: dev.id,
  })
  assert.equal(task.status, 'pending')
  assert.equal(
    await git(['branch', '--show-current'], dev.workspacePath),
    task.branch,
    'task branch is checked out in the developer workspace',
  )
  step('task_assign: task branch forked from base into the dev workspace')

  await assert.rejects(
    () =>
      service.assignTask({
        teamId: team.id,
        title: 'Double booking',
        assigneeId: dev.id,
      }),
    /already working on/,
  )
  await assert.rejects(
    () => service.assignTask({ teamId: team.id, title: 'Review stuff', assigneeId: reviewer.id }),
    /reviewers do not write code/,
  )
  step('task_assign guards: busy developer and reviewer assignee rejected')

  // ── development on the task branch ─────────────────────────────────────
  await service.updateTask({ taskId: task.id, status: 'in_progress' })
  await memberCommit(dev.workspacePath, 'coupon.ts', 'export const coupon = () => 0.9\n', 'feat: coupon module')
  step('developer commits on the task branch inside the isolated workspace')

  await service.updateTask({ taskId: task.id, status: 'in_review' })
  await assert.rejects(
    () => service.updateTask({ taskId: task.id, status: 'done' }),
    /use code_review/,
  )
  step('task_update: in_review reached; done is review-gated')

  // ── review round 1: changes requested ──────────────────────────────────
  await assert.rejects(
    () => service.review({ taskId: task.id, reviewerId: dev.id, verdict: 'approve' }),
    /cannot review their own task|developers cannot review/,
  )
  const round1 = await service.review({
    taskId: task.id,
    reviewerId: reviewer.id,
    verdict: 'request_changes',
    comments: 'Coupon must not apply to sale items.',
  })
  assert.equal(round1.merged, false)
  assert.equal(round1.task.status, 'changes_requested')
  assert.equal(round1.task.reviewRound, 1)
  step('code_review request_changes: task bounces back, round bumped')

  // ── fix + review round 2: approve → merge ──────────────────────────────
  await memberCommit(
    dev.workspacePath,
    'coupon.ts',
    'export const coupon = (onSale: boolean) => (onSale ? 1 : 0.9)\n',
    'fix: skip sale items',
  )
  await service.updateTask({ taskId: task.id, status: 'in_review' })
  const round2 = await service.review({
    taskId: task.id,
    reviewerId: reviewer.id,
    verdict: 'approve',
    comments: 'LGTM',
  })
  assert.equal(round2.merged, true)
  assert.equal(round2.task.status, 'done')
  step('code_review approve: task branch merged into main, task done')

  // The merged code is on the base branch of the shared repository…
  const merged = await readFile(join(team.repoPath, 'coupon.ts'), 'utf8')
  assert.ok(merged.includes('onSale'))
  const log = await git(['log', '--oneline', 'main'], team.repoPath)
  assert.ok(log.includes('skip sale items'))
  step('merged commits are visible on main in the shared repository')

  // …and the developer is back on its own member branch, ready for the next task.
  assert.equal(
    await git(['branch', '--show-current'], dev.workspacePath),
    `member/${dev.id}`,
  )
  const view = service.teamView(team.id)
  assert.equal(view.members.find((m) => m.id === dev.id)!.status, 'idle')
  assert.equal(view.reviews.length, 2)
  step('developer freed back to member branch; both reviews on record')

  // ── branch collaboration ───────────────────────────────────────────────
  await service.branch({ teamId: team.id, action: 'create', branch: 'feature/docs' })
  const switched = await service.branch({
    teamId: team.id,
    action: 'switch',
    memberId: reviewer.id,
    branch: 'feature/docs',
  })
  assert.ok(switched.detail.includes('feature/docs'))
  const listed = await service.branch({ teamId: team.id, action: 'list' })
  assert.ok(listed.branches.includes('feature/docs'))
  step('team_branch: create + switch (per-member) + list')

  // ── prune merged task branch ───────────────────────────────────────────
  await service.pruneTaskBranch(task.id)
  assert.ok(!service.teamView(team.id).branches.includes(task.branch))
  step('merged task branch pruned from the shared repository')

  // ── projection snapshot (what the Web UI panel renders) ────────────────
  const projection = service.projection()
  assert.equal(projection.activeTeamId, team.id)
  assert.equal(projection.teams[0]!.tasks[0]!.status, 'done')
  step('projection snapshot carries the whole board')

  // ── persistence across a host restart ──────────────────────────────────
  await service.dispose()
  const revived = await TeamService.create(OPTIONS)
  const restored = revived.teamView(team.id)
  assert.equal(restored.name, 'checkout-team')
  assert.equal(restored.members.length, 3)
  assert.equal(restored.tasks[0]!.status, 'done')
  assert.equal(restored.reviews.length, 2)
  await revived.dispose()
  step('state persists to teams.json and survives a restart')

  console.log(`\nAll ${passed} integration checks passed.`)
} finally {
  await rm(root, { recursive: true, force: true })
}
