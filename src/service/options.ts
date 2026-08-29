/**
 * 运行时选项（`Config` 经 index.ts 校验、映射之后的形态）。
 *
 * 单独成模块是因为它纯粹是数据形状：读 service.ts 的编排逻辑时，
 * 这 120 行字段声明只是噪声；而改一个配置字段的连带面（index.ts 的 Config
 * 与 schema、apply() 的映射、README、设置卡片）由 AGENTS.md 的联动表管着。
 *
 * 与 `Config` 的两处刻意差异：可选项统一写成 `?: T | undefined`（配合
 * `exactOptionalPropertyTypes: false` 下的显式赋值），以及末尾两个测试钩子
 * —— 生产配置里没有它们。
 */
import type { LearningOptions } from '../learnings.js';
import type { ProjectProfile } from '../profile.js';

export interface AutopilotOptions {
  rootDir: string;
  stateDir?: string | undefined;
  baseBranch: string;
  maxMembers: number;
  maxTasks: number;
  remote: {
    url: string;
    sshKeyEnv: string;
    platform: 'github' | 'cnb' | 'gitlab' | 'generic';
    apiTokenEnv?: string | undefined;
  };
  bootstrap: {
    enabled: boolean;
    toolchain: string[];
    setupCommand: string;
    verifyCommand: string;
    /** 原生模块编译所需的系统包（如 node-gyp 用的 python3/make/g++）。 */
    systemPackages?: string[] | undefined;
    /** 包管理器命令（受白名单约束），例如 `sudo apt-get install -y`。 */
    packageManagerCommand?: string | undefined;
    /** 要从提交在仓库里的示例文件生成的 `.env` 路径（缺关键项时报错）。 */
    envFile?: string | undefined;
    /** 仓库中已提交的 `.env.example` 路径。 */
    envExample?: string | undefined;
    /** 启动时必需的环境变量名；缺失即响亮失败。 */
    requiredEnvKeys?: string[] | undefined;
  };
  gates: {
    commands: string[];
    requireCiGreen: boolean;
    timeoutMinutes: number;
  };
  daemon: {
    maxReviewRounds: number;
    stuckMinutes: number;
    /** 每拍的轮询间隔；心跳文件就是每拍写一次，所以没有独立的心跳间隔配置。 */
    pollIntervalSeconds: number;
    /**
     * 评审通过前的改动体量门：单个任务的 base..branch 累计增删行数 / 变更文件数
     * 上限，超限不许 approve（只能升级让人决定是拆任务还是放行）。0 = 关闭。
     */
    maxDiffLines: number;
    maxDiffFiles: number;
  };
  escalation: {
    webhookUrlEnv?: string | undefined;
    label: string;
    pauseOnEscalation: 'task' | 'team';
  };
  notification?: {
    enabled: boolean;
    /** SMTP 传输配置。 */
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      userEnv: string;
      passEnv: string;
      fromEnv?: string | undefined;
      startTls?: boolean | undefined;
    };
    /** 人工通知邮件的收件人（逗号/空格分隔多个）。 */
    mailTo: string;
    /** 本地工单端点监听地址。 */
    ticket: {
      host: string;
      port: number;
      /** 邮件里展示给人的访问基址（例如 http://server:8080）。 */
      publicBaseUrl: string;
    };
    /**
     * 自动恢复：工单被答复后直接回写答案并清除升级（任务回到 pending），
     * 无需再等一次 escalation_resolve。⚠️ 工单端点本身无鉴权，只有确认它
     * 不可被未授权方访问（默认只绑 127.0.0.1）时才应开启。
     */
    autoResume: boolean;
    /** "From" 头的环境变量名；缺省回落到 smtp.fromEnv。 */
    fromEnv?: string | undefined;
  } | undefined;
  deploy?: {
    enabled: boolean;
    command?: string | undefined;
    healthCheckUrl?: string | undefined;
    rollbackCommand?: string | undefined;
    secretsEnv: string[];
    /**
     * base 自上次部署以来只前进了 `.tasks/` 提交（任务单状态回写、看板重生成）时
     * 跳过部署。这些提交不含任何代码变更，跑一次部署既无意义又可能因健康检查抖动
     * 触发回滚与 deploy-failed 升级。缺省即开（消费侧用 `!== false` 判定）。
     */
    skipTasksOnlyCommits?: boolean | undefined;
  } | undefined;
  security: {
    forbiddenPaths: string[];
    commandAllowlist: string[];
    pushRequiresGates: boolean;
  };
  /**
   * 项目画像适配器：目标仓库的协作约定（分支/PR 命名、合并策略、条件质量门、
   * 禁区策略、所有权路由）。默认画像完全复刻插件的历史行为，项目预设
   * （如 AgentDeploy）只需覆盖有差异的字段。
   */
  profile: ProjectProfile;
  /**
   * 可选的构建缓存共享：把被 gitignore 的构建/测试缓存目录软链到按分支共享的
   * 位置，让相邻任务复用上一次产物而不是从头构建。尽力而为，默认关闭。
   */
  buildCache?: { enabled: boolean; dirs: string[] } | undefined;
  /**
   * 知识回路：把评审意见、升级与部署失败沉淀成跨任务可复用的教训，并在派发时
   * 注入新任务描述。默认关闭 —— 开启会改变 agent 看到的提示词，属于行为变更。
   */
  learnings?: LearningOptions | undefined;
  /** 测试钩子：缩短循环中的 sleep/退避时长。 */
  tickSleepMs?: number | undefined;
  /** 测试钩子：注入 fetch，用于 webhook / CI / 健康检查调用。 */
  fetchFn?: typeof fetch | undefined;
}
