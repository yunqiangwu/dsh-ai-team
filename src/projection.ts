/**
 * The `aiTeam` session projection unit: folds `ai-team/update` events into
 * the whole value the Web UI reads via useProjection('aiTeam'). Registered
 * under ctx.inject(['sessionProjections'], …) so the plugin still loads in
 * headless profiles where the projection seam is absent — the panel simply
 * stays empty there.
 */
import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type {} from '@deepseek-ai/dsh-session-projection'
import './events.js'
import type { AiTeamProjection } from './view.js'

const roleSchema = zod.enum(['leader', 'developer', 'reviewer'])
const memberStatusSchema = zod.enum(['idle', 'working', 'reviewing'])
const taskStatusSchema = zod.enum([
  'pending',
  'in_progress',
  'in_review',
  'changes_requested',
  'done',
])

const memberViewSchema = zod.object({
  id: zod.string(),
  name: zod.string(),
  role: roleSchema,
  workspacePath: zod.string(),
  branch: zod.string(),
  status: memberStatusSchema,
  currentTaskId: zod.string().nullable(),
})

const taskViewSchema = zod.object({
  id: zod.string(),
  title: zod.string(),
  description: zod.string(),
  assigneeId: zod.string(),
  assigneeName: zod.string(),
  status: taskStatusSchema,
  branch: zod.string(),
  reviewRound: zod.number().int().nonnegative(),
  createdAt: zod.number(),
  updatedAt: zod.number(),
})

const reviewViewSchema = zod.object({
  id: zod.string(),
  taskId: zod.string(),
  reviewerId: zod.string(),
  reviewerName: zod.string(),
  verdict: zod.enum(['approve', 'request_changes']),
  comments: zod.string(),
  createdAt: zod.number(),
})

const teamViewSchema = zod.object({
  id: zod.string(),
  name: zod.string(),
  repoPath: zod.string(),
  baseBranch: zod.string(),
  branches: zod.array(zod.string()),
  members: zod.array(memberViewSchema),
  tasks: zod.array(taskViewSchema),
  reviews: zod.array(reviewViewSchema),
  createdAt: zod.number(),
})

const aiTeamProjectionSchema = zod.object({
  teams: zod.array(teamViewSchema),
  activeTeamId: zod.string().nullable(),
})

/** Register the projection unit when the projection seam is available. */
export function registerAiTeamProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: 'aiTeam',
      schema: zod
        .object({ teams: zod.array(teamViewSchema), activeTeamId: zod.string().nullable() })
        .nullable(),
      init: (): AiTeamProjection | null => null,
      apply: (state, event) => (event.type === 'ai-team/update' ? event.data.state : state),
      view: (state) => state,
      // v1: whole-snapshot last-write-wins fold. Bump on any shape change.
      stateVersion: 1,
    })
  })
}

export { aiTeamProjectionSchema }
