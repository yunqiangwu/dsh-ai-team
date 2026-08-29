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
import type { PauseOnEscalation, QuestionnaireMode, RemotePlatform } from '../view.js';

export interface AutopilotOptions {
  rootDir: string;
  stateDir?: string | undefined;
  baseBranch: string;
  maxMembers: number;
  maxTasks: number;
  remote: {
    url: string;
    sshKeyEnv: string;
    platform: RemotePlatform;
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
    /**
     * 单任务成本预算（墙钟小时，允许小数）：从派发起超过此时长仍未完成的
     * in_progress 任务升级 budget-exceeded。stuckMinutes 只能发现「空闲」，
     * 这里挡的是「活跃空转」——插件看不见成员 agent 的 token 消耗，
     * 墙钟是唯一可靠的失控信号。0 = 关闭。
     */
    maxTaskHours: number;
  };
  escalation: {
    webhookUrlEnv?: string | undefined;
    label: string;
    pauseOnEscalation: PauseOnEscalation;
  };
  /**
   * 问卷（ask_human）的交付口径。`interactive` 让工具内部 await 答案、组长这一轮
   * 不结束；`async` 只落一条 open 问卷，答案回来后**由人开口**让组长继续 —— 插件
   * 没有"向会话投递一条消息"的写入口，这不是实现细节（docs/design-interaction.md §1.1）。
   */
  questionnaire: {
    mode: QuestionnaireMode;
    /** interactive 等待的上限（分钟）：到点转 expired，绝不把一轮永久挂住。 */
    timeoutMinutes: number;
  };
  /**
   * 重规划护栏（M3 §6.5）：单位时间 `task_cancel` / `task_replan` 调用上限，
   * 超限即拒绝 —— 「无限重排」是模型自己察觉不到的真实失败模式。
   * 0 = 不设限（测试与显式豁免用）。
   */
  replan: {
    maxPerHour: number;
  };
  /**
   * 文档先行的两个区：AI 只能写 `draftDir`，人批过才搬进 `formalDir`（§4.1）。
   * 判定按路径而非文件属性，所以两个目录必须在同一仓库布局下。
   */
  docs: {
    draftDir: string;
    formalDir: string;
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
      /**
       * 绑定地址。**非回环一律拒绝启动**（`TicketServer.start()` 直接抛）——
       * 这个端点收的答案等于替 AI 团队做决策，见 docs/design-interaction.md §8-9。
       * 远程访问请走 SSH 隧道（PILOT.md）。
       */
      host: string;
      port: number;
      /**
       * 人从哪个地址访问我们（例如 http://server:8080）。两重语义：
       * ① 邮件/webhook 里展示的工单链接的根；② 同源围栏的可信 `Host` 清单 ——
       * Host 改写的反代只有配在这里才过得了面板那条路由的门。
       */
      publicBaseUrl: string;
    };
    /**
     * 自动恢复：工单被答复后直接回写答案并清除升级（任务回到 pending），
     * 无需再等一次 escalation_resolve。
     *
     * ⚠️ 残余风险不在鉴权而在本机：独立工单端口现在要求 `?t=<token>`，面板那条
     * 同源路由要求过宿主那套围栏，但**围栏挡不住本机任意进程**（`node` 自己就能
     * 把 `Host` 设成 127.0.0.1）—— 与命令白名单同一定位（AGENTS.md 安全硬规则 2）。
     * 所以默认只绑 127.0.0.1 这件事仍然是这条开关的主要防线。
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
  /**
   * 面向运维的告警出口：由插件层接到 `ctx.logger.warn`。
   *
   * 本服务不认识 cordis（架构铁律 1），所以"这事不致命但人该知道"的几处 ——
   * 工单端点没能监听、表单渲染抛错、同源路由挂载冲突 —— 一律走这里，而不是
   * 静默吞掉，也不是抛出去拖垮守护进程。
   */
  warn?: (message: string, error?: unknown) => void;
}
