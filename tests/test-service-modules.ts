/**
 * service/ 下纯函数的直接单测。
 *
 * 这些逻辑从 AutopilotService 里搬出来就是为了能脱离 git 工作区单测 ——
 * 之前只能通过"建团队 + 派发 + 读 task.description"间接近似，边界条件
 * （预算、顺序、淘汰阈值）在集成测试里既贵又含糊。
 */
import { describe, expect, it } from 'vitest';
import { buildDescription, CONTRACT_BODY_LIMIT, DESCRIPTION_TOTAL_LIMIT } from '../src/service/description.js';
import { renderCompletionReport } from '../src/service/report.js';
import { clip, HELD_STATUSES, noteLines, oneLine, shortId } from '../src/service/state.js';
import { defaultProfile } from '../src/profile.js';
import { DEFAULT_LEARNINGS } from '../src/learnings.js';
import type { LearningRecord } from '../src/learnings.js';
import type { DeployView } from '../src/view.js';
import type { TeamRecord } from '../src/service/state.js';

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
});

function team(overrides: Partial<TeamRecord> = {}): TeamRecord {
  return {
    id: 'team_1',
    name: 'demo',
    repoPath: '/tmp/r',
    workspaceRoot: '/tmp/w',
    baseBranch: 'main',
    branches: ['main'],
    members: [],
    tasks: [],
    reviews: [],
    createdAt: 1,
    ...overrides,
  };
}

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task_1',
    contractId: 'CORE-1',
    title: 'core',
    description: 'body',
    assigneeId: 'm_1',
    status: 'done',
    branch: 'task/CORE-1',
    reviewRound: 0,
    dependsOn: [],
    touches: ['server/'],
    gates: null,
    prUrl: null,
    ciStatus: null,
    lastActivityAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function deploy(overrides: Partial<DeployView> = {}): DeployView {
  return {
    id: 'deploy_1',
    branch: 'main',
    command: 'docker compose up -d',
    status: 'healthy',
    healthCheckUrl: null,
    logTail: '',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    ...overrides,
  };
}

const base = { finishedAt: 1_700_000_002_000 };

describe('renderCompletionReport', () => {
  it('lists tasks with their contract ids and the deploy history', () => {
    const out = renderCompletionReport({
      ...base,
      team: team({
        tasks: [taskRecord({ contractId: 'CORE-1', title: 'core' })],
      }),
      deploys: [deploy()],
      promoteAfterHits: undefined,
    });
    expect(out).toContain('- CORE-1 core — done');
    expect(out).toContain('- deploy_1 healthy at');
    expect(out).toContain('2023-11-14');
  });

  it('says so when nothing was captured or deployed', () => {
    const out = renderCompletionReport({ ...base, team: team(), deploys: [], promoteAfterHits: 3 });
    expect(out).toContain('- (none)');
    expect(out).toContain('- (none captured)');
  });

  it('lists only unpromoted lessons that cleared the hit threshold', () => {
    const out = renderCompletionReport({
      ...base,
      team: team({
        learnings: [
          learning({ id: 'a', summary: 'ready to promote', hits: 4, promoted: false }),
          learning({ id: 'b', summary: 'not enough hits', hits: 1, promoted: false }),
          learning({ id: 'c', summary: 'already promoted', hits: 9, promoted: true }),
        ],
      }),
      deploys: [],
      promoteAfterHits: 3,
    });
    const section = out.slice(out.indexOf('## pending promotion'));
    expect(section).toContain('ready to promote — id a (4x)');
    expect(section).not.toContain('not enough hits');
    expect(section).not.toContain('already promoted');
  });

  it('omits the promotion section entirely when the knowledge loop is off', () => {
    const out = renderCompletionReport({
      ...base,
      team: team({ learnings: [learning({ hits: 99 })] }),
      deploys: [],
      promoteAfterHits: undefined,
    });
    expect(out).not.toContain('pending promotion');
    // 台账本身仍然要报告
    expect(out).toContain('migrations must run before the e2e gate');
  });
});

describe('state helpers', () => {
  it('clip returns empty for a non-positive budget', () => {
    // 这是预算倒排能成立的前提：clip(text, 0) 若走 slice(0,-1) 会留下几乎全文
    expect(clip('hello world', 0)).toBe('');
    expect(clip('hello world', -5)).toBe('');
    expect(clip('abc', 10)).toBe('abc');
    expect(clip('abcdef', 4)).toBe('abc…');
  });

  it('shortId prefixes and stays 8 hex chars', () => {
    expect(shortId('task')).toMatch(/^task_[0-9a-f]{8}$/);
  });

  it('oneLine strips markdown bullets and blank leading lines', () => {
    expect(oneLine('\n\n- **fix the flake**: retry\nmore')).toBe('**fix the flake**: retry');
    expect(oneLine('   \n  ')).toBe('');
  });

  it('noteLines prefixes every line and honours the cap', () => {
    expect(noteLines('a\nb')).toEqual(['> a', '> b']);
    expect(noteLines('a\nb\nc', 2)).toEqual(['> a', '> b']);
  });

  it('HELD_STATUSES covers exactly the two waiting states', () => {
    expect([...HELD_STATUSES].toSorted()).toEqual(['needs-clarification', 'needs-human']);
  });
});
