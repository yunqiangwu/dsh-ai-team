/**
 * Project-profile adapter — the mechanism that lets one engine drive
 * repositories with *different* collaboration conventions.
 *
 * AgentDeploy (ai-yunke) is a concrete example of a target whose rules are
 * "same shape, different grain" from the plugin's historical defaults: branch
 * `agent/<id>-<slug>` (not `task/<id>`), PR title `feat(scope): [id] desc`
 * (not `[id] title`), **squash** merge (not `--no-ff`), and quality gates
 * that are *conditional on the task's touches* and partly CI-only. Rather
 * than hard-code these, we encode them as a {@link ProjectProfile} and let
 * the service read its conventions from here.
 *
 * The default profile reproduces the plugin's original behavior exactly, so
 * existing deployments and tests are unaffected; project presets override
 * only the fields that diverge.
 *
 * This module is host-only logic and must not import node builtins (it is not
 * inlined into the client bundle, but keeping it pure keeps it testable).
 */
import { touchesOverlap } from './team.js';

/** Merge strategy applied when a reviewed task is merged into the base. */
export type MergeStrategy = 'no-ff' | 'squash' | 'merge';

/**
 * One quality-gate command, optionally conditional on the task's touches and
 * optionally CI-only.
 */
export interface GateDef {
  command: string;
  /**
   * Prefixes of the task's `touches`. When present, the gate runs only if the
   * task touches at least one matching path. Example: `when: ['server/db/']`
   * makes `db:check-parity` run only for tasks that touch the DB layer.
   */
  when?: string[] | undefined;
  /**
   * `local` → run in the member worktree (default).
   * `ci` → enforced only by the repository's remote CI, never run locally.
   * Used for gates that fail on a local machine for environmental reasons
   * (e.g. `pnpm audit` under a private registry with no audit endpoint) but
   * are still required in CI — local approve is not blocked by a `ci` gate,
   * and the remote CI gate (`requireCiGreen`) owns the enforcement.
   */
  role?: 'local' | 'ci' | undefined;
}

/** How a forbidden path is treated when a task branch touches it. */
export type ForbiddenMode = 'block' | 'needs-approval' | 'high-conflict';

export interface ForbiddenRule {
  path: string;
  mode: ForbiddenMode;
}

/** Path→domain-owner mapping used for specialization routing (extensible). */
export interface OwnershipRule {
  glob: string;
  /** Owner label the project expects (e.g. `@agent-database`), or a role hint. */
  role: string;
  /** Domain-specific hard rules to inject when a task falls in this glob. */
  rules?: string[] | undefined;
}

export interface ProjectProfile {
  /**
   * Branch-name template. `{id}` → task/contract id, `{slug}` → kebab-case
   * slug of the title. Default `task/{id}`.
   */
  branchTemplate: string;
  /** PR-title template. `{id}`, `{title}`, `{scope}`. */
  prTitleTemplate: string;
  /** PR-body template (may be multiline). `{id}`, `{title}`, `{touches}`, `{scope}`, `{assignment}`. */
  prBodyTemplate: string;
  mergeStrategy: MergeStrategy;
  /**
   * Ordered quality gates. Empty → fall back to the legacy
   * `options.gates.commands` list (each as an unconditional `local` gate).
   */
  gates: GateDef[];
  /**
   * Forbidden-zone policy. `block` paths hard-block a push (like
   * `security.forbiddenPaths`); `needs-approval` / `high-conflict` paths are
   * merged in and surfaced but do not block.
   */
  forbidden: ForbiddenRule[];
  /** Ownership / specialization routing rules. */
  ownership: OwnershipRule[];
  /** Escalate when a task touches more than this many distinct domains. */
  crossDomainThreshold: number;
}

/** Kebab-case ASCII slug of a title (stable, git-ref safe). */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Heuristic PR scope from the most specific touch path (e.g. `server/db/` → `db`). */
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

/** Render a branch name from a template and a title. */
export function renderBranchName(template: string, id: string, title: string): string {
  return template.replace(/\{id\}/g, id).replace(/\{slug\}/g, slugify(title));
}

/** Render a PR title from a template. */
export function renderPrTitle(template: string, id: string, title: string, touches: readonly string[] | undefined): string {
  return template
    .replace(/\{id\}/g, id)
    .replace(/\{title\}/g, title)
    .replace(/\{scope\}/g, deriveScope(touches));
}

/** Render a PR body from a template. */
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

/** The default profile — reproduces the plugin's historical behavior exactly. */
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

/** The AgentDeploy (ai-yunke) project profile. */
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
      // Heavy gates are throttled to tasks that touch source: a docs/.tasks-only
      // task skips the full Nuxt build/e2e locally (remote CI is still the
      // correctness authority via requireCiGreen).
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

