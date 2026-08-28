/**
 * The ONE home of dsh-ai-team's session-log vocabulary: the
 * `autopilot/update` whole-state snapshot event plus the `autopilot`
 * projection key, declared via declaration merging exactly like the official
 * plugins. Pure types — no runtime imports — so both halves can pull this in.
 *
 * Whole-value rule: every `autopilot/update` carries the complete replacement
 * AutopilotProjection, so the projection fold is last-write-wins.
 */
import type { AutopilotProjection } from './view.js';
// Pull the augmented modules into the program so the declaration merges
// below resolve (erased at compile time; type-only).
// oxlint-disable-next-line unicorn/require-module-specifiers
import type {} from '@deepseek-ai/dsh-session/types';
// oxlint-disable-next-line unicorn/require-module-specifiers
import type {} from '@deepseek-ai/dsh-session-projection/types';

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole-state snapshot of the autopilot; latest write wins on replay. */
    'autopilot/update': {
      state: AutopilotProjection;
    };
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * Loop state, teams, task board, gate results, escalation feed and
     * deploy history rendered by the autopilot panel, or null before the
     * first update.
     */
    autopilot: AutopilotProjection | null;
  }
  interface SessionProjectionStateMap {
    /** Host fold state for the autopilot unit: same whole-value snapshot. */
    autopilot: AutopilotProjection | null;
  }
}

