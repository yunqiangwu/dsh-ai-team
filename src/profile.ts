/**
 * 项目画像适配器 —— 让同一个引擎能驱动采用 *不同* 协作约定的仓库。
 *
 * AgentDeploy（ai-yunke）就是一个具体例子，其规则与插件历史默认值是
 * "同形但不同粒度"：分支 `agent/<id>-<slug>`（而非 `task/<id>`）、PR 标题
 * `feat(scope): [id] desc`（而非 `[id] title`）、**squash** 合并（而非
 * `--no-ff`），以及 *依赖任务 touches* 的、部分仅 CI 执行的质量门。与其硬编码
 * 这些，不如编码成 {@link ProjectProfile}，让 service 从这里读取约定。
 *
 * 默认画像逐字复刻插件的原始行为，因此存量部署与测试不受影响；项目预设只
 * 覆盖有差异的字段。
 *
 * 本模块是纯 host 逻辑，不得 import node 内置模块（它不会被内联进 client
 * bundle，但保持纯净便于测试）。
 */
import { touchesOverlap } from './team.js';

/** 评审后的任务合入基础分支时采用的合并策略。 */
export type MergeStrategy = 'no-ff' | 'squash' | 'merge';

/**
 * 一条质量门命令，可以可选地按任务 touches 条件触发、并且可选地仅 CI 执行。
 */
export interface GateDef {
  command: string;
  /**
   * 任务 `touches` 的前缀。给出时，门仅在任务至少命中一条匹配路径时才运行。
   * 例：`when: ['server/db/']` 让 `db:check-parity` 只对触及 DB 层的任务运行。
   */
  when?: string[] | undefined;
  /**
   * `local` → 在成员 worktree 里运行（默认）。
   * `ci` → 只由仓库的远端 CI 强制，绝不在本地运行。
   * 用于那些因环境原因在本地必然失败（例如私有 registry 下没有 audit 端点的
   * `pnpm audit`）、但 CI 里仍然要求的门 —— 本地 approve 不被 `ci` 门阻塞，
   * 由远端 CI 门（`requireCiGreen`）负责强制。
   */
  role?: 'local' | 'ci' | undefined;
}

/** 任务分支触及禁区路径时的处理方式。 */
export type ForbiddenMode = 'block' | 'needs-approval' | 'high-conflict';

export interface ForbiddenRule {
  path: string;
  mode: ForbiddenMode;
}

/** 路径→域所有者映射，用于专精路由（可扩展）。 */
export interface OwnershipRule {
  glob: string;
  /** 项目期望的 owner 标签（如 `@agent-database`），或角色提示。 */
  role: string;
  /** 当任务落入该 glob 时注入的领域专属硬规则。 */
  rules?: string[] | undefined;
}

export interface ProjectProfile {
  /**
   * 分支名模板。`{id}` → 任务/契约 id，`{slug}` → 标题的 kebab-case
   * slug。默认 `task/{id}`。
   */
  branchTemplate: string;
  /** PR 标题模板。`{id}`、`{title}`、`{scope}`。 */
  prTitleTemplate: string;
  /** PR 正文模板（可多行）。`{id}`、`{title}`、`{touches}`、`{scope}`、`{assignment}`。 */
  prBodyTemplate: string;
  mergeStrategy: MergeStrategy;
  /**
   * 有序质量门。为空 → 回落到历史
   * `options.gates.commands` 列表（每条作为无条件的 `local` 门）。
   */
  gates: GateDef[];
  /**
   * 禁区策略。`block` 路径硬阻断推送（如同
   * `security.forbiddenPaths`）；`needs-approval` / `high-conflict` 路径会被
   * 合入并呈现但不阻断。
   */
  forbidden: ForbiddenRule[];
  /** 所有权 / 专精路由规则。 */
  ownership: OwnershipRule[];
  /** 当任务触及的独立领域数超过该值时升级。 */
  crossDomainThreshold: number;
}

