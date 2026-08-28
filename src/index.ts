// dsh-ai-team — host (Node) half of the plugin.
//
// A DeepSeek Harness plugin is a TypeScript module that exports named metadata
// (name / inject / Config / apply). Never use a default export: the loader
// folds default exports and silently drops the named metadata, breaking inject.

import { EventEmitter } from 'node:events';
import type { Context } from '@deepseek-ai/cordis';
import { CliGit } from './git.js';
import { TeamService } from './service.js';
import { buildTools } from './tools.js';
import { registerApi } from './api.js';
import { Config, type AiTeamConfig } from './config.js';

export const name = 'ai-team';
export const inject = ['tools'] as const;
export { Config };

export function apply(ctx: Context, config: AiTeamConfig): void {
  const git = new CliGit();
  const events = new EventEmitter();
  events.setMaxListeners(64);

  const service = new TeamService({ stateDir: config.stateDir, git, events });
  void service.load();

  // Expose the service so other plugins can orchestrate teams programmatically.
  ctx.provide('aiTeam', service);

  // Register the model-facing tools (leader agent drives these).
  for (const tool of buildTools(service)) {
    ctx.tools.register(tool);
  }

  // Host HTTP API for the browser panel. Optional: only when a web server exists
  // (i.e. the web profile). Wrapped in ctx.effect so the routes are removed on
  // unload — no manual cleanup, no ghost handlers.
  const webServer = ctx.get('webServer');
  if (webServer) {
    ctx.effect(() => registerApi(webServer as any, service, config.apiBase), 'ai-team: http api');
  }

  // Live updates: when enabled, a file watcher would be wired here and its
  // disposer returned from ctx.effect. Left as an extension point to avoid an
  // extra dependency; the panel also polls /state on an interval.
  if (config.enableFileWatch) {
    ctx.effect(() => {
      const timer = setInterval(() => events.emit('ai-team/update', service.snapshot()), 2000);
      return () => clearInterval(timer);
    }, 'ai-team: poll');
  }

  ctx.logger?.info?.('[ai-team] team service ready');
}
