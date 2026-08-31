/**
 * 知识回路的纯逻辑与"静默失败面"守护测试。
 *
 * 两件事放在一起是有意的：都是不需要 git 工作区的快速断言。
 *  1. learnings 的去重键、注入预算、淘汰与生成物形状；
 *  2. 枚举 ↔ i18n 字典的一致性 —— 面板用运行时拼 key 调 t()，编译器不校验，
 *     新增枚举值忘了配字典就会把原始 key 渲染给人看。
 */
import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyLearning,
  capLearnings,
  DEFAULT_LEARNINGS,
  domainSignature,
  learningBucketFor,
  learningKey,
  normalizeForFingerprint,
  renderLearningsFile,
  renderLearningsSection,
  selectLearnings,
  type LearningRecord,
} from '../../src/learnings.js';
import { patchTaskContract, parseTaskContract, regenerateBoard } from '../../src/team.js';
import { forbiddenTouchesViolation } from '../../src/profile.js';
import { en, zh } from '../../src/client/index.js';
import {
  ESCALATION_REASONS,
  LEARNING_BUCKETS,
  LEARNING_KINDS,
  ROLES,
  TASK_STATUSES,
} from '../../src/view.js';
import type { CiStatus, LoopState } from '../../src/view.js';

const options = { ...DEFAULT_LEARNINGS, enabled: true };

/** 造一条捕获输入：只关心会影响去重键的字段。 */
const input = (over: Partial<Parameters<typeof applyLearning>[1]> = {}): Parameters<typeof applyLearning>[1] => ({
  kind: 'review-change-request',
  summary: 'schema change without parity check',
  detail: 'You must run db:check-parity after changing server/db/',
  touches: ['server/db/'],
  taskId: 'task_1',
  contractId: 'CORE-1',
  ...over,
});

describe('learnings: capture & dedupe', () => {
  it('merges the same pitfall rephrased into one record', () => {
    let records: LearningRecord[] = [];
    const first = applyLearning(records, input(), options, 'learn_a');
    records = first.records;
    expect(first.merged).toBe(false);
    expect(first.learning.hits).toBe(1);
    expect(first.learning.bucket).toBe('quality-gate');

    // 同一个坑、换个措辞、不同时间：键只由 (来源, 域, 桶) 决定，所以能并进来。
    const second = applyLearning(
      records,
      input({ summary: 'parity gate fails on schema edits', detail: 'gate failed: run the parity check when you touch the schema files 42 times' }),
      options,
      'learn_b',
    );
    records = second.records;
    expect(second.merged).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]?.hits).toBe(2);
    expect(records[0]?.key).toBe(
      learningKey({ kind: 'review-change-request', domain: domainSignature(['server/db/']), bucket: 'quality-gate' }),
    );
    // 保留最新结论：最近一次通常是被修正后的表述。
    expect(records[0]?.summary).toBe('parity gate fails on schema edits');

    // 第三次换措辞仍然并进同一条。
    const third = applyLearning(records, input({ detail: 'the check must run again after migrations' }), options, 'learn_c');
    expect(third.merged).toBe(true);
    expect(third.records).toHaveLength(1);
    expect(third.records[0]?.hits).toBe(3);
  });

  it('keeps different intents in the same domain apart', () => {
    const a = applyLearning([], input({ bucket: 'schema' }), options, 'learn_a');
    const b = applyLearning(a.records, input({ bucket: 'security', detail: 'env value leaked into the log line' }), options, 'learn_b');
    expect(b.records).toHaveLength(2);
  });

  it('derives the bucket from the escalation reason instead of trusting free text', () => {
    expect(learningBucketFor('escalation', { reason: 'cross-domain' })).toBe('scope');
    expect(learningBucketFor('escalation', { reason: 'deploy-failed' })).toBe('deploy');
    expect(learningBucketFor('escalation', { reason: 'unknown-reason' })).toBe('other');
    // 封闭来源优先：显式 bucket 可以覆盖。
    expect(learningBucketFor('escalation', { reason: 'cross-domain', bucket: 'testability' })).toBe('testability');
  });

  it('normalizes away the noise that would otherwise split a pitfall in two', () => {
    // 数字、代码片段与链接是噪音；路径是信息本体，必须保留 ——
    // "改 server/db/schema 要跑 parity" 抹掉路径就毫无价值了。
    expect(normalizeForFingerprint('Gate failed after 37 tries')).toBe(normalizeForFingerprint('Gate failed after 4 tries'));
    expect(normalizeForFingerprint('`pnpm run build` blew up')).toBe(normalizeForFingerprint('pnpm run build blew up'));
    expect(normalizeForFingerprint('see https://ci.example/run/9')).toBe('see');
    expect(normalizeForFingerprint('run server/db/schema twice')).not.toBe(normalizeForFingerprint('run server/other twice'));
    expect(domainSignature(['server/db/', 'server/db/schema/', 'docs/'])).toBe('docs/,server/db/');
  });

  it('evicts the least corroborated records but never a promoted one', () => {
    const base = applyLearning([], input(), options, 'learn_keep');
    const promoted: LearningRecord = { ...base.learning, id: 'learn_keep', promoted: true, hits: 1 };
    const fillers: LearningRecord[] = Array.from({ length: 12 }, (_unused, index) => ({
      ...promoted,
      id: `learn_${index}`,
      promoted: false,
      hits: index + 1,
      lastHitAt: index,
    }));
    const capped = capLearnings([promoted, ...fillers], { ...options, maxEntries: 5 });
    expect(capped).toHaveLength(5);
    expect(capped.some((record) => record.id === 'learn_keep')).toBe(true);
    // 淘汰 hits 最少的：留下的应当是 8..12 那几条。
    expect(capped.filter((record) => !record.promoted).map((record) => record.hits)).toEqual([9, 10, 11, 12]);
  });
});

