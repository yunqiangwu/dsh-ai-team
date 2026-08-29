/**
 * 文档生命周期：draft 区判定、frontmatter、`sha256` 比对、章节回写、升格（§4）。
 *
 * 为什么单独一个文件：AI 写文档这件事**没有客观质量门可验证**（这正是本仓库把
 * AGENTS.md 移出禁区时留下的缺口），所以约束只能下移到流程上 —— 只能写 draft 区、
 * 升格必须带人批的记录、批的内容哈希必须与落盘的一致。这里放的就是那套机械规则，
 * service.ts 只做编排。
 *
 * `sha256` 是防「批 A 合 B」的硬门：一次审批只覆盖人当时看到的那一份内容，
 * 眼看的 diff 挡不住事后被悄悄改掉的那一行。
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export const DOC_STATUSES = ['draft', 'pending-approval', 'accepted', 'superseded'] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export interface DocMeta {
  /** 文档生效路径（相对仓库根，用 `/` 分隔）。 */
  path: string;
  status: DocStatus;
  /** 语义版本字符串（`1.0`）；刻意不做 number，避免 `1.10` 被写成 `1.1`。 */
  version: string;
  /** 落盘那一刻的正文哈希。审批时重新比对。 */
  sha256: string;
  approvedBy: string | null;
  approvedAt: number | null;
}

export interface DocFile {
  meta: DocMeta;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** 正文哈希。审批门与 diff 判定都以它为准，所以只有一处实现。 */
export const hashBody = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex');

/**
 * 把用户/模型给的路径收口成「相对仓库根、用 `/` 分隔」的形态。
 * 越界（绝对路径、`..` 跳出仓库）一律抛错 —— 这条比看起来重要：`doc_write` 的参数
 * 是模型填的，`../../../../etc/cron.d/x` 只要过一次就是一次任意文件写。
 */
export function assertRepoRelative(path: string, what = 'path'): string {
  const trimmed = path.trim().replace(/\\/g, '/');
  if (trimmed === '') throw new Error(`${what} is empty`);
  if (trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed)) {
    throw new Error(`${what} "${path}" must be relative to the repository root (absolute paths are refused)`);
  }
  const normalized = trimmed.replace(/^\.\//, '');
  if (normalized.split('/').includes('..')) {
    throw new Error(`${what} "${path}" escapes the repository (.. segments are refused)`);
  }
  return normalized;
}

/** 目标是否落在 draft 区内。按**路径**判定，不看文件属性（§4.1）。 */
export function isDraftPath(relativePath: string, draftDir: string): boolean {
  const dir = draftDir.replace(/\/+$/, '');
  return relativePath === dir || relativePath.startsWith(`${dir}/`);
}

/** 落盘路径的绝对化 + 二次越界检查（拼完再验一次，防 draftDir 自身配成绝对路径）。 */
export function repoFile(repoPath: string, relativePath: string): string {
  const absolute = resolve(repoPath, relativePath);
  const root = resolve(repoPath);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error(`path "${relativePath}" resolves outside the repository (${root})`);
  }
  return absolute;
}

/** 解析一份文档；没有 frontmatter 也算合法（人手工写的 md 常常就是裸正文）。 */
export function parseDoc(path: string, content: string): DocFile {
  const match = FRONTMATTER_RE.exec(content);
  const body = match?.[2] ?? content;
  const meta: DocMeta = {
    path,
    status: 'draft',
    version: '1.0',
    sha256: hashBody(body),
    approvedBy: null,
    approvedAt: null,
  };
  if (match === null) return { meta, body };
  const raw = match[1] ?? '';
  const scalar = (key: string): string | null => {
    const found = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(raw)?.[1]?.trim();
    if (found === undefined || found === '' || found === 'null' || found === '~') return null;
    return found.replace(/^["'](.*)["']$/, '$1');
  };
  const status = scalar('status');
  if (status !== null && (DOC_STATUSES as readonly string[]).includes(status)) meta.status = status as DocStatus;
  meta.version = scalar('version') ?? meta.version;
  meta.sha256 = scalar('sha256') ?? meta.sha256;
  meta.approvedBy = scalar('approvedBy');
  const approvedAt = scalar('approvedAt');
  meta.approvedAt = approvedAt === null ? null : Number(approvedAt);
  return { meta, body };
}

export function renderDoc(meta: DocMeta, body: string): string {
  const lines = [
    '---',
    `path: ${meta.path}`,
    `status: ${meta.status}`,
    `version: ${meta.version}`,
    `sha256: ${meta.sha256}`,
    `approvedBy: ${meta.approvedBy ?? 'null'}`,
    `approvedAt: ${meta.approvedAt ?? 'null'}`,
    '---',
  ];
  return `${lines.join('\n')}\n${body}`;
}

export async function readDoc(absolutePath: string, relativePath: string): Promise<DocFile | null> {
  let content: string;
  try {
    content = await readFile(absolutePath, 'utf8');
  } catch {
    return null;
  }
  return parseDoc(relativePath, content);
}

export async function writeDoc(absolutePath: string, meta: DocMeta, body: string): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, renderDoc(meta, body), 'utf8');
}

