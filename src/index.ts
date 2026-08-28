/**
 * dsh-ai-team plugin entry.
 *
 * Named exports only (name / inject / Config / apply): the Loader's default
 * unwrapping drops the Config schema when a default export is mixed in.
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { registerAutopilotProjection } from './projection.js';
import { ensureAutopilotTeamPreset } from './preset.js';
import { AUTOPILOT_TEAM_PRESET_ID } from './preset.js';
import { resolveProjectProfile } from './profile.js';
import type { ProjectProfileInput } from './profile.js';
import { DEFAULT_CACHE_DIRS } from './cache.js';
import { AutopilotService } from './service.js';
import { registerAutopilotTools } from './tools.js';

export const name = 'dsh-ai-team';

/** Name of the auto-created demo team rendered in the kanban panel. */
const DEMO_TEAM_NAME = 'demo';

/** The tool runtime is mandatory; sessionProjections is optional (headless). */
export const inject = ['tools'];

/** Post-validation config shape (every field resolved, defaults applied). */
export interface Config {
  rootDir: string;
  stateDir: string;
  baseBranch: string;
  maxMembers: number;
  maxTasks: number;
  remote: {
    url: string;
    sshKeyEnv: string;
    platform: 'github' | 'cnb' | 'gitlab' | 'generic';
    apiTokenEnv: string;
  };
  bootstrap: {
    enabled: boolean;
    toolchain: string[];
    setupCommand: string;
    verifyCommand: string;
  };
  gates: {
    commands: string[];
    e2eCommand: string;
    requireCiGreen: boolean;
    timeoutMinutes: number;
  };
  daemon: {
    heartbeatSeconds: number;
    maxReviewRounds: number;
    stuckMinutes: number;
    pollIntervalSeconds: number;
  };
  escalation: {
    webhookUrlEnv: string;
    label: string;
    pauseOnEscalation: 'task' | 'team';
  };
  notification?: {
    enabled: boolean;
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      userEnv: string;
      passEnv: string;
      fromEnv: string;
      startTls: boolean;
    };
    mailTo: string;
    ticket: {
      host: string;
      port: number;
      publicBaseUrl: string;
    };
    autoResume: boolean;
  } | undefined;
  deploy: {
    enabled: boolean;
    command: string;
    healthCheckUrl: string;
    rollbackCommand: string;
    secretsEnv: string[];
  };
  security: {
    forbiddenPaths: string[];
    commandAllowlist: string[];
    pushRequiresGates: boolean;
  };
  /**
   * Opt-in build-cache sharing: symlink gitignored build/test cache dirs to a
   * shared per-branch location so consecutive tasks reuse prior output.
   */
  buildCache?: {
    enabled: boolean;
    dirs: string[];
  };
  /**
   * Project-profile adapter (see src/profile.ts): encode a target
   * repository's conventions (branch/PR naming, merge strategy, conditional
   * gates, forbidden-zone policy, ownership routing). `preset: agentdeploy`
   * seeds the AgentDeploy conventions; inline fields override them.
   */
  profile?: ProjectProfileInput;
}

