/**
 * The ONE home of dsh-ai-team's session-log vocabulary: the `ai-team/update`
 * whole-state snapshot event plus the `aiTeam` projection key, declared via
 * declaration merging exactly like the official plugins (see tool-todo).
 * Pure types — no runtime imports — so both halves can pull this in.
 *
 * Whole-value rule: every `ai-team/update` carries the complete replacement
 * {@link AiTeamProjection}, so the projection fold is last-write-wins.
 */
import type { AiTeamProjection } from './view.js'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole-state snapshot of every AI team; latest write wins on replay. */
    'ai-team/update': { state: AiTeamProjection }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The teams, members, workspaces, branches and task board rendered by
     * the team-collaboration panel, or null before the first update.
     */
    aiTeam: AiTeamProjection | null
  }
}

export type {}
