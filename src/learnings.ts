/**
 * 知识回路（learnings）的纯逻辑：记录形状、去重键、注入选择与生成物渲染。
 *
 * 设计前提（为什么不是「让 leader 定期维护文档」）：
 *  - 文档是给人看的，agent 每任务的上下文里根本不会去读它 —— 坑要避免重复踩，
 *    落点必须是**任务描述**，不是 `docs/`；
 *  - 想写文档的天然位置（AGENTS.md / docs/）恰好落在 `forbidden: block` 与
 *    `validate:docs` 的交叉火力区，而删除型操作没有任何客观验证信号。
 *  所以这里刻意只做「追加式捕获 + 有界注入 + 人工升格」，编辑文档的权力
 *  仍然留在 human-only 区。
 *
 * 本模块不认识 cordis、也不做任何 IO：真相源是 AutopilotService 内存里的
 * `LearningRecord[]`（随 state.json 落盘），`.tasks/_learnings.md` 只是它的
 * 全量生成物。这样去重与注入策略能脱离 git 工作区单测。
 */
import { distinctDomains } from './profile.js';
import type { LearningBucket, LearningKind, LearningView } from './view.js';

/** 学习记录的真相源：视图字段 + 已脱敏的原文。 */
export interface LearningRecord extends LearningView {
  detail: string;
}

/** 生效的知识回路配置（AutopilotOptions.learnings 的解析结果）。 */
export interface LearningOptions {
  enabled: boolean;
  injectMaxCount: number;
  injectCharBudget: number;
  promoteAfterHits: number;
  maxEntries: number;
}

/** 默认关闭：开启会改变 agent 看到的提示词，属于行为变更，必须显式 opt-in。 */
export const DEFAULT_LEARNINGS: LearningOptions = {
  enabled: false,
  injectMaxCount: 5,
  injectCharBudget: 1200,
  promoteAfterHits: 3,
  maxEntries: 200,
};

/** 一次捕获的输入。 */
export interface LearningInput {
  kind: LearningKind;
  /** 折成一行的结论（会被注入后续任务描述）。 */
  summary: string;
  /** 原文：评审意见 / 升级消息 + 日志尾。 */
  detail: string;
  touches: string[];
  taskId: string | null;
  contractId: string | null;
  /** 封闭来源能推出桶时优先用它，只有 manual 才让模型自由选。 */
  bucket?: LearningBucket | undefined;
  /** kind 为 escalation 时带上升级原因，用于映射到意图桶。 */
  reason?: string | undefined;
  createdAt?: number | undefined;
}

/** escalation reason → 桶：把升级事件直接归到可去重的意图上。 */
const REASON_BUCKET: Record<string, LearningBucket> = {
  'cross-domain': 'scope',
  'review-rounds-exceeded': 'contract-ambiguity',
  'task-stuck': 'testability',
  'forbidden-paths': 'security',
  'deploy-failed': 'deploy',
  'bootstrap-failed': 'env',
  'gate-failure': 'quality-gate',
  'foreign-gate-failure': 'quality-gate',
  'paid-dependency': 'env',
  'conflicting-requirements': 'contract-ambiguity',
};

/** 从封闭来源推导意图桶；推不出时回落 `other`。 */
export function learningBucketFor(kind: LearningKind, hints: { reason?: string; bucket?: LearningBucket }): LearningBucket {
  if (hints.bucket !== undefined) return hints.bucket;
  if (kind === 'escalation' && hints.reason !== undefined) return REASON_BUCKET[hints.reason] ?? 'other';
  if (kind === 'review-change-request') return 'quality-gate';
  return 'other';
}

/**
 * 归一化用于比较的文本：小写、剥掉代码块与反引号（**只剥标记，保留内容** ——
 * 命令与路径正是记录里最有价值的 token）、剥链接、数字统一成 `#`（行号与计数
 * 每次都一样）、非字母数字压成单空格。
 */