describe('learnings: injection is bounded', () => {
  it('respects both the count and the character budget and reports what it dropped', () => {
    // 每条落在互不相同的域上，才是 50 条独立记录（同域同意图会被去重合并 ——
    // 那是上一条用例保证的行为，不能拿来当这里的夹具）。
    const many: LearningRecord[] = [];
    for (let index = 0; index < 50; index += 1) {
      const touches = [`area-${index}/`];
      const summary = `lesson for ${touches[0]} telling the reader exactly what to do instead`;
      let hits = 0;
      for (let hit = 0; hit <= index % 5; hit += 1) {
        const applied = applyLearning(
          many,
          input({ touches, summary, detail: `${summary} observed at step ${hit}` }),
          options,
          `learn_${index}`,
        );
        many.length = 0;
        many.push(...applied.records);
        hits = applied.learning.hits;
      }
      expect(hits).toBe(index % 5 + 1);
    }
    expect(many).toHaveLength(50);
    const tight = { ...options, injectMaxCount: 3, injectCharBudget: 260 };
    const { items, dropped } = selectLearnings(many, ['area-7/'], tight);
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(3);
    expect(items.reduce((sum, item) => sum + item.summary.length, 0)).toBeLessThanOrEqual(260);
    expect(dropped).toBe(many.length - items.length);
    // 相关性优先：与本任务 touches 同域的那条必须排第一，哪怕它 hits 最少。
    expect(items[0]?.summary).toContain('area-7/');
    const rest = items.slice(1).map((item) => item.hits);
    expect([...rest].toSorted((a, b) => b - a)).toEqual(rest);
  });

  it('injects nothing when the loop is disabled — the default state of every existing team', () => {
    const captured = applyLearning([], input(), options, 'learn_a');
    expect(selectLearnings(captured.records, ['server/db/'], DEFAULT_LEARNINGS).items).toEqual([]);
  });

  it('renders a section only when there is something to say', () => {
    expect(renderLearningsSection([], 0, 'body')).toBe('body');
    const captured = applyLearning([], input(), options, 'learn_a');
    const text = renderLearningsSection([{ ...captured.learning }], 2, 'body');
    expect(text).toContain('已知教训');
    expect(text).toContain('.tasks/CORE-1.md');
    expect(text).toContain('另有 2 条未注入');
  });

  it('writes _learnings.md as a generated artifact with the evidence kept out of the table', () => {
    const captured = applyLearning([], input(), options, 'learn_a');
    const markdown = renderLearningsFile(captured.records);
    expect(markdown).toContain('自动生成，勿手改');
    expect(markdown).toContain('真相源在 state.json');
    expect(markdown).toContain('db:check-parity');
    expect(renderLearningsFile([])).toContain('(none yet)');
  });
});