export const Config: z<Config> = z.object({
  rootDir: z.string().default('.dsh-ai-team'),
  stateDir: z.string().default(''),
  baseBranch: z.string().default('main'),
  maxMembers: z.number().step(1).min(1).default(8),
  maxTasks: z.number().step(1).min(1).default(512),

  remote: z
    .object({
      url: z.string().default(''),
      sshKeyEnv: z.string().default('AUTOPILOT_GIT_KEY'),
      platform: z
        .union([z.const('github'), z.const('cnb'), z.const('gitlab'), z.const('generic')])
        .default('generic'),
      apiTokenEnv: z.string().default(''),
    })
    .default({ url: '', sshKeyEnv: 'AUTOPILOT_GIT_KEY', platform: 'generic', apiTokenEnv: '' }),

  bootstrap: z
    .object({
      enabled: z.boolean().default(true),
      toolchain: z.array(z.string()).default(['git', 'bun', 'pnpm']),
      setupCommand: z.string().default('pnpm run setup'),
      verifyCommand: z.string().default('pnpm run e2e:local'),
      systemPackages: z.array(z.string()).default([]),
      packageManagerCommand: z.string().default(''),
      envFile: z.string().default(''),
      envExample: z.string().default(''),
      requiredEnvKeys: z.array(z.string()).default([]),
    })
    .default({
      enabled: true,
      toolchain: ['git', 'bun', 'pnpm'],
      setupCommand: 'pnpm run setup',
      verifyCommand: 'pnpm run e2e:local',
      systemPackages: [],
      packageManagerCommand: '',
      envFile: '',
      envExample: '',
      requiredEnvKeys: [],
    }),

  gates: z
    .object({
      commands: z
        .array(z.string())
        .default(['pnpm run typecheck', 'pnpm run lint', 'pnpm run test', 'pnpm run build']),
      e2eCommand: z.string().default('pnpm run e2e:local'),
      requireCiGreen: z.boolean().default(true),
      timeoutMinutes: z.number().step(1).min(1).default(30),
    })
    .default({
      commands: ['pnpm run typecheck', 'pnpm run lint', 'pnpm run test', 'pnpm run build'],
      e2eCommand: 'pnpm run e2e:local',
      requireCiGreen: true,
      timeoutMinutes: 30,
    }),

  daemon: z
    .object({
      heartbeatSeconds: z.number().step(1).min(1).default(60),
      maxReviewRounds: z.number().step(1).min(1).default(3),
      stuckMinutes: z.number().step(1).min(1).default(45),
      pollIntervalSeconds: z.number().step(1).min(1).default(30),
    })
    .default({ heartbeatSeconds: 60, maxReviewRounds: 3, stuckMinutes: 45, pollIntervalSeconds: 30 }),

  escalation: z
    .object({
      webhookUrlEnv: z.string().default(''),
      label: z.string().default('needs-human'),
      pauseOnEscalation: z.union([z.const('task'), z.const('team')]).default('task'),
    })
    .default({ webhookUrlEnv: '', label: 'needs-human', pauseOnEscalation: 'task' }),

  notification: z
    .object({
      enabled: z.boolean().default(false),
      smtp: z
        .object({
          host: z.string().default(''),
          port: z.number().step(1).min(1).default(465),
          secure: z.boolean().default(true),
          userEnv: z.string().default(''),
          passEnv: z.string().default(''),
          fromEnv: z.string().default(''),
          startTls: z.boolean().default(true),
        })
        .default({ host: '', port: 465, secure: true, userEnv: '', passEnv: '', fromEnv: '', startTls: true }),
      mailTo: z.string().default(''),
      ticket: z
        .object({
          host: z.string().default('127.0.0.1'),
          // 0 picks an ephemeral port (used when the server has no fixed port or
          // when publicBaseUrl is provided by a reverse proxy).
          port: z.number().step(1).min(0).default(0),
          publicBaseUrl: z.string().default(''),
        })
        .default({ host: '127.0.0.1', port: 0, publicBaseUrl: '' }),
      autoResume: z.boolean().default(false),
    })
    .default({
      enabled: false,
      smtp: { host: '', port: 465, secure: true, userEnv: '', passEnv: '', fromEnv: '', startTls: true },
      mailTo: '',
      ticket: { host: '127.0.0.1', port: 0, publicBaseUrl: '' },
      autoResume: false,
    }),

  deploy: z
    .object({
      enabled: z.boolean().default(false),
      command: z.string().default(''),
      healthCheckUrl: z.string().default(''),
      rollbackCommand: z.string().default(''),
      secretsEnv: z.array(z.string()).default([]),
    })
    .default({ enabled: false, command: '', healthCheckUrl: '', rollbackCommand: '', secretsEnv: [] }),

  security: z
    .object({
      forbiddenPaths: z.array(z.string()).default(['.github/', 'AGENTS.md', 'LICENSE']),
      commandAllowlist: z.array(z.string()).default(['pnpm', 'git', 'bun', 'docker', 'node', 'bunx', 'ssh', 'nuxt']),
      pushRequiresGates: z.boolean().default(true),
    })
    .default({
      forbiddenPaths: ['.github/', 'AGENTS.md', 'LICENSE'],
      commandAllowlist: ['pnpm', 'git', 'bun', 'docker', 'node', 'bunx', 'ssh', 'nuxt'],
      pushRequiresGates: true,
    }),

  buildCache: z
    .object({
      enabled: z.boolean().default(false),
      dirs: z.array(z.string()).default(DEFAULT_CACHE_DIRS),
    })
    .default({ enabled: false, dirs: DEFAULT_CACHE_DIRS }),

  profile: z
    .object({
      preset: z.string().default(''),
      branchTemplate: z.string().default(''),
      prTitleTemplate: z.string().default(''),
      prBodyTemplate: z.string().default(''),
      mergeStrategy: z.string().default(''),
      gates: z
        .array(
          z.object({
            command: z.string(),
            when: z.array(z.string()).default([]),
            role: z.union([z.const('local'), z.const('ci')]).default('local'),
          }),
        )
        .default([]),
      forbidden: z
        .array(
          z.object({
            path: z.string(),
            mode: z.union([z.const('block'), z.const('needs-approval'), z.const('high-conflict')]).default('block'),
          }),
        )
        .default([]),
      ownership: z.array(z.object({ glob: z.string(), role: z.string() })).default([]),
      crossDomainThreshold: z.number().step(1).min(1).default(3),
    })
    .default({
      preset: '',
      branchTemplate: '',
      prTitleTemplate: '',
      prBodyTemplate: '',
      mergeStrategy: '',
      gates: [],
      forbidden: [],
      ownership: [],
      crossDomainThreshold: 3,
    }),
});

