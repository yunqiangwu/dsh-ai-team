/**
 * dsh-ai-team — simulate an AI software team inside DeepSeek Harness.
 *
 *   team_create      shared git repository + roster (leader/developer/reviewer)
 *   team_add_member  isolated per-member workspace (git worktree) + role prompt
 *   task_assign      leader decomposes work onto the board (task branches)
 *   task_update      developer moves work along the kanban
 *   team_branch      shared-repository branch create / switch / merge / list
 *   code_review      reviewer verdicts gate merges into the base branch
 *
 * Named exports only (name / inject / Config / apply): the Loader's default
 * unwrapping drops the Config schema (see DSH docs/postmortem/0001).
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerAiTeamProjection } from './projection.js'
import { TeamService } from './service.js'
import { registerTeamTools } from './tools.js'

export const name = 'dsh-ai-team'

/** The tool runtime is mandatory; sessionProjections is optional (headless). */
export const inject = ['tools']

export interface Config {
  /** Root directory for team repositories and member workspaces. */
  rootDir: string
  /** Where teams.json is persisted. Empty string → same as rootDir. */
  stateDir: string
  /** Integration branch every task forks from and approvals merge into. */
  baseBranch: string
  /** Maximum members per team (leader included). */
  maxMembers: number
  /** Maximum tasks per team. */
  maxTasks: number
}

export const Config: z<Config> = z.object({
  rootDir: z.string().default('.dsh-ai-team'),
  stateDir: z.string().default(''),
  baseBranch: z.string().default('main'),
  maxMembers: z.number().step(1).min(1).default(8),
  maxTasks: z.number().step(1).min(1).default(256),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Team registry exposed to other plugins (inject: ['aiTeams']). */
    aiTeams: TeamService
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const service = await TeamService.create({
    rootDir: config.rootDir,
    stateDir: config.stateDir === '' ? undefined : config.stateDir,
    baseBranch: config.baseBranch,
    maxMembers: config.maxMembers,
    maxTasks: config.maxTasks,
  })

  // Expose the service for other plugins (and for tests driving the host).
  ctx.provide('aiTeams', service)

  // Host → Web UI data flow: `aiTeam` session projection (panel reads it via
  // useProjection). Optional seam: headless profiles skip it silently.
  registerAiTeamProjection(ctx)

  // Model-facing tools; each mutation appends `ai-team/update` to the log.
  registerTeamTools(ctx, service)

  // State persistence and listener teardown ride the plugin lifecycle:
  // unloading the plugin flushes teams.json and frees every subscription.
  ctx.effect(() => () => void service.dispose(), 'ai-team: flush state')
}

export { TeamService } from './service.js'
export type * from './view.js'