export function normalizeForFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`/g, '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\d+/g, '#')
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim()
    .slice(0, 400);
}

/** 域签名：touches 折叠成最小覆盖集后排序拼接（与跨域统计同一份前缀语义）。 */
export function domainSignature(touches: readonly string[]): string {
  return distinctDomains(touches).join(',');
}

/**
 * 去重键 = `(来源, 域, 意图桶)` 三元组的稳定签名。
 *
 * 刻意**不含**原文指纹：同一次坑的不同措辞必须能并进一条，否则 hits 永远停在 1，
 * "被反复印证"这个升格信号就不存在了。代价是同域同意图的不同细节会并成一条 ——
 * 合并时保留最新结论，真正的去重层是人把它写进项目文档。
 */
export function learningKey(input: { kind: LearningKind; domain: string; bucket: LearningBucket }): string {
  return `${input.kind}|${input.domain}|${input.bucket}`;
}

/**
 * 把一次捕获并入记录集：命中同一去重键则累加 hits 并用最新原文刷新结论，
 * 否则追加新记录并按 maxEntries 淘汰。
 */
export function applyLearning(
  records: readonly LearningRecord[],
  input: LearningInput,
  options: LearningOptions,
  id: string,
): { records: LearningRecord[]; learning: LearningRecord; merged: boolean } {
  const now = input.createdAt ?? Date.now();
  const domain = domainSignature(input.touches);
  const bucket = learningBucketFor(input.kind, { reason: input.reason, bucket: input.bucket });
  const key = learningKey({ kind: input.kind, domain, bucket });
  const index = records.findIndex((record) => record.key === key);
  const existing = index === -1 ? undefined : records[index];

  if (existing === undefined) {
    const learning: LearningRecord = {
      id,
      detail: input.detail,
      kind: input.kind,
      key,
      bucket,
      summary: input.summary,
      domain,
      touches: [...input.touches],
      taskId: input.taskId,
      contractId: input.contractId,
      hits: 1,
      lastHitAt: now,
      createdAt: now,
      promoted: false,
    };
    return { records: capLearnings([...records, learning], options), learning, merged: false };
  }

  const hits = existing.hits + 1;
  const mergedRecord: LearningRecord = {
    ...existing,
    // 键由 (kind, 域, 桶) 决定，本次命中本来就是按它匹配上的 —— 保持不动。
    key,
    hits,
    lastHitAt: now,
    // 保留最新的结论与原文：最新的那次通常是被修对之后的表述。
    summary: input.summary,
    detail: input.detail,
    touches: existing.touches.length > 0 ? existing.touches : [...input.touches],
  };
  const next = [...records];
  next[index] = mergedRecord;
  return { records: next, learning: mergedRecord, merged: true };
}

/**
 * 条数上限：优先淘汰「命中少且久未被印证」的记录，已升格的永不淘汰
 *（它们已经进了项目文档，留在账上是为了让人看见闭环成立）。
 */
export function capLearnings(records: readonly LearningRecord[], options: LearningOptions): LearningRecord[] {
  if (records.length <= options.maxEntries) return [...records];
  const keepable = records.filter((record) => record.promoted);
  const evictable = records
    .filter((record) => !record.promoted)
    .toSorted((a, b) => a.hits - b.hits || a.lastHitAt - b.lastHitAt);
  const room = Math.max(0, options.maxEntries - keepable.length);
  return [...keepable, ...evictable.slice(evictable.length - room)];
}

/** 注入用的打分：相关性 > 被印证次数 > 新鲜度。 */
function injectionScore(record: LearningRecord, taskDomains: readonly string[], now: number): number {
  const relevant =
    record.domain === '' ||
    taskDomains.some((domain) => record.domain.split(',').some((own) => own.startsWith(domain) || domain.startsWith(own)));
  const ageDays = (now - record.lastHitAt) / 86_400_000;
  const recency = Math.exp(-ageDays / 30);
  return (relevant ? 3 : 0) + Math.log2(record.hits + 1) * 2 + recency;
}

/**
 * 挑出要写进任务描述的教训：已升格的不参与（它们已经进了项目文档），
 * 相关的优先；条数与字符双重预算，超出的丢弃并留一行指向 learning_list。
 */
export function selectLearnings(
  records: readonly LearningRecord[],
  touches: readonly string[],
  options: LearningOptions,
  now = Date.now(),
): { items: LearningView[]; dropped: number } {
  if (!options.enabled) return { items: [], dropped: 0 };
  const taskDomains = distinctDomains(touches);
  const pool = records
    .filter((record) => !record.promoted)
    .map((record) => ({ record, score: injectionScore(record, taskDomains, now) }))
    .toSorted((a, b) => b.score - a.score || b.record.lastHitAt - a.record.lastHitAt);
  const maxCount = Math.max(1, Math.min(options.injectMaxCount, 5));
  const items: LearningView[] = [];
  let used = 0;
  for (const { record } of pool) {
    if (items.length >= maxCount) break;
    if (used + record.summary.length > options.injectCharBudget) continue;
    used += record.summary.length;
    items.push(viewOf(record));
  }
  return { items, dropped: pool.length - items.length };
}

/** 记录 → 视图（剥掉只留在服务侧的原文）。 */
export function viewOf(record: LearningRecord): LearningView {
  const { detail: _detail, ...view } = record;
  return view;
}

/** 注入到任务描述尾部的《已知教训》小节；无内容时原样返回，绝不加空节。 */
export function renderLearningsSection(items: readonly LearningView[], dropped: number, description: string): string {
  if (items.length === 0) return description;
  const lines = ['', '', '## 已知教训（来自本仓库更早的任务，勿重复踩）', ''];
  for (const item of items) {
    const domain = item.domain === '' ? '' : ` _(${item.domain})_`;
    lines.push(`- [${item.bucket}]${domain} ${item.summary}`);
    if (item.contractId !== null) lines.push(`  - 出处: \`.tasks/${item.contractId}.md\`，已印证 ${item.hits} 次`);
  }
  if (dropped > 0) lines.push(`- …另有 ${dropped} 条未注入，用 \`learning_list\` 查看`);
  return `${description}${lines.join('\n')}`;
}