/** 标题的 kebab-case ASCII slug（稳定、git-ref 安全）。 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** 从最具体的 touch 路径启发式推导 PR 范围（如 `server/db/` → `db`）。 */
export function deriveScope(touches: readonly string[] | undefined): string {
  if (touches === undefined || touches.length === 0) return 'core';
  let best = '';
  for (const touch of touches) {
    const segments = touch.split('/').filter(Boolean);
    const candidate = segments[segments.length - 1] ?? '';
    if (candidate.length > best.length) best = candidate;
  }
  return best === '' ? 'core' : best;
}

/** 根据模板与标题渲染分支名。 */
export function renderBranchName(template: string, id: string, title: string): string {
  return template.replace(/\{id\}/g, id).replace(/\{slug\}/g, slugify(title));
}

/** 根据模板渲染 PR 标题。 */
export function renderPrTitle(template: string, id: string, title: string, touches: readonly string[] | undefined): string {
  return template
    .replace(/\{id\}/g, id)
    .replace(/\{title\}/g, title)
    .replace(/\{scope\}/g, deriveScope(touches));
}

/** 根据模板渲染 PR 正文。 */
export function renderPrBody(
  template: string,
  id: string,
  title: string,
  touches: readonly string[] | undefined,
  assignment: string,
): string {
  return template
    .replace(/\{id\}/g, id)
    .replace(/\{title\}/g, title)
    .replace(/\{touches\}/g, (touches ?? []).join(', ') || '(none)')
    .replace(/\{scope\}/g, deriveScope(touches))
    .replace(/\{assignment\}/g, assignment);
}

/** 默认画像 —— 逐字复刻插件的原始行为。 */
export function defaultProfile(fallbackCommands: readonly string[] = []): ProjectProfile {
  return {
    branchTemplate: 'task/{id}',
    prTitleTemplate: '[{id}] {title}',
    prBodyTemplate: '关联任务单: `.tasks/{id}.md`\n\n## 验收标准\n- {title}\n\nassignee: {assignment}',
    mergeStrategy: 'no-ff',
    gates: fallbackCommands.map((command) => ({ command })),
    forbidden: [],
    ownership: [],
    crossDomainThreshold: 3,
  };
}

/** AgentDeploy（ai-yunke）项目画像。 */
export function agentdeployProfile(fallbackCommands: readonly string[] = []): ProjectProfile {
  const base = defaultProfile(fallbackCommands);
  return {
    ...base,
    branchTemplate: 'agent/{id}-{slug}',
    prTitleTemplate: 'feat({scope}): [{id}] {title}',
    prBodyTemplate: [
      '关联任务单: `.tasks/{id}.md`',
      '',
      '## 验收标准',
      '- {title}',
      '',
      '## 触及目录（须与 touches 一致）',
      '{touches}',
      '',
      '## 影响面',
      'assignee: {assignment}',
    ].join('\n'),
    mergeStrategy: 'squash',
    gates: [
      { command: 'pnpm run typecheck' },
      { command: 'pnpm run lint' },
      { command: 'pnpm run test' },
      { command: 'pnpm run db:check-parity', when: ['server/db/'] },
      { command: 'pnpm run test:contracts' },
      // 重门限流到触及源码的任务：docs/.tasks-only 的任务本地跳过完整的 Nuxt
      // build/e2e（远端 CI 仍是正确性权威，由 requireCiGreen 把关）。
      { command: 'pnpm run build', when: ['server/', 'app/', 'shared/', 'packages/', 'modules/', 'nuxt.config.ts'] },
      { command: 'pnpm run test:e2e', when: ['server/', 'app/', 'shared/', 'packages/', 'modules/', 'e2e/', 'nuxt.config.ts'] },
      { command: 'pnpm audit --audit-level=high', role: 'ci' },
      { command: 'pnpm run validate:docs', when: ['.tasks/', 'docs/'] },
    ],
    forbidden: [
      { path: '.github/', mode: 'block' },
      { path: 'AGENTS.md', mode: 'block' },
      { path: 'LICENSE', mode: 'block' },
      { path: 'server/db/schema/', mode: 'high-conflict' },
    ],
    ownership: [
      {
        glob: 'server/plugins/database/**',
        role: '@agent-database',
        rules: [
          '用户值一律参数化绑定，禁止字符串拼接 SQL',
          '标识符(表/列/索引)走白名单 ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$，否则抛 DB_UNSAFE_OP',
          '项目上下文在连接层绑定，跨项目访问物理不可达',
          '用户 SQL 禁多语句、禁系统表、禁 ATTACH/pg_catalog；DDL 需二次确认并写审计',
          '提交前跑 pnpm run db:check-parity（涉及 server/db/ 时）',
        ],
      },
      {
        glob: 'server/plugins/mcp/**',
        role: '@agent-mcp',
        rules: ['Tool schema 变更必须在 contracts/ 登记并跑 pnpm run test:contracts'],
      },
    ],
    crossDomainThreshold: 3,
  };
}

