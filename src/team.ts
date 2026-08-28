/**
 * Task-contract integration (spec §4.4).
 *
 * The single source of truth for tasks lives in the target repository at
 * `.tasks/*.md`: YAML frontmatter (`id` / `status` / `owner` / `depends_on` /
 * `touches`) plus a Markdown body with Gherkin acceptance criteria. The
 * plugin reads contracts to validate assignments and rewrites frontmatter +
 * regenerates `.tasks/_board.md` on every state change.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { TaskStatus } from './view.js';
import { TASK_STATUSES } from './view.js';

export interface TaskContract {
  id: string;
  title: string;
  status: TaskStatus;
  owner: string | null;
  dependsOn: string[];
  touches: string[];
  /** Absolute path of the contract file. */
  path: string;
  /** Markdown body (acceptance criteria etc.), frontmatter excluded. */
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Parse one `.tasks/*.md` file. Throws on malformed frontmatter. */
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
    path,
    body: match[2] ?? '',
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** Load every task contract in <repoPath>/.tasks (files ending in .md, _board excluded). */
export async function loadTaskContracts(repoPath: string): Promise<TaskContract[]> {
  const dir = join(repoPath, '.tasks');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const contracts: TaskContract[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md') || entry.startsWith('_')) continue;
    const path = join(dir, entry);
    const content = await readFile(path, 'utf8');
    contracts.push(parseTaskContract(path, content));
  }
  return contracts.toSorted((a, b) => a.id.localeCompare(b.id));
}

interface FrontmatterPatch {
  status?: TaskStatus;
  owner?: string | null;
}

/** Rewrite the frontmatter of one contract file, preserving the body. */
export async function patchTaskContract(path: string, patch: FrontmatterPatch): Promise<void> {
  const content = await readFile(path, 'utf8');
  const match = FRONTMATTER_RE.exec(content);
  if (match === null) throw new Error(`task contract ${path} has no YAML frontmatter`);
  const raw = (parseYaml(match[1] ?? '') ?? {}) as Record<string, unknown>;
  if (patch.status !== undefined) raw['status'] = patch.status;
  if (patch.owner !== undefined) {
    if (patch.owner === null) delete raw['owner'];
    else raw['owner'] = patch.owner;
  }
  const body = match[2] ?? '';
  await writeFile(path, `---\n${stringifyYaml(raw).trimEnd()}\n---\n${body}`, 'utf8');
}

/** Append a human/agent note (escalation messages, progress) to a contract body. */
export async function appendTaskNote(path: string, note: string): Promise<void> {
  const content = await readFile(path, 'utf8').catch(() => '');
  await writeFile(path, `${content.trimEnd()}\n${note}`, 'utf8');
}

/**
 * Regenerate `.tasks/_board.md` from the current contracts (status table +
 * blocked list). Never hand-edited; called after every status change.
 */
export async function regenerateBoard(repoPath: string, contracts: TaskContract[]): Promise<void> {
  const lines: string[] = [
    '# 任务看板（自动生成，勿手改）',
    '',
    `> regenerated at ${new Date().toISOString()}`,
    '',
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
  lines.push('');
  await writeFile(join(repoPath, '.tasks', '_board.md'), lines.join('\n'), 'utf8');
}

/**
 * Domain-lock check (spec §4.3.3): the touches directories of in-progress
 * tasks are locked; a candidate overlapping any of them must not dispatch.
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
