/**
 * service/description.ts 的纯函数单测：任务描述组装，预算倒排与注入顺序。
 */
import { describe, expect, it } from 'vitest';
import { buildDescription, CONTRACT_BODY_LIMIT, DESCRIPTION_TOTAL_LIMIT } from '../../../src/service/description.js';
import { defaultProfile } from '../../../src/profile.js';
import { DEFAULT_LEARNINGS } from '../../../src/learnings.js';
import type { LearningRecord } from '../../../src/learnings.js';

function learning(overrides: Partial<LearningRecord> = {}): LearningRecord {
  return {
    id: 'learn_1',
    kind: 'manual',
    key: 'manual|server/|quality-gate',
    bucket: 'quality-gate',
    summary: 'migrations must run before the e2e gate',
    domain: 'server/',
    touches: ['server/'],
    taskId: 'task_1',
    contractId: 'CORE-1',
    hits: 1,
    lastHitAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    promoted: false,
    detail: 'full detail text',
    ...overrides,
  };
}

const enabled = { ...DEFAULT_LEARNINGS, enabled: true };

describe('buildDescription: 预算与顺序', () => {
  it('returns the raw body untouched when nothing is injected', () => {
    const out = buildDescription({
      raw: 'a plain contract body',
      touches: [],
      learnings: [],
      profile: defaultProfile(),
      learningOptions: undefined,
    });
    expect(out).toBe('a plain contract body');
  });

  it('appends lessons first and the ownership rules LAST', () => {
    const profile = { ...defaultProfile(), ownership: [{ glob: 'server/', role: 'backend', rules: ['never drop a column'] }] };
    const out = buildDescription({
      raw: 'body',
      touches: ['server/'],
      learnings: [learning()],
      profile,
      learningOptions: enabled,
    });
    expect(out).toContain('已知教训');
    expect(out).toContain('migrations must run before the e2e gate');
    expect(out.indexOf('已知教训')).toBeLessThan(out.indexOf('域所有权'));
    expect(out.trimEnd().endsWith('never drop a column')).toBe(true);
  });

  it('injects nothing when the knowledge loop is disabled', () => {
    const out = buildDescription({
      raw: 'body',
      touches: ['server/'],
      learnings: [learning()],
      profile: defaultProfile(),
      learningOptions: { ...DEFAULT_LEARNINGS, enabled: false },
    });
    expect(out).toBe('body');
  });

  it('caps the body at CONTRACT_BODY_LIMIT when there is room to spare', () => {
    const out = buildDescription({
      raw: 'z'.repeat(9_000),
      touches: [],
      learnings: [],
      profile: defaultProfile(),
      learningOptions: undefined,
    });
    expect(out.length).toBe(CONTRACT_BODY_LIMIT);
  });

  it('shrinks the BODY, not the ownership rules, when everything would overflow', () => {
    const longRule = 'r'.repeat(5_000);
    const profile = { ...defaultProfile(), ownership: [{ glob: 'server/', role: 'backend', rules: [longRule] }] };
    const out = buildDescription({
      raw: 'b'.repeat(3_000),
      touches: ['server/'],
      learnings: [learning({ summary: `lesson ${'l'.repeat(150)}` })],
      profile,
      learningOptions: enabled,
    });
    // 所有权段是"不可协商"的末段，必须完整存活
    expect(out.trimEnd().endsWith(longRule)).toBe(true);
    expect(out).toContain('域所有权');
    // 正文被压缩到剩余额度（3000 的原始预算拿不到了）
    expect(out).not.toContain('b'.repeat(3_000));
    expect(out.length).toBeLessThanOrEqual(DESCRIPTION_TOTAL_LIMIT);
  });

  it('never exceeds the total cap even when the lessons alone are huge', () => {
    const out = buildDescription({
      raw: 'b'.repeat(3_000),
      touches: ['server/'],
      learnings: Array.from({ length: 5 }, (_unused, index) =>
        learning({ id: `learn_${index}`, summary: `s${index} ${'m'.repeat(400)}` }),
      ),
      profile: { ...defaultProfile(), ownership: [{ glob: 'server/', role: 'be', rules: ['x'.repeat(4_500)] }] },
      learningOptions: enabled,
    });
    expect(out.length).toBeLessThanOrEqual(DESCRIPTION_TOTAL_LIMIT);
  });

  it('injects the owning cycle context between the body and the lessons (CYC-4)', () => {
    const profile = { ...defaultProfile(), ownership: [{ glob: 'server/', role: 'backend', rules: ['never drop a column'] }] };
    const out = buildDescription({
      raw: 'body',
      touches: ['server/'],
      cycle: { name: 'M1', goal: 'Ship auth v2', scope: ['server/auth/', 'client/auth/'] },
      learnings: [learning()],
      profile,
      learningOptions: enabled,
    });
    expect(out).toContain('## 周期 M1');
    expect(out).toContain('目标：Ship auth v2');
    expect(out).toContain('范围：server/auth/、client/auth/');
    // 顺序：正文 → 周期 → 已知教训 → 域所有权（末段恒为不可协商的硬规则）。
    expect(out.indexOf('body')).toBeLessThan(out.indexOf('## 周期 M1'));
    expect(out.indexOf('## 周期 M1')).toBeLessThan(out.indexOf('已知教训'));
    expect(out.indexOf('已知教训')).toBeLessThan(out.indexOf('域所有权'));
    expect(out.trimEnd().endsWith('never drop a column')).toBe(true);
  });

  it('keeps ownership and cycle context over lessons and body when everything overflows (CYC-4)', () => {
    const longRule = 'r'.repeat(4_000);
    const profile = { ...defaultProfile(), ownership: [{ glob: 'server/', role: 'backend', rules: [longRule] }] };
    const out = buildDescription({
      raw: 'b'.repeat(3_000),
      touches: ['server/'],
      cycle: { name: 'M2', goal: `g ${'c'.repeat(1_000)}`, scope: ['server/'] },
      learnings: Array.from({ length: 5 }, (_unused, index) =>
        learning({ id: `learn_${index}`, summary: `s${index} ${'m'.repeat(400)}` }),
      ),
      profile,
      learningOptions: enabled,
    });
    // 所有权段完整存活；周期上下文比教训更接近"为什么"，预算倒排里排第二。
    expect(out.trimEnd().endsWith(longRule)).toBe(true);
    expect(out).toContain('## 周期 M2');
    expect(out.length).toBeLessThanOrEqual(DESCRIPTION_TOTAL_LIMIT);
  });

  it('renders nothing for a cycle with empty goal and scope (CYC-4)', () => {
    const out = buildDescription({
      raw: 'body',
      touches: [],
      cycle: { name: 'M3', goal: '', scope: [] },
      learnings: [],
      profile: defaultProfile(),
      learningOptions: undefined,
    });
    expect(out).toBe('body');
  });
});