/** 生成 `.tasks/_learnings.md` 的全量内容（自动生成，勿手改）。 */
export function renderLearningsFile(records: readonly LearningRecord[]): string {
  const lines: string[] = [
    '# 已知教训（自动生成，勿手改）',
    '',
    `> regenerated at ${new Date().toISOString()}`,
    '>',
    '> 本文件由 dsh-ai-team 从运行态全量重写，真相源在 state.json。',
    '> 要沉淀成长期约定，请人工升格进项目文档（AGENTS.md / docs/），',
    '> 再用 `learning_promote` 标记 —— 标记后不再注入任务描述。',
    '',
  ];
  if (records.length === 0) {
    lines.push('- (none yet)', '');
    return lines.join('\n');
  }
  const sorted = records.toSorted((a, b) => b.hits - a.hits || b.lastHitAt - a.lastHitAt);
  lines.push('| kind | bucket | hits | domain | summary | promoted |', '| --- | --- | --- | --- | --- | --- |');
  for (const record of sorted) {
    lines.push(
      `| ${record.kind} | ${record.bucket} | ${record.hits} | ${record.domain || '-'} | ${record.summary} | ${record.promoted ? 'yes' : '-'} |`,
    );
  }
  lines.push('', '## 明细', '');
  for (const record of sorted) {
    lines.push(`### ${record.summary}`);
    lines.push('');
    lines.push(`- kind: \`${record.kind}\` · bucket: \`${record.bucket}\` · hits: ${record.hits}`);
    if (record.contractId !== null) lines.push(`- 出处: \`.tasks/${record.contractId}.md\``);
    lines.push(`- 首次: ${new Date(record.createdAt).toISOString()} · 最近印证: ${new Date(record.lastHitAt).toISOString()}`);
    lines.push(`- 原文: ${record.detail.replace(/\s+/g, ' ').trim()}`);
    lines.push('');
  }
  return lines.join('\n');
}