describe('forbidden contract self-check', () => {
  it('flags both directions of the prefix overlap', () => {
    expect(forbiddenTouchesViolation(['.github/workflows/'], ['.github/'])).toEqual(['.github/workflows/']);
    // touch 是禁区的祖先同样危险：它授权了这个任务去改禁区里面。
    expect(forbiddenTouchesViolation(['app/'], ['app/server/'])).toEqual(['app/']);
    expect(forbiddenTouchesViolation(['app/'], ['server/'])).toEqual([]);
    expect(forbiddenTouchesViolation([], ['.github/'])).toEqual([]);
  });
});

describe('task contract round-trip', () => {
  it('persists needs-clarification without silently downgrading it to pending', async () => {
    // parseTaskContract 会把无法识别的 status 降级成 pending，而契约回写是
    // best-effort 的：枚举与文件两边必须同时认这个值，否则"挂起等澄清"会被
    // 守护循环当成待派发任务重新派出去，且没有任何地方报错。
    const dir = await mkdtemp(join(tmpdir(), 'dsh-ai-team-contract-'));
    const path = join(dir, 'CORE-9.md');
    await writeFile(
      path,
      ['---', 'id: CORE-9', 'title: clarify me', 'status: pending', 'touches:', '  - server/', '---', '', 'body'].join('\n'),
      'utf8',
    );
    await patchTaskContract(path, { status: 'needs-clarification' });
    const reread = parseTaskContract(path, await readFile(path, 'utf8'));
    expect(reread.status).toBe('needs-clarification');
    expect(reread.touches).toEqual(['server/']);
  });

  it('parses the optional cycle field, and patches it in place preserving other lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-ai-team-cycle-'));
    const path = join(dir, 'CYC-1.md');
    const body = 'Given/When/Then …';
    await writeFile(path, `---\nid: CYC-1\ntitle: cycle task\nstatus: pending\n---\n\n${body}\n`, 'utf8');
    // 缺省 = null（未排期），行为与老契约一字不变。
    expect(parseTaskContract(path, await readFile(path, 'utf8')).cycle).toBeNull();
    // 就地打上周期归属，其它 frontmatter 行逐字节保留。
    await patchTaskContract(path, { cycle: 'M1' });
    const patched = await readFile(path, 'utf8');
    expect(patched).toContain('cycle: M1');
    expect(patched).toContain('title: cycle task');
    expect(parseTaskContract(path, patched).cycle).toBe('M1');
    // 传 null 删除归属（回到未排期），不残留空 cycle key。
    await patchTaskContract(path, { cycle: null });
    const unassigned = await readFile(path, 'utf8');
    expect(unassigned).not.toMatch(/cycle:/);
    expect(parseTaskContract(path, unassigned).cycle).toBeNull();
    expect(unassigned).toContain(body);
  });
});

/** 看板分组测试的契约种子：只关心 cycle / status 两个字段。 */
function contract(id: string, cycle: string | null, status = 'pending') {
  return {
    id,
    title: `title ${id}`,
    status,
    owner: null,
    dependsOn: [] as string[],
    touches: ['app/'],
    forbidden: [] as string[],
    priority: 0,
    cycle,
    path: `.tasks/${id}.md`,
    body: '',
  };
}

