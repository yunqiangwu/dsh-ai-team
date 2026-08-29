/**
 * dsh-ai-team 插件入口。
 *
 * 仅使用具名导出（name / inject / Config / apply）：当混入 default 导出时，
 * Loader 的默认解包行为会丢掉 Config schema。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { registerAutopilotProjection } from './projection.js';
import { ensureAutopilotTeamPreset } from './preset.js';
import { AUTOPILOT_TEAM_PRESET_ID } from './preset.js';
import { resolveProjectProfile } from './profile.js';
import type { ProjectProfileInput } from './profile.js';
import { DEFAULT_CACHE_DIRS } from './cache.js';
import { DEFAULT_LEARNINGS } from './learnings.js';
import type { LearningOptions } from './learnings.js';
import { AutopilotService } from './service.js';
import { registerAutopilotTools } from './tools.js';
import type { QuestionnaireMode } from './view.js';
import { TICKET_ROUTE_PREFIX } from './view.js';

export const name = 'dsh-ai-team';

/**
 * 宿主 `webServer` 服务在本插件里用到的那一小块。
 *
 * 刻意不 import `@deepseek-ai/dsh-host-webserver`：那是宿主自己的装配，跟它的
 * 版本一起被钉住毫无收益。形状对齐该包的 `WebRoute`（`kind` + 绝对路径 +
 * 拥有整个响应生命周期的 handler），`register` 返回 disposer。
 */
interface HostWebServer {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
  }): () => void;
}

/** 看板面板中渲染的、自动创建的演示团队名称。 */
const DEMO_TEAM_NAME = 'demo';

/** 工具运行时是必需依赖；sessionProjections 为可选（无头模式）。 */
export const inject = ['tools'];