/** 经由 Config 提供的部分画像（命名预设或内联覆盖）。 */
export interface ProjectProfileInput {
  /** `default` | `agentdeploy`；空串表示 `default` 预设。 */
  preset?: string | undefined;
  branchTemplate?: string | undefined;
  prTitleTemplate?: string | undefined;
  prBodyTemplate?: string | undefined;
  /** `no-ff` | `squash` | `merge`；空串表示"用预设"。 */
  mergeStrategy?: string | undefined;
  gates?: GateDef[] | undefined;
  forbidden?: ForbiddenRule[] | undefined;
  ownership?: OwnershipRule[] | undefined;
  crossDomainThreshold?: number | undefined;
}

const MERGE_STRATEGIES: readonly MergeStrategy[] = ['no-ff', 'squash', 'merge'];

/** 取一个覆盖字符串，为空/缺失时回落到预设。 */
function pickText(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value;
}

/** 取一个覆盖合并策略，并针对已知集合校验。 */
function pickMergeStrategy(value: string | undefined, fallback: MergeStrategy): MergeStrategy {
  return value !== undefined && value !== '' && MERGE_STRATEGIES.includes(value as MergeStrategy)
    ? (value as MergeStrategy)
    : fallback;
}

/** 判断仓库相对路径是否命中某条禁区规则的路径前缀。 */
function pathMatchesRule(path: string, rulePath: string): boolean {
  const normalized = rulePath.endsWith('/') ? rulePath : `${rulePath}/`;
  return path.startsWith(normalized) || path === rulePath.replace(/\/$/, '');
}