export async function apply(ctx: Context, config: Config): Promise<void> {
  // Optional settings seam (Web "Plugin configuration" tab): register the
  // `autopilot` namespace so the browser card can edit key fields, and read the
  // effective config from the resolved scope when a settings service is mounted.
  // When none is mounted (headless), the source falls back to the entry config.
  let current: () => Config = () => config;
  installSettingsSection(ctx, settingsNamespace('autopilot'), Config, config, {
    setSource: (get) => {
      current = get as () => Config;
    },
    onChange: () => {
      // Re-judge derived state here if the plugin ever needs live config edits.
    },
  });
  const effective = current();
  const service = await AutopilotService.create({
    rootDir: effective.rootDir,
    stateDir: effective.stateDir === '' ? undefined : effective.stateDir,
    baseBranch: effective.baseBranch,
    maxMembers: effective.maxMembers,
    maxTasks: effective.maxTasks,
    remote: {
      url: effective.remote.url,
      sshKeyEnv: effective.remote.sshKeyEnv,
      platform: effective.remote.platform,
      apiTokenEnv: effective.remote.apiTokenEnv === '' ? undefined : effective.remote.apiTokenEnv,
    },
    bootstrap: effective.bootstrap,
    gates: {
      commands: effective.gates.commands,
      e2eCommand: effective.gates.e2eCommand === '' ? undefined : effective.gates.e2eCommand,
      requireCiGreen: effective.gates.requireCiGreen,
      timeoutMinutes: effective.gates.timeoutMinutes,
    },
    daemon: effective.daemon,
    escalation: {
      webhookUrlEnv: effective.escalation.webhookUrlEnv === '' ? undefined : effective.escalation.webhookUrlEnv,
      label: effective.escalation.label,
      pauseOnEscalation: effective.escalation.pauseOnEscalation,
    },
    notification: effective.notification?.enabled === true ? {
      enabled: true,
      smtp: {
        host: effective.notification.smtp.host,
        port: effective.notification.smtp.port,
        secure: effective.notification.smtp.secure,
        userEnv: effective.notification.smtp.userEnv,
        passEnv: effective.notification.smtp.passEnv,
        fromEnv: effective.notification.smtp.fromEnv === '' ? undefined : effective.notification.smtp.fromEnv,
        startTls: effective.notification.smtp.startTls,
      },
      mailTo: effective.notification.mailTo,
      ticket: {
        host: effective.notification.ticket.host,
        port: effective.notification.ticket.port,
        publicBaseUrl: effective.notification.ticket.publicBaseUrl,
      },
      autoResume: effective.notification.autoResume,
    } : undefined,
    deploy: {
      enabled: effective.deploy.enabled,
      command: effective.deploy.command === '' ? undefined : effective.deploy.command,
      healthCheckUrl: effective.deploy.healthCheckUrl === '' ? undefined : effective.deploy.healthCheckUrl,
      rollbackCommand: effective.deploy.rollbackCommand === '' ? undefined : effective.deploy.rollbackCommand,
      secretsEnv: effective.deploy.secretsEnv,
    },
    security: effective.security,
    buildCache: { enabled: effective.buildCache?.enabled ?? false, dirs: effective.buildCache?.dirs ?? DEFAULT_CACHE_DIRS },
    profile: resolveProjectProfile(effective.profile, effective.gates.commands),
  });
  // Expose the service for other plugins (and for tests driving the host).
  ctx.provide('autopilot', service);
  // Host → Web UI data flow: `autopilot` session projection. The optional
  // inject seam keeps headless profiles working.
  registerAutopilotProjection(ctx);
  // Model-facing tools; each mutation appends `autopilot/update` to the log.
  registerAutopilotTools(ctx, service);
  // Ship the `autopilot-team` agent preset: copy it into a user preset root on
  // load (best-effort, never overwrites) so the roster exposes the mode on a
  // fresh install without manual file creation.
  ctx.inject(['agentPresets'], (presetCtx) => {
    const presets = (presetCtx as unknown as {
      agentPresets: { roots: { trust: string; path: string }[] };
    }).agentPresets;
    const userRoot = presets.roots.filter((root) => root.trust === 'user').pop()?.path;
    void ensureAutopilotTeamPreset(userRoot);
  });
  // Auto-provision UX: when a session joins the `autopilot-team` agent preset,
  // ensure a demo team exists and push the projection to that session so the
  // kanban panel lights up immediately — no manual first tool call needed.
  ctx.on('session/event', (rawSession, rawEvent) => {
    const adoptedEvent = rawEvent as unknown as { type?: string; data?: { agentPreset?: string } };
    if (adoptedEvent.type !== 'agent-preset/selected') return;
    const presetId = adoptedEvent.data?.agentPreset;
    if (presetId !== AUTOPILOT_TEAM_PRESET_ID) return;
    const session = rawSession as {
      append(type: string, data: unknown, opts?: { ignorable?: true }): void;
    };
    void (async () => {
      try {
        if (service.projection().teams.length === 0) {
          await service.createTeam({ name: DEMO_TEAM_NAME });
        }
        // Always yield to a microtask before appending: we are running inside
        // the `agent-preset/selected` append's publication boundary, and a
        // synchronous re-entrant `session.append` is rejected.
        await Promise.resolve();
        session.append('autopilot/update', {
          state: service.projection(),
        }, { ignorable: true });
      } catch (error) {
        ctx.logger.warn('autopilot: demo-team auto-provision failed', error);
      }
    })();
  });
  // State persistence, loop shutdown and listener teardown ride the plugin
  // lifecycle: unloading the plugin stops the daemon and flushes state.json.
  ctx.effect(
    () => () => void service.dispose(),
    'autopilot: stop loop and flush state',
  );
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autopilot: AutopilotService;
  }
}

export { AutopilotService } from './service.js';
export { ensureAutopilotTeamPreset } from './preset.js';