/** 校验完成后的配置形态（所有字段均已解析，默认值已应用）。 */
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
    requireCiGreen: boolean;
    timeoutMinutes: number;
  };
  daemon: {
    maxReviewRounds: number;
    stuckMinutes: number;
    pollIntervalSeconds: number;
    /** 单个任务允许的最大累计增删行数，超限不许 approve；0 = 关闭该门。 */
    maxDiffLines: number;
    /** 单个任务允许的最大变更文件数；0 = 关闭该门。 */
    maxDiffFiles: number;
    /** 单任务墙钟预算（小时，允许小数）：派发后超时未完成即升级 budget-exceeded；0 = 关闭。 */
    maxTaskHours: number;
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
    /** base 只前进了 `.tasks/` 提交时跳过部署（默认开）。 */
    skipTasksOnlyCommits: boolean;
  };
  security: {
    forbiddenPaths: string[];
    commandAllowlist: string[];
    pushRequiresGates: boolean;
  };
  /**
   * 可选的构建缓存共享：把 gitignore 的构建/测试缓存目录软链到按分支共享的位置，
   * 让相邻任务复用先前的产物。
   */
  buildCache?: {
    enabled: boolean;
    dirs: string[];
  };
  /**
   * 知识回路：把评审意见、升级与部署失败沉淀成跨任务教训，并在派发时注入新任务
   * 描述。默认关闭 —— 开启会改变成员看到的提示词。`<stateDir>/learnings.md` 是它的
   * 全量生成物；升格进项目文档由 leader 落，但要单独成 docs-only 变更。
   */
  learnings?: LearningOptions | undefined;
  /**
   * 提问通道（见 docs/design-interaction.md §3）：`interactive` 让 `ask_human`
   * 真等到人答复再返回（组长的一轮 agent 因此不断线）；`async` 登记问卷后立即
   * 返回，人答完由组长继续。问卷是独立实体，不置 needs-human、不进升级直方图。
   */
  questionnaire: {
    mode: QuestionnaireMode;
    /** interactive 模式等待人答复的墙钟上限；超时按各题默认值继续并置 expired。 */
    timeoutMinutes: number;
  };
  /**
   * 文档先行的目录约定（见 docs/design-interaction.md §4）：AI 只能写 `draftDir`，
   * `formalDir` 的唯一落盘出口是 `doc_approve`（要一次性审批码）。
   */
  docs: {
    draftDir: string;
    formalDir: string;
  };
  /**
   * 项目 profile 适配器（见 src/profile.ts）：把目标仓库的协作约定编码进来
   * （branch/PR 命名、合并策略、条件化 gates、禁区策略、ownership 路由）。
   * `preset: agentdeploy` 预置 AgentDeploy 的约定，内联字段可覆盖它们。
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
      requireCiGreen: z.boolean().default(true),
      timeoutMinutes: z.number().step(1).min(1).default(30),
    })
    .default({
      commands: ['pnpm run typecheck', 'pnpm run lint', 'pnpm run test', 'pnpm run build'],
      requireCiGreen: true,
      timeoutMinutes: 30,
    }),

  daemon: z
    .object({
      maxReviewRounds: z.number().step(1).min(1).default(3),
      stuckMinutes: z.number().step(1).min(1).default(45),
      pollIntervalSeconds: z.number().step(1).min(1).default(30),
      // 0 = 关闭该门：评审体量上限对既有团队是行为变更，必须显式开启。
      maxDiffLines: z.number().step(1).min(0).default(0),
      maxDiffFiles: z.number().step(1).min(0).default(0),
      // 允许小数（0.5 = 半小时）；0 = 关闭，与 maxDiff* 同属显式开启的行为变更。
      maxTaskHours: z.number().min(0).default(0),
    })
    .default({
      maxReviewRounds: 3,
      stuckMinutes: 45,
      pollIntervalSeconds: 30,
      maxDiffLines: 0,
      maxDiffFiles: 0,
      maxTaskHours: 0,
    }),

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
          // 0 表示选择临时端口（适用于服务没有固定端口、
          // 或 publicBaseUrl 由反向代理提供的场景）。
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
      skipTasksOnlyCommits: z.boolean().default(true),
    })
    .default({
      enabled: false,
      command: '',
      healthCheckUrl: '',
      rollbackCommand: '',
      secretsEnv: [],
      skipTasksOnlyCommits: true,
    }),

  security: z
    .object({
      forbiddenPaths: z.array(z.string()).default(['LICENSE']),
      commandAllowlist: z.array(z.string()).default(['pnpm', 'git', 'bun', 'docker', 'node', 'bunx', 'ssh', 'nuxt']),
      pushRequiresGates: z.boolean().default(true),
    })
    .default({
      forbiddenPaths: ['LICENSE'],
      commandAllowlist: ['pnpm', 'git', 'bun', 'docker', 'node', 'bunx', 'ssh', 'nuxt'],
      pushRequiresGates: true,
    }),

  buildCache: z
    .object({
      enabled: z.boolean().default(false),
      dirs: z.array(z.string()).default(DEFAULT_CACHE_DIRS),
    })
    .default({ enabled: false, dirs: DEFAULT_CACHE_DIRS }),

  learnings: z
    .object({
      // 默认关闭：开启会改变成员每任务看到的提示词，属于行为变更。
      enabled: z.boolean().default(DEFAULT_LEARNINGS.enabled),
      injectMaxCount: z.number().step(1).min(1).default(DEFAULT_LEARNINGS.injectMaxCount),
      injectCharBudget: z.number().step(1).min(100).default(DEFAULT_LEARNINGS.injectCharBudget),
      promoteAfterHits: z.number().step(1).min(2).default(DEFAULT_LEARNINGS.promoteAfterHits),
      maxEntries: z.number().step(1).min(1).default(DEFAULT_LEARNINGS.maxEntries),
    })
    .default({ ...DEFAULT_LEARNINGS }),

  questionnaire: z
    .object({
      // schemastery 没有 enum 组合器，只能像 `remote.platform` 那样折叠字面量：
      // 取值以 vocab.ts 的 QUESTIONNAIRE_MODES 为准，接口侧已复用它。
      mode: z.union([z.const('interactive'), z.const('async')]).default('interactive'),
      timeoutMinutes: z.number().min(1).default(60),
    })
    .default({ mode: 'interactive', timeoutMinutes: 60 }),

  docs: z
    .object({
      draftDir: z.string().default('docs/drafts'),
      formalDir: z.string().default('docs'),
    })
    .default({ draftDir: 'docs/drafts', formalDir: 'docs' }),

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
  // 可选的 settings 接缝（Web 端“插件配置”标签页）：注册 `autopilot` 命名空间，
  // 让浏览器卡片可以编辑关键字段；当 settings 服务已挂载时，从解析后的作用域
  // 读取生效配置。未挂载（无头模式）时，数据源回退到入口配置。
  let current: () => Config = () => config;
  installSettingsSection(ctx, settingsNamespace('autopilot'), Config, config, {
    setSource: (get) => {
      current = get as () => Config;
    },
    onChange: () => {
      // 若插件将来需要运行时热改配置，可在此处重新推导派生状态。
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
      skipTasksOnlyCommits: effective.deploy.skipTasksOnlyCommits,
    },
    security: effective.security,
    buildCache: { enabled: effective.buildCache?.enabled ?? false, dirs: effective.buildCache?.dirs ?? DEFAULT_CACHE_DIRS },
    learnings: {
      enabled: effective.learnings?.enabled ?? DEFAULT_LEARNINGS.enabled,
      injectMaxCount: effective.learnings?.injectMaxCount ?? DEFAULT_LEARNINGS.injectMaxCount,
      injectCharBudget: effective.learnings?.injectCharBudget ?? DEFAULT_LEARNINGS.injectCharBudget,
      promoteAfterHits: effective.learnings?.promoteAfterHits ?? DEFAULT_LEARNINGS.promoteAfterHits,
      maxEntries: effective.learnings?.maxEntries ?? DEFAULT_LEARNINGS.maxEntries,
    },
    questionnaire: effective.questionnaire,
    docs: effective.docs,
    profile: resolveProjectProfile(effective.profile, effective.gates.commands),
    // 核心的告警出口：它不认识 cordis，所以这句"不致命但人该知道"要由插件层落地。
    warn: (message, error) => ctx.logger.warn(message, error),
  });
  // 把服务暴露给其它插件（以及驱动 host 的测试）。
  ctx.provide('autopilot', service);
  // Host → Web UI 数据流：`autopilot` session projection。
  // 可选的 inject 接缝保证无头 profile 也能工作。
  registerAutopilotProjection(ctx);
  // 面向模型的工具；每次变更都会向日志追加一条 `autopilot/update`。
  registerAutopilotTools(ctx, service);
  // 随包提供 `autopilot-team` agent preset：加载时把它复制到用户 preset 根目录
  // （尽力而为，绝不覆盖），这样全新安装后 roster 就能出现该模式，
  // 无需手工创建文件。
  ctx.inject(['agentPresets'], (presetCtx) => {
    const presets = (presetCtx as unknown as {
      agentPresets: { roots: { trust: string; path: string }[] };
    }).agentPresets;
    const userRoot = presets.roots.filter((root) => root.trust === 'user').pop()?.path;
    void ensureAutopilotTeamPreset(userRoot);
  });
  // 面板内作答（docs/design-interaction.md §7.1）：把工单端点也挂到宿主自己的
  // webServer 上，面板就只需发相对路径 —— 不需要知道实际端口（`ticket.port` 默认 0
  // 是运行时才知道的），不会有混合内容（跟着页面同一个 scheme 走），也不必为一个刚
  // 加上鉴权的端点开 CORS。
  // 走 ctx.inject 而不是顶层 `export const inject`：后者是硬依赖，无头 profile 会
  // 直接起不来。`webRuntime` 是宿主 web-app 提供的可信 Host 清单，与它对 /api 用的
  // 同一份 —— 面板能调到 /api 就必须能答工单，否则面板一半能用一半 404。
  ctx.inject(['webServer', 'webRuntime'], (webCtx) => {
    const { webServer, webRuntime } = webCtx as unknown as {
      webServer: HostWebServer;
      /** 宿主自带的可信 Host 清单（与它对 /api 用的同一份），缺席即只认回环。 */
      webRuntime?: { trustedHosts?: string[] };
    };
    const handler = service.panelTicketHandler(() => webRuntime?.trustedHosts ?? []);
    try {
      const dispose = webServer.register({
        kind: 'prefix',
        path: TICKET_ROUTE_PREFIX,
        handler: (request, response) => handler.handle(request, response),
      });
      webCtx.effect(() => dispose, 'autopilot: ticket route');
    } catch (error) {
      // 重复 (kind, path) 会抛（HMR / 双装载）。挂载失败只是面板内作答没了，
      // 邮件工单与会话内 answer_questionnaire 都还在，不该把插件拖死。
      webCtx.logger.warn('autopilot: 工单路由挂载失败，面板内作答不可用', error);
    }
  });
  // 自动供给的用户体验：当某个 session 选用 `autopilot-team` agent preset 时，
  // 确保演示团队存在，并把 projection 推送给该 session，让看板面板立即点亮——
  // 无需手工发起第一次工具调用。
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
        // 追加前必须让出到微任务：我们正处在 `agent-preset/selected` 追加操作的
        // 发布边界内，同步重入的 `session.append` 会被拒绝。
        await Promise.resolve();
        session.append('autopilot/update', {
          state: service.projection(),
        }, { ignorable: true });
      } catch (error) {
        ctx.logger.warn('autopilot: demo-team auto-provision failed', error);
      }
    })();
  });
  // 状态持久化、循环停止与监听器卸载都挂在插件生命周期上：
  // 卸载插件会停止守护循环并刷写 state.json。
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