/** 把路径 glob（`**`、`*`、`?`）编译成 RegExp；结尾 `/` = 子树。 */
function globToRegex(glob: string): RegExp {
  let pattern = glob;
  if (pattern.endsWith('/')) pattern = `${pattern}**`;
  let out = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index] ?? '';
    if (ch === '*') {
      if (pattern[index + 1] === '*') {
        out += '.*';
        index += 1;
      } else {
        out += '[^/]*';
      }
    } else if ('\\^${}()[]|.+?'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/** 仓库相对路径是否命中所有权 glob。 */
export function globMatchesRule(path: string, glob: string): boolean {
  return globToRegex(glob).test(path);
}

/** glob 命中了任务至少一条 touches 的所有权规则。 */
export function matchedOwnershipRules(touches: readonly string[], ownership: readonly OwnershipRule[]): OwnershipRule[] {
  return ownership.filter((rule) => touches.some((touch) => globMatchesRule(touch, rule.glob)));
}

/** 最具体（最长 glob）匹配的 owner 角色，无匹配时返回 null。 */
export function ownerRoleForTouches(touches: readonly string[], ownership: readonly OwnershipRule[]): string | null {
  const matched = matchedOwnershipRules(touches, ownership);
  if (matched.length === 0) return null;
  let best = matched[0] as OwnershipRule;
  for (const rule of matched) {
    if (rule.glob.length > best.glob.length) best = rule;
  }
  return best.role;
}

/** 把匹配到的域所有者/硬规则追加到任务描述里。 */
export function enrichDescriptionWithOwnership(
  description: string,
  touches: readonly string[],
  ownership: readonly OwnershipRule[],
): string {
  const matched = matchedOwnershipRules(touches, ownership);
  if (matched.length === 0) return description;
  const lines = ['', '', '## 域所有权 / 硬规则', ''];
  for (const rule of matched) {
    lines.push(`- 域 \`${rule.glob}\` → owner \`${rule.role}\``);
    for (const item of rule.rules ?? []) lines.push(`  - ${item}`);
  }
  return `${description}${lines.join('\n')}`;
}

/**
 * 按画像的禁区策略对变更文件分类。返回硬阻断推送的路径
 *（`mode: 'block'`）与仅需批准 / 专用 PR 的路径（`needs-approval` / `high-conflict`）。
 */
export function classifyForbiddenFiles(files: readonly string[], rules: readonly ForbiddenRule[]): {
  blocks: string[];
  approvals: string[];
} {
  const blocks: string[] = [];
  const approvals: string[] = [];
  for (const file of files) {
    for (const rule of rules) {
      if (!pathMatchesRule(file, rule.path)) continue;
      if (rule.mode === 'block') {
        if (!blocks.includes(file)) blocks.push(file);
      } else if (!approvals.includes(file)) {
        approvals.push(file);
      }
    }
  }
  return { blocks, approvals };
}

/**
 * 构造生效的禁区规则：画像自身的规则，加上被强制为 `block` 模式的遗留
 * `security.forbiddenPaths`（它们属于 human-only 区）。重复路径上画像规则优先。
 */
export function effectiveForbiddenRules(
  profile: ProjectProfile,
  securityForbiddenPaths: readonly string[],
): ForbiddenRule[] {
  const rules: ForbiddenRule[] = [...profile.forbidden];
  for (const path of securityForbiddenPaths) {
    if (!rules.some((rule) => rule.path === path)) rules.push({ path, mode: 'block' });
  }
  return rules;
}

/**
 * 派发前的契约自洽检查：任务自己声明的 `touches` 是否踩到它自己声明的
 * `forbidden` 禁区（AgentDeploy 要求二者不相交，此前插件只在 CI 里兜，
 * 派发期完全不看 —— `TaskContract.forbidden` 解析出来后无人消费）。
 *
 * 两个方向都算违规：`touch` 是禁区的前缀（如 touches `app/` 而 forbidden
 * 声明了 `app/server/`）同样意味着这个任务有权改到禁区里面。
 * 返回违规的 touches 条目（空数组 = 干净），让调用方能指名报出是哪一条。
 */
export function forbiddenTouchesViolation(touches: readonly string[], forbidden: readonly string[]): string[] {
  const bad: string[] = [];
  for (const touch of touches) {
    const left = touch.endsWith('/') ? touch : `${touch}/`;
    for (const entry of forbidden) {
      const right = entry.endsWith('/') ? entry : `${entry}/`;
      if (left.startsWith(right) || right.startsWith(left)) {
        if (!bad.includes(touch)) bad.push(touch);
      }
    }
  }
  return bad;
}

/**
 * 把任务 touches 折叠成最小覆盖集（前缀语义与领域锁一致：一条是另一条的前缀
 * 时算同一域）。抽成独立函数是为了让知识回路的「域签名」与跨域阈值统计
 * 共用同一份前缀语义，绝不允许两套实现分叉。
 */
export function distinctDomains(touches: readonly string[]): string[] {
  const normalized = [...new Set(touches.map((touch) => (touch.endsWith('/') ? touch : `${touch}/`)))].filter(
    (touch) => touch !== '/',
  );
  normalized.sort((a, b) => a.length - b.length);
  const domains: string[] = [];
  for (const touch of normalized) {
    if (domains.some((domain) => touch.startsWith(domain) || domain.startsWith(touch))) continue;
    domains.push(touch);
  }
  return domains;
}

/**
 * 统计任务 touches 的独立"领域"数，复用与领域锁一致的前缀语义：两条路径当
 * 一条是另一条的前缀时属于同一领域。这是"该任务跨了多少个不同插件领域"的
 * 通用代理 —— AgentDeploy 在其超过 `crossDomainThreshold`（默认 3）时升级。
 */
export function distinctDomainCount(touches: readonly string[]): number {
  return distinctDomains(touches).length;
}

/**
 * 把 Config 层级的 {@link ProjectProfileInput} 解析成完整 {@link ProjectProfile}。
 * 命名 `preset` 提供默认值；任何内联字段覆盖它们。由于 schemastery 会给每个
 * 字段填默认值，我们把空串 / 空数组 / 0 视为"未覆盖"并回落到预设基座。
 * 空 `gates` 列表会让画像回落到遗留的 `gates.commands`
 *（见 {@link resolveGateDefs}）。
 */
export function resolveProjectProfile(
  input: ProjectProfileInput | undefined,
  fallbackCommands: readonly string[],
): ProjectProfile {
  const base =
    input?.preset === 'agentdeploy' ? agentdeployProfile(fallbackCommands) : defaultProfile(fallbackCommands);
  if (input === undefined) return base;
  return {
    branchTemplate: pickText(input.branchTemplate, base.branchTemplate),
    prTitleTemplate: pickText(input.prTitleTemplate, base.prTitleTemplate),
    prBodyTemplate: pickText(input.prBodyTemplate, base.prBodyTemplate),
    mergeStrategy: pickMergeStrategy(input.mergeStrategy, base.mergeStrategy),
    gates: input.gates !== undefined && input.gates.length > 0 ? input.gates : base.gates,
    forbidden: input.forbidden !== undefined && input.forbidden.length > 0 ? input.forbidden : base.forbidden,
    ownership: input.ownership !== undefined && input.ownership.length > 0 ? input.ownership : base.ownership,
    crossDomainThreshold:
      input.crossDomainThreshold !== undefined && input.crossDomainThreshold > 0
        ? input.crossDomainThreshold
        : base.crossDomainThreshold,
  };
}

/**
 * 解析一个画像的生效门定义。没有门的画像回落到遗留 `gates.commands`
 * 列表（每条都是无条件门）。
 */
export function resolveGateDefs(profile: ProjectProfile, fallbackCommands: readonly string[]): GateDef[] {
  if (profile.gates.length > 0) return profile.gates;
  return fallbackCommands.map((command) => ({ command }));
}

/**
 * 选出真实会对给定任务生效的门命令，尊重 `when`（按 touches 条件触发）与
 * `role: 'ci'`（绝不在本地运行）。返回本地要执行的命令列表，外加被刻意
 * 跳过的 CI-only 命令，让调用方可以把它们呈现出来。
 */
export function selectGateCommands(
  profile: ProjectProfile,
  touches: readonly string[] | undefined,
  fallbackCommands: readonly string[],
): { commands: string[]; skippedCi: string[] } {
  const defs = resolveGateDefs(profile, fallbackCommands);
  const commands: string[] = [];
  const skippedCi: string[] = [];
  for (const def of defs) {
    if (def.role === 'ci') {
      skippedCi.push(def.command);
      continue;
    }
    if (def.when !== undefined && def.when.length > 0) {
      if (touches === undefined || !touchesOverlap(def.when, touches)) continue;
    }
    commands.push(def.command);
  }
  return { commands, skippedCi };
}