/** Partial profile as supplied through Config (named preset or inline overrides). */
export interface ProjectProfileInput {
  /** `default` | `agentdeploy`; empty string means the `default` preset. */
  preset?: string | undefined;
  branchTemplate?: string | undefined;
  prTitleTemplate?: string | undefined;
  prBodyTemplate?: string | undefined;
  /** `no-ff` | `squash` | `merge`; empty string means "use the preset". */
  mergeStrategy?: string | undefined;
  gates?: GateDef[] | undefined;
  forbidden?: ForbiddenRule[] | undefined;
  ownership?: OwnershipRule[] | undefined;
  crossDomainThreshold?: number | undefined;
}

const MERGE_STRATEGIES: readonly MergeStrategy[] = ['no-ff', 'squash', 'merge'];

/** Pick an override string, or fall back to the preset when empty/absent. */
function pickText(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value;
}

/** Pick an override merge strategy, validating it against the known set. */
function pickMergeStrategy(value: string | undefined, fallback: MergeStrategy): MergeStrategy {
  return value !== undefined && value !== '' && MERGE_STRATEGIES.includes(value as MergeStrategy)
    ? (value as MergeStrategy)
    : fallback;
}

/** Match a repo-relative path against a forbidden rule's path prefix. */
function pathMatchesRule(path: string, rulePath: string): boolean {
  const normalized = rulePath.endsWith('/') ? rulePath : `${rulePath}/`;
  return path.startsWith(normalized) || path === rulePath.replace(/\/$/, '');
}

/** Compile a path glob (`**`, `*`, `?`) into a RegExp; a trailing `/` = subtree. */
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

/** True when a repo-relative path matches an ownership glob. */
export function globMatchesRule(path: string, glob: string): boolean {
  return globToRegex(glob).test(path);
}

/** Ownership rules whose glob matches at least one of the task's touches. */
export function matchedOwnershipRules(touches: readonly string[], ownership: readonly OwnershipRule[]): OwnershipRule[] {
  return ownership.filter((rule) => touches.some((touch) => globMatchesRule(touch, rule.glob)));
}

/** The most specific (longest glob) matching owner role, or null when none. */
export function ownerRoleForTouches(touches: readonly string[], ownership: readonly OwnershipRule[]): string | null {
  const matched = matchedOwnershipRules(touches, ownership);
  if (matched.length === 0) return null;
  let best = matched[0] as OwnershipRule;
  for (const rule of matched) {
    if (rule.glob.length > best.glob.length) best = rule;
  }
  return best.role;
}

/** Append the matched domain owners/hard rules to a task description. */
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
 * Classify changed files against the profile's forbidden-zone policy.
 * Returns the paths that hard-block a push (`mode: 'block'`) and those that
 * merely need approval / a dedicated PR (`needs-approval` / `high-conflict`).
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
 * Build the effective forbidden-zone rules: the profile's own rules plus the
 * legacy `security.forbiddenPaths` forced to `block` mode (they are the
 * human-only zone). Profile rules win on duplicate paths.
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
 * Count distinct "domains" among a task's touches, using the same prefix
 * semantics as the domain lock: two paths belong to the same domain when one
 * is a prefix of the other. This is the generic proxy for "how many different
 * plugin domains does this task span" — AgentDeploy escalates when it exceeds
 * `crossDomainThreshold` (default 3).
 */
export function distinctDomainCount(touches: readonly string[]): number {
  const normalized = [...new Set(touches.map((touch) => (touch.endsWith('/') ? touch : `${touch}/`)))].filter(
    (touch) => touch !== '/',
  );
  normalized.sort((a, b) => a.length - b.length);
  const domains: string[] = [];
  for (const touch of normalized) {
    if (domains.some((domain) => touch.startsWith(domain) || domain.startsWith(touch))) continue;
    domains.push(touch);
  }
  return domains.length;
}

/**
 * Resolve a Config-level {@link ProjectProfileInput} into a full
 * {@link ProjectProfile}. A named `preset` seeds the defaults; any inline
 * fields override them. Because schemastery default-fills every field, we
 * treat empty-string / empty-array / zero as "not overridden" and fall back
 * to the preset base. An empty `gates` list makes the profile fall back to
 * the legacy `gates.commands` (see {@link resolveGateDefs}).
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
 * Resolve the effective gate definitions for a profile. A profile with no
 * gates falls back to the legacy `gates.commands` list (each unconditional).
 */
export function resolveGateDefs(profile: ProjectProfile, fallbackCommands: readonly string[]): GateDef[] {
  if (profile.gates.length > 0) return profile.gates;
  return fallbackCommands.map((command) => ({ command }));
}

/**
 * Select the gate commands that actually run for a given task, honoring
 * `when` (touches-conditional) and `role: 'ci'` (never run locally).
 * Returns the commands to execute locally plus a list of CI-only commands
 * that were deliberately skipped so the caller can surface them.
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
