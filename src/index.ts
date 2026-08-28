/**
 * dsh-ai-team plugin entry.
 *
 * Named exports only (name / inject / Config / apply): the Loader's default
 * unwrapping drops the Config schema when a default export is mixed in.
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { registerAutopilotProjection } from './projection.js';
import { AutopilotService } from './service.js';
import { registerAutopilotTools } from './tools.js';

export const name = 'dsh-ai-team';

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
    })
    .default({
      enabled: true,
      toolchain: ['git', 'bun', 'pnpm'],
      setupCommand: 'pnpm run setup',
      verifyCommand: 'pnpm run e2e:local',
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
      commandAllowlist: z.array(z.string()).default(['pnpm', 'git', 'bun', 'docker']),
      pushRequiresGates: z.boolean().default(true),
    })
    .default({
      forbiddenPaths: ['.github/', 'AGENTS.md', 'LICENSE'],
      commandAllowlist: ['pnpm', 'git', 'bun', 'docker'],
      pushRequiresGates: true,
    }),
});

export async function apply(ctx: Context, config: Config): Promise<void> {
  const service = await AutopilotService.create({
    rootDir: config.rootDir,
    stateDir: config.stateDir === '' ? undefined : config.stateDir,
    baseBranch: config.baseBranch,
    maxMembers: config.maxMembers,
    maxTasks: config.maxTasks,
    remote: {
      url: config.remote.url,
      sshKeyEnv: config.remote.sshKeyEnv,
      platform: config.remote.platform,
      apiTokenEnv: config.remote.apiTokenEnv === '' ? undefined : config.remote.apiTokenEnv,
    },
    bootstrap: config.bootstrap,
    gates: {
      commands: config.gates.commands,
      e2eCommand: config.gates.e2eCommand === '' ? undefined : config.gates.e2eCommand,
      requireCiGreen: config.gates.requireCiGreen,
      timeoutMinutes: config.gates.timeoutMinutes,
    },
    daemon: config.daemon,
    escalation: {
      webhookUrlEnv: config.escalation.webhookUrlEnv === '' ? undefined : config.escalation.webhookUrlEnv,
      label: config.escalation.label,
      pauseOnEscalation: config.escalation.pauseOnEscalation,
    },
    notification: config.notification?.enabled === true ? {
      enabled: true,
      smtp: {
        host: config.notification.smtp.host,
        port: config.notification.smtp.port,
        secure: config.notification.smtp.secure,
        userEnv: config.notification.smtp.userEnv,
        passEnv: config.notification.smtp.passEnv,
        fromEnv: config.notification.smtp.fromEnv === '' ? undefined : config.notification.smtp.fromEnv,
        startTls: config.notification.smtp.startTls,
      },
      mailTo: config.notification.mailTo,
      ticket: {
        host: config.notification.ticket.host,
        port: config.notification.ticket.port,
        publicBaseUrl: config.notification.ticket.publicBaseUrl,
      },
      autoResume: config.notification.autoResume,
    } : undefined,
    deploy: {
      enabled: config.deploy.enabled,
      command: config.deploy.command === '' ? undefined : config.deploy.command,
      healthCheckUrl: config.deploy.healthCheckUrl === '' ? undefined : config.deploy.healthCheckUrl,
      rollbackCommand: config.deploy.rollbackCommand === '' ? undefined : config.deploy.rollbackCommand,
      secretsEnv: config.deploy.secretsEnv,
    },
    security: config.security,
  });
  // Expose the service for other plugins (and for tests driving the host).
  ctx.provide('autopilot', service);
  // Host → Web UI data flow: `autopilot` session projection. The optional
  // inject seam keeps headless profiles working.
  registerAutopilotProjection(ctx);
  // Model-facing tools; each mutation appends `autopilot/update` to the log.
  registerAutopilotTools(ctx, service);
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
