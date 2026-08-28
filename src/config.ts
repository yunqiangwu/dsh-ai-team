// Plugin configuration, validated at load time by @deepseek-ai/schemastery.
// Anything two deployments might want to differ on should be a config field.

import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  /** Directory (relative to the harness working dir) where team state + git repos live. */
  stateDir: z.string().default('.dsh-ai-team'),
  /** Hard cap on members per team. */
  maxMembers: z.number().default(12),
  /** When true, watch the shared repo and push live updates to the panel. */
  enableFileWatch: z.boolean().default(false),
  /** Base path the host HTTP API is mounted under. */
  apiBase: z.string().default('/api/ai-team'),
});

export interface AiTeamConfig {
  stateDir: string;
  maxMembers: number;
  enableFileWatch: boolean;
  apiBase: string;
}
