/**
 * 任务契约集成（spec §4.4）。
 *
 * 任务的唯一真相源位于目标仓库的 `.tasks/*.md`：YAML frontmatter
 * （`id` / `status` / `owner` / `depends_on` / `touches`）加上带 Gherkin
 * 验收标准的 Markdown 正文。插件读取契约来校验派发，并在每次状态变更时重写
 * frontmatter、重新生成 `.tasks/_board.md`。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { TaskStatus } from './view.js';
import { TASK_STATUSES } from './view.js';

export interface TaskContract {
  id: string;
  title: string;
  status: TaskStatus;
  owner: string | null;
  dependsOn: string[];
  touches: string[];
  /** 任务声明的受限路径（按任务划分的禁区）。 */
  forbidden: string[];
  /**
   * 派发排序权重（M3 §6.2「调 priority」）：数值越大越先派。缺省 0，
   * 且只在「依赖条件相同」的任务之间生效 —— 前置没满足的任务永远排在后面。
   */
  priority: number;
  /** 契约文件的绝对路径。 */
  path: string;
  /** Markdown 正文（验收标准等），不含 frontmatter。 */
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** 解析一个 `.tasks/*.md` 文件。frontmatter 格式错误时抛错。 */
export function parseTaskContract(path: string, content: string): TaskContract {
  const match = FRONTMATTER_RE.exec(content);
  if (match === null) {
    throw new Error(`task contract ${path} has no YAML frontmatter (expected --- ... ---)`);
  }
  const raw = parseYaml(match[1] ?? '') as Record<string, unknown>;
  const id = raw['id'];
  if (typeof id !== 'string' || id === '') {
    throw new Error(`task contract ${path} is missing a string "id" in frontmatter`);
  }
  const statusRaw = raw['status'];
  const status: TaskStatus = (TASK_STATUSES as readonly string[]).includes(statusRaw as string)
    ? (statusRaw as TaskStatus)
    : 'pending';
  return {
    id,
    title: typeof raw['title'] === 'string' ? raw['title'] : id,
    status,
    owner: typeof raw['owner'] === 'string' && raw['owner'] !== '' ? raw['owner'] : null,
    dependsOn: toStringArray(raw['depends_on']),
    touches: toStringArray(raw['touches']),
    forbidden: toStringArray(raw['forbidden']),
    priority: typeof raw['priority'] === 'number' && Number.isFinite(raw['priority']) ? raw['priority'] : 0,
    path,
    body: match[2] ?? '',
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** 一个被跳过而没有收养的契约文件：路径 + 失败原因。 */
export interface RejectedContract {
  path: string;
  error: string;
}

export interface ContractLoadResult {
  contracts: TaskContract[];
  /**
   * 解析失败、被逐个跳过的文件。**一个坏文件只该弄坏它自己**：早先这里让
   * `parseTaskContract` 直接抛穿，调用方一律 `.catch(() => [])`，于是
   * `.tasks/` 里少一个 frontmatter 就把整块看板清空 —— 全部任务从盘上"消失"，
   * 而日志里什么都看不出来。
   */
  rejected: RejectedContract[];
}

/**
 * 加载 `<repoPath>/.tasks` 里的每个任务契约（`.md`，排除 `_` 前缀）。
 * 永不调用方抛错：目录不存在是正常的首次运行，逐文件失败则记进 `rejected`。
 */
export async function loadTaskContracts(repoPath: string): Promise<ContractLoadResult> {
  const dir = join(repoPath, '.tasks');
  const rejected: RejectedContract[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    // 目录不存在 = 这个项目还没开始用契约，静默；其它读取失败必须出声。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { contracts: [], rejected };
    return { contracts: [], rejected: [{ path: dir, error: errorMessageOf(error) }] };
  }
  const contracts: TaskContract[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md') || entry.startsWith('_')) continue;
    const path = join(dir, entry);
    try {
      const content = await readFile(path, 'utf8');
      contracts.push(parseTaskContract(path, content));
    } catch (error) {
      rejected.push({ path, error: errorMessageOf(error) });
    }
  }
  return { contracts: contracts.toSorted((a, b) => a.id.localeCompare(b.id)), rejected };
}

const errorMessageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface FrontmatterPatch {
  status?: TaskStatus;
  owner?: string | null;
  /** 重规划调优先级时同步契约 frontmatter（看板记录与契约文件保持一份事实）。 */
  priority?: number;
}

/**
 * 就地设置（或删除）一个顶层 frontmatter key，**逐字节**保留其它每一行的
 * 顺序与格式。用 YAML 序列化器重新字符串化整个 frontmatter 会重排 key / 重排
 * 块级列表，触发项目严格的 `validate:docs` 检查（例如 AgentDeploy）。
 */
function setFrontmatterKey(frontmatter: string, key: string, value: string | null): string {
  const matcher = new RegExp(`^${key}:.*$`, 'm');
  if (value === null) {
    // 删除该 key 行（owner 被清空），并把产生的空行折叠掉。
    const without = frontmatter.replace(matcher, '');
    return without.replace(/^\n+/, '').trimEnd();
  }
  if (matcher.test(frontmatter)) {
    return frontmatter.replace(matcher, `${key}: ${value}`);
  }
  return `${frontmatter.trimEnd()}\n${key}: ${value}`;
}

/** Rewrite the frontmatter of one contract file, preserving the body and formatting. */
export async function patchTaskContract(path: string, patch: FrontmatterPatch): Promise<void> {
  const content = await readFile(path, 'utf8');
  const match = FRONTMATTER_RE.exec(content);
  if (match === null) throw new Error(`task contract ${path} has no YAML frontmatter`);
  let frontmatter = match[1] ?? '';
  if (patch.status !== undefined) frontmatter = setFrontmatterKey(frontmatter, 'status', patch.status);
  if (patch.owner !== undefined) {
    frontmatter = setFrontmatterKey(frontmatter, 'owner', patch.owner === null ? null : patch.owner);
  }
  if (patch.priority !== undefined) frontmatter = setFrontmatterKey(frontmatter, 'priority', String(patch.priority));
  const body = match[2] ?? '';
  await writeFile(path, `---\n${frontmatter}\n---\n${body}`, 'utf8');
}

/** 在契约正文上追加一条人类/AI 备注（升级消息、进度）。 */
export async function appendTaskNote(path: string, note: string): Promise<void> {
  const content = await readFile(path, 'utf8').catch(() => '');
  await writeFile(path, `${content.trimEnd()}\n${note}`, 'utf8');
}

/**
 * 任务单留言的统一头部：`> [kind] <ISO 时刻> <author>`。以前四处各拼一份
 * （方括号、时间戳格式、作者位置的约定全靠各处对齐），给留言加结构化字段时
 * 只改这一处。`renderTaskNote('human')` 的冒号变体（`[human]:`）是历史格式，
 * 刻意未并入。
 */
export function renderTaskNote(kind: string, at: number, author: string): string {
  return `> [${kind}] ${new Date(at).toISOString()} ${author}`;
}

/**
 * 根据当前契约重新生成 `.tasks/_board.md`（状态表 + 阻塞清单）。
 * 绝不手改；每次状态变更后被调用。
 */
export async function regenerateBoard(repoPath: string, contracts: TaskContract[]): Promise<void> {
  const lines: string[] = [
    '# 任务看板（自动生成，勿手改）',
    '',
    // 刻意不写「regenerated at <时间戳>」：本文件每次状态变更都会重生成并提交，
    // 内嵌时间戳会让内容每次都变，于是纯粹的重新生成也能把 worktree 弄脏、
    // 产出一堆零内容的空提交。变更时间由 git log 记录。
    '| id | title | status | owner | depends_on | touches |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const contract of contracts) {
    lines.push(
      `| ${contract.id} | ${contract.title} | ${contract.status} | ${contract.owner ?? '-'} | ${contract.dependsOn.join(', ') || '-'} | ${contract.touches.join(', ') || '-'} |`,
    );
  }
  const blocked = contracts.filter((contract) => contract.status === 'needs-human');
  lines.push('', '## 阻塞清单', '');
  if (blocked.length === 0) {
    lines.push('- (none)');
  } else {
    for (const contract of blocked) lines.push(`- ${contract.id} ${contract.title} — needs-human`);
  }
  // M3 重规划的废弃分区（§6.1）：契约文件保留不删，看板上也要能一眼看到
  // 哪些工作被放弃了 —— 否则「为什么这个 id 再也不会动」只能去 git log 里考古。
  const cancelled = contracts.filter((contract) => contract.status === 'cancelled');
  lines.push('', '## 已废弃', '');
  if (cancelled.length === 0) {
    lines.push('- (none)');
  } else {
    for (const contract of cancelled) lines.push(`- ${contract.id} ${contract.title} — cancelled`);
  }
  lines.push('');
  await writeFile(join(repoPath, '.tasks', '_board.md'), lines.join('\n'), 'utf8');
}

/**
 * 领域锁检查（spec §4.3.3）：进行中任务的 touches 目录被锁定，
 * 与其中任何目录重叠的候选任务不得派发。
 */
export function touchesOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const left of a) {
    for (const right of b) {
      const l = left.endsWith('/') ? left : `${left}/`;
      const r = right.endsWith('/') ? right : `${right}/`;
      if (l.startsWith(r) || r.startsWith(l)) return true;
    }
  }
  return false;
}