describe('regenerateBoard groups contracts by cycle', () => {
  it('renders only in-flight tasks by cycle, then unscheduled, blocking and cancelled sections', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-ai-team-board-'));
    await mkdir(join(dir, '.tasks'), { recursive: true });
    await regenerateBoard(dir, [
      contract('M1-1', 'M1', 'done'),
      contract('M1-2', 'M1', 'in_progress'),
      contract('M2-1', 'M2'),
      contract('FREE-1', null),
      contract('DEAD-1', 'M1', 'cancelled'),
    ]);
    const board = await readFile(join(dir, '.tasks', '_board.md'), 'utf8');
    // done 任务已归档/不入进行中分区 → 看板不再列它；进行中 M1-2 仍按周期分组呈现。
    expect(board).not.toContain('| M1-1 |');
    expect(board).toContain('## M1');
    expect(board).toContain('| M1-2 |');
    expect(board).toContain('| M2-1 |');
    // cancelled 不是进行中，不出现在周期分组里，单独进「已废弃」。
    expect(board).not.toContain('| DEAD-1 |');
    // 无周期契约归「未排期」区，且按首次出现顺序先列 M1、M2。
    expect(board.indexOf('## M1')).toBeLessThan(board.indexOf('## 未排期'));
    expect(board.indexOf('## 未排期')).toBeLessThan(board.indexOf('## 阻塞清单'));
    // 归档统计：.tasks/archive/ 目录不存在 → 0；看板字节稳定（无时间戳）。
    expect(board).toContain('已归档 0 个任务');
    expect(board).toContain('## 已废弃');
    expect(board).toContain('DEAD-1 title DEAD-1 — cancelled');
    expect(board).not.toMatch(/regenerated at/);
  });

  it('keeps a bare board byte-stable across regenerations (no timestamps, stable progress)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-ai-team-board-stable-'));
    await mkdir(join(dir, '.tasks'), { recursive: true });
    const contracts = [contract('B-1', null), contract('B-2', 'M1')];
    await regenerateBoard(dir, contracts);
    const first = await readFile(join(dir, '.tasks', '_board.md'), 'utf8');
    await regenerateBoard(dir, contracts);
    const second = await readFile(join(dir, '.tasks', '_board.md'), 'utf8');
    expect(second).toBe(first);
  });
});

describe('panel dictionaries cover every enum value', () => {
  // 面板里 t(`role.${x}`) / t(`status.${x}`) / t(`reason.${x}`) 这些 key 是运行时
  // 拼出来的，Translator 的签名接受任意字符串：漏配字典不会编译报错、不会测试变红，
  // 只会把原始 key 渲染给人。这个测试就是来堵这个洞的。
  const prefixFor: [string, readonly string[]][] = [
    ['role', ROLES],
    ['status', TASK_STATUSES],
    ['reason', ESCALATION_REASONS],
    ['loop', ['stopped', 'running', 'paused', 'escalated', 'completed'] satisfies LoopState[]],
    ['ci', ['pending', 'success', 'failure', 'unknown'] satisfies CiStatus[]],
    ['deploy', ['running', 'healthy', 'failed', 'rolled-back']],
    ['notify', ['disabled', 'sent', 'failed']],
  ];
  for (const [prefix, values] of prefixFor) {
    it(`${prefix}.* exists in both dictionaries for ${values.join(', ')}`, () => {
      for (const value of values) {
        expect(zh[`${prefix}.${value}` as keyof typeof zh], `zh missing ${prefix}.${value}`).toBeTruthy();
        expect(en[`${prefix}.${value}` as keyof typeof en], `en missing ${prefix}.${value}`).toBeTruthy();
      }
    });
  }

  it('keeps the two dictionaries keyed identically', () => {
    expect(Object.keys(en).toSorted()).toEqual(Object.keys(zh).toSorted());
  });

  it('has a learning kind/bucket vocabulary the panel can render verbatim', () => {
    // 面板直接原样渲染 bucket（技术标签，不翻译），但它必须是封闭词表，
    // 否则去重键的分桶维度就成了模型自由发挥的文本。
    expect(LEARNING_KINDS).toContain('review-change-request');
    expect(LEARNING_BUCKETS).toContain('contract-ambiguity');
    expect(new Set(LEARNING_BUCKETS).size).toBe(LEARNING_BUCKETS.length);
  });
});