export interface DocEntry {
  /** 相对仓库根的路径（`/` 分隔），审批与提交都用它。 */
  path: string;
  absolutePath: string;
  doc: DocFile;
}

/**
 * 递归列出一个目录下的所有 `.md`。开工包是一份目录树而不是一个文件
 * （§4.3：PRD + tech-stack + dev-guidelines + ADR + 骨架清单），一次审批要能
 * 把它们当一批看到。
 *
 * 顺序刻意稳定（按名字排序）：升格会逐份比对 `sha256`，列表抖动会让审批码与
 * 内容错位。目录不存在返回空表而不是抛错 —— 空仓库没有草稿是正常状态。
 */
export async function listDocs(absoluteDir: string, relativeDir: string): Promise<DocEntry[]> {
  const found: DocEntry[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(dir, entry.name);
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      // `_` 前缀是生成物的仓库约定（见 .tasks/_board.md），不是待批文档。
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('_')) continue;
      const doc = await readDoc(absolute, relative);
      if (doc !== null) found.push({ path: relative, absolutePath: absolute, doc });
    }
  };
  await walk(absoluteDir, relativeDir.replace(/\/+$/, ''));
  return found;
}

/**
 * 把决策行插进指定章节的末尾（§3.4）。
 *
 * 找不到章节**不报错**：回落到文末追加并如实返回 `matched: false`，让调用方在工具
 * 结果里说「章节没匹配上，已追加到文末」。静默丢弃答案才是真事故。
 */
export function insertSectionNotes(body: string, section: string, notes: string[]): { body: string; matched: boolean } {
  if (notes.length === 0) return { body, matched: false };
  const lines = body.split('\n');
  const needle = section.trim();
  let start = -1;
  let level = 0;
  if (needle !== '') {
    for (let index = 0; index < lines.length; index += 1) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(lines[index] ?? '');
      if (heading === null) continue;
      const text = (heading[2] ?? '').trim();
      // 前缀匹配而非相等：章节写法千姿百态（`## 2.3 部署形态` / `### §2.3`）。
      if (text === needle || text.startsWith(needle) || text.includes(needle)) {
        start = index;
        level = (heading[1] ?? '#').length;
        break;
      }
    }
  }
  if (start === -1) {
    return { body: `${body.trimEnd()}\n${notes.join('\n')}`, matched: false };
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = /^(#{1,6})\s+/.exec(lines[index] ?? '');
    if (heading !== null && (heading[1] ?? '#').length <= level) {
      end = index;
      break;
    }
  }
  // 章节末尾 = 下一标题前的最后一个非空行之后。
  let insertAt = end;
  while (insertAt > start + 1 && (lines[insertAt - 1] ?? '').trim() === '') insertAt -= 1;
  const merged = [...lines.slice(0, insertAt), ...notes, ...lines.slice(insertAt)];
  if (merged[merged.length - 1] !== '') merged.push('');
  return { body: merged.join('\n'), matched: true };
}

/** draft → 正式区的默认落点：`docs/drafts/prd.md` → `docs/prd.md`。 */
export function defaultFormalPath(draftPath: string, draftDir: string, formalDir: string): string {
  const dir = draftDir.replace(/\/+$/, '');
  const relative = isDraftPath(draftPath, dir) ? draftPath.slice(dir.length).replace(/^\/+/, '') : draftPath;
  return join(formalDir.replace(/\/+$/, ''), relative).replace(/\\/g, '/');
}

/** 版本号递增：`1.0 → 1.1`，`1.9 → 2.0`。解析不了就退回原值（绝不静默变成 1.0）。 */
export function bumpVersion(version: string): string {
  const match = /^(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) return version;
  const major = Number(match[1]);
  const minor = Number(match[2]) + 1;
  return minor > 9 ? `${major + 1}.0` : `${major}.${minor}`;
}
