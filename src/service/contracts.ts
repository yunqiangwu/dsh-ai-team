/**
 * 契约创建的写前校验（docs/design-interaction.md §4.4）。
 *
 * 为什么要单独一处：今天 `assignTask` 只**校验**契约存在，创建路径完全缺失，
 * 组长只能靠通用 fs 手搓 `.tasks/<id>.md`，再由收养链路事后接手 —— 而收养链路
 * 咬过一次人（frontmatter 写坏的契约曾把整块看板清空）。既然现在给了它一个正式
 * 入口，这个入口就必须**写前**把话说清楚：不合法直接抛错并指名道姓，绝不留半个
 * 文件在盘上等下一个 tick 出丑。
 *
 * 这里只有纯函数（输入 → 错误清单 / 文件文本），落盘与提交在 service.ts。
 */
import { forbiddenTouchesViolation } from '../profile.js';
import type { TaskContract } from '../team.js';

/** 契约 id 约定：`<域>-<序号>`（与目标仓库 `.tasks/README.md` 一致）。 */
const CONTRACT_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;

/** 建契约时唯一的合法初始状态：其余状态都由运行流程负责写入。 */
const CREATABLE_STATUSES: readonly string[] = ['pending'];

export interface ContractDraft {
  id: string;
  title: string;
  status?: string;
  owner?: string;
  dependsOn?: string[];
  touches?: string[];
  forbidden?: string[];
  /** Markdown 正文（Gherkin 验收标准）。 */
  body?: string;
}

export interface ContractValidationContext {
  /** 看板上已有的契约 id（磁盘真相）。 */
  knownIds: Iterable<string>;
  /** 同批次里其它契约的 id：允许前置在同一批内。 */
  batchIds: Iterable<string>;
  /** 全局禁区（`security.forbiddenPaths`）。 */
  globalForbidden: readonly string[];
}

const has = (set: Set<string>, value: string): boolean => set.has(value);

/**
 * 依赖图判环（DFS + 三色标记）。同一批契约允许互相引用，所以图是
 * 「磁盘已有 ∪ 本批新建」，而不是只看新那份。
 */
function findDependencyCycle(edges: Map<string, string[]>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const walk = (node: string): string[] | null => {
    const seen = state.get(node);
    if (seen === 'done') return null;
    if (seen === 'visiting') {
      const from = stack.indexOf(node);
      return [...stack.slice(from === -1 ? 0 : from), node];
    }
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };
  for (const node of edges.keys()) {
    const cycle = walk(node);
    if (cycle !== null) return cycle;
  }
  return null;
}

/**
 * 校验一张待建契约。返回错误清单（空数组即合法）—— 一次报全，别让人和模型
 * 一条条试：每试一条都要重跑一次工具调用。
 */
export function validateContractDraft(draft: ContractDraft, context: ContractValidationContext): string[] {
  const errors: string[] = [];
  const known = new Set(context.knownIds);
  const batch = new Set(context.batchIds);
  const id = draft.id.trim();
  if (id === '') {
    errors.push('id is required');
  } else if (!CONTRACT_ID_RE.test(id)) {
    errors.push(`id "${id}" must match <DOMAIN>-<number> (e.g. "AUTH-3")`);
  } else if (has(known, id)) {
    errors.push(`contract "${id}" already exists on disk; edit it instead of re-creating`);
  }
  if (draft.title === undefined || draft.title.trim() === '') errors.push('title is required');
  const owner = draft.owner?.trim() ?? '';
  if (owner === '') errors.push('owner is required (the member or role that will do the work)');
  const status = draft.status ?? 'pending';
  if (!CREATABLE_STATUSES.includes(status)) {
    errors.push(`status "${status}" cannot be created; only ${CREATABLE_STATUSES.join(' / ')} — the board owns the rest`);
  }
  const touches = draft.touches ?? [];
  if (touches.length === 0) {
    errors.push('touches is required and must list at least one path (the domain lock depends on it)');
  }
  const forbidden = draft.forbidden ?? [];
  for (const hit of forbiddenTouchesViolation(touches, forbidden)) {
    errors.push(`touches "${hit}" is forbidden by this contract itself; narrow the touches or split that change into its own contract`);
  }
  for (const hit of forbiddenTouchesViolation(touches, [...context.globalForbidden])) {
    errors.push(`touches "${hit}" hits security.forbiddenPaths; that boundary is config, not something a contract may opt out of`);
  }
  const dependsOn = draft.dependsOn ?? [];
  for (const dep of dependsOn) {
    if (dep === id) errors.push(`depends_on includes itself ("${id}")`);
    else if (!has(known, dep) && !has(batch, dep)) {
      errors.push(`depends_on "${dep}" does not exist on the board and is not created in this batch`);
    }
  }
  const body = draft.body ?? '';
  if (body.trim() === '') errors.push('body is required: write the Gherkin acceptance criteria, not a placeholder');
  return errors;
}

/** 校验整批契约的依赖图（前置可以指向同批的兄弟）。 */
export function validateContractBatch(drafts: ContractDraft[], existing: TaskContract[]): string[] {
  const edges = new Map<string, string[]>();
  for (const contract of existing) edges.set(contract.id, [...contract.dependsOn]);
  for (const draft of drafts) edges.set(draft.id.trim(), [...(draft.dependsOn ?? [])]);
  const cycle = findDependencyCycle(edges);
  return cycle === null ? [] : [`dependency cycle: ${cycle.join(' → ')}`];
}

// 空列表要渲染成 `key: []`（冒号后那个空格不能省：`key:[]` 不是合法 YAML，
// parseTaskContract 会把整个文件丢进 rejected，契约就永远收养不进来）。
const yamlList = (values: readonly string[]): string =>
  values.length === 0 ? ' []' : `\n${values.map((value) => `  - ${value}`).join('\n')}`;

/** 渲染成 parseTaskContract 读得懂的文件（frontmatter 顺序与既有契约一致）。 */
export function renderContractFile(draft: ContractDraft): string {
  const lines = [
    '---',
    `id: ${draft.id.trim()}`,
    `title: ${draft.title.trim()}`,
    'status: pending',
    `owner: ${(draft.owner ?? '').trim()}`,
    `depends_on: ${draft.dependsOn?.length ? `[${draft.dependsOn.join(', ')}]` : '[]'}`,
    `touches:${yamlList(draft.touches ?? [])}`,
    `forbidden:${yamlList(draft.forbidden ?? [])}`,
    '---',
    '',
    `# ${draft.id.trim()} ${draft.title.trim()}`,
    '',
    (draft.body ?? '').trim(),
    '',
  ];
  return lines.join('\n');
}
