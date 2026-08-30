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
import { budgetExceeded, reviewRoundsExceeded, taskStuck } from '../src/service/daemon.js';
import { effectiveAnswers, withApprovalQuestion } from '../src/service/docflow.js';
import { memberView as memberViewOf, taskView as taskViewOf } from '../src/service/views.js';
import { clip, HELD_STATUSES, noteLines, oneLine, shortId } from '../src/service/state.js';
import { defaultProfile } from '../src/profile.js';
import { DEFAULT_LEARNINGS } from '../src/learnings.js';
import type { LearningRecord } from '../src/learnings.js';
import type { DeployView } from '../src/view.js';
import type { MemberRecord, TaskRecord, TeamRecord } from '../src/service/state.js';
import type { QuestionnaireRecord } from '../src/questionnaire.js';
import { mergeRuntimeConfig, runtimeConfigViewOf } from '../src/service/options.js';
import type { AutopilotOptions } from '../src/service/options.js';
import { AutopilotService } from '../src/service.js';
import { makeFixture, testOptions } from './helpers.js';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

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

  it('renders the run metrics section with histogram and task durations', () => {
    const out = renderCompletionReport({
      ...base,
      team: team({
        metrics: {
          dispatched: 3,
          completed: 2,
          reviewRounds: 1,
          gateRuns: 5,
          gateFailures: 1,
          deploys: 2,
          rollbacks: 1,
          escalations: { 'budget-exceeded': 2, 'task-stuck': 1 },
        },
        tasks: [
          taskRecord({
            contractId: 'CORE-1',
            dispatchedAt: 1_700_000_000_000,
            completedAt: 1_700_000_000_000 + 90 * 60_000,
          }),
          taskRecord({ contractId: 'CORE-2', dispatchedAt: 1_700_000_000_000 }), // 未完成 → 无耗时行
          taskRecord({ contractId: 'CORE-3' }), // 旧数据无时间戳 → 跳过
        ],
      }),
      deploys: [],
      promoteAfterHits: undefined,
    });
    expect(out).toContain('- dispatched 3 / completed 2 / review rounds 1');
    expect(out).toContain('- gate runs 5 (failures 1)');
    expect(out).toContain('- deploys 2 (rollbacks 1)');
    // 直方图按次数降序
    const escalations = out.slice(out.indexOf('- escalations by reason'), out.indexOf('## deploys'));
    expect(escalations.indexOf('budget-exceeded: 2')).toBeLessThan(escalations.indexOf('task-stuck: 1'));
    // 只有派发且完成过的任务才有耗时行
    expect(out).toContain('- task durations (dispatch → done)');
    expect(out).toContain('CORE-1: 1h 30m');
    expect(out).not.toContain('CORE-2:');
    expect(out).not.toContain('CORE-3:');
  });

  it('omits the run metrics section for pre-metrics teams', () => {
    const out = renderCompletionReport({ ...base, team: team(), deploys: [], promoteAfterHits: undefined });
    expect(out).not.toContain('run metrics');
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

// ── daemon.ts：守护循环的纯判定层 ────────────────────────────────────────────

describe('daemon: reviewRoundsExceeded / taskStuck / budgetExceeded', () => {
  const daemonTaskBase = {
    id: 'task_1',
    contractId: null,
    title: 't',
    description: '',
    assigneeId: 'm_1',
    branch: 'task/task_1',
    reviewRound: 0,
    dependsOn: [],
    touches: [],
    gates: null,
    prUrl: null,
    ciStatus: null,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
  };

  it('reviewRoundsExceeded 只认 changes_requested 且达到上限', () => {
    const task = { ...daemonTaskBase, status: 'changes_requested', reviewRound: 3 } as TaskRecord;
    expect(reviewRoundsExceeded(task, 3)).toBe(true);
    expect(reviewRoundsExceeded({ ...task, reviewRound: 2 }, 3)).toBe(false);
    // in_review 不算返工打满（还没被再次打回）
    expect(reviewRoundsExceeded({ ...task, status: 'in_review' }, 3)).toBe(false);
  });

  it('taskStuck 在恰好到达阈值时不算卡死', () => {
    const task = { ...daemonTaskBase, status: 'in_progress', lastActivityAt: 1_000 } as TaskRecord;
    expect(taskStuck(task, 45, 1_000 + 45 * 60_000)).toBe(false);
    expect(taskStuck(task, 45, 1_000 + 45 * 60_000 + 1)).toBe(true);
  });

  it('budgetExceeded：0 = 关闭，且 dispatchedAt 缺失（老 state.json）不判', () => {
    const task = { ...daemonTaskBase, status: 'in_progress', dispatchedAt: 1_000 } as TaskRecord;
    expect(budgetExceeded(task, 0, 10_000_000)).toBe(false);
    expect(budgetExceeded(task, 2, 1_000 + 2 * 3_600_000)).toBe(false);
    expect(budgetExceeded(task, 2, 1_000 + 2 * 3_600_000 + 1)).toBe(true);
    expect(budgetExceeded({ ...task, dispatchedAt: undefined }, 2, 10_000_000)).toBe(false);
    // 非 in_progress 不判：等待派发的 pending 没有烧钱
    expect(budgetExceeded({ ...task, status: 'pending' }, 2, 10_000_000)).toBe(false);
  });
});

// ── views.ts：视图投影纯映射 ────────────────────────────────────────────────

describe('views: taskView / memberView', () => {
  const member: MemberRecord = {
    id: 'm_1',
    name: 'dev-1',
    role: 'developer',
    systemPrompt: 'sp',
    workspacePath: '/ws',
    branch: 'member/m_1',
    status: 'working',
    currentTaskId: 'task_1',
  };
  const viewTeam = {
    id: 'team_1',
    name: 't',
    repoPath: '/repo',
    members: [member],
    tasks: [],
    reviews: [],
    phase: 'developing',
    learnings: [],
    createdAt: 0,
  } as unknown as TeamRecord;

  it('taskView 把 assigneeId 解析成成员名', () => {
    const task = {
      id: 'task_1',
      contractId: 'CORE-1',
      title: 't',
      description: '',
      assigneeId: 'm_1',
      status: 'in_progress',
      branch: 'task/task_1',
      reviewRound: 0,
      dependsOn: [],
      touches: [],
      gates: null,
      prUrl: null,
      ciStatus: null,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0,
    } as TaskRecord;
    const view = taskViewOf(viewTeam, task);
    expect(view.assigneeName).toBe('dev-1');
    expect(view.contractId).toBe('CORE-1');
  });

  it('taskView 对不存在的 assignee 抛错（视图不吞失配）', () => {
    const task = { ...({} as TaskRecord), assigneeId: 'm_missing' };
    expect(() => taskViewOf(viewTeam, task)).toThrow(/has no member "m_missing"/);
  });

  it('memberView 是字段的纯投影（不含 systemPrompt）', () => {
    const view = memberViewOf(member);
    expect(view).toEqual({
      id: 'm_1',
      name: 'dev-1',
      role: 'developer',
      workspacePath: '/ws',
      branch: 'member/m_1',
      status: 'working',
      currentTaskId: 'task_1',
    });
  });
});

// ── docflow.ts：问卷答案与审批题的纯函数 ─────────────────────────────────────

describe('docflow: effectiveAnswers / withApprovalQuestion', () => {
  const question = { name: 'q1', label: 'Q1', type: 'text', options: [], required: true, defaultValue: '' };

  function record(overrides: Record<string, unknown>): QuestionnaireRecord {
    return {
      id: 'qn_1',
      teamId: 'team_1',
      kind: 'intake',
      mode: 'interactive',
      title: 't',
      questions: [question],
      answers: {},
      status: 'answered',
      binding: null,
      ticketUrl: null,
      mailDelivered: false,
      taskId: null,
      createdAt: 0,
      answeredAt: null,
      expiresAt: null,
      approvalCode: null,
      ...overrides,
    } as QuestionnaireRecord;
  }

  it('答完的用真答案；空串不算答案', () => {
    const answered = record({ answers: { q1: { value: 'docker', at: 1, source: 'ticket' } } });
    expect(effectiveAnswers(answered)).toEqual({ q1: 'docker' });
    const blank = record({ answers: { q1: { value: '', at: 1, source: 'ticket' } } });
    expect(effectiveAnswers(blank)).toEqual({});
  });

  it('expired 才回落 defaultValue；answered 不回落（§3.2 兜底只属于超时）', () => {
    const expired = record({
      status: 'expired',
      answers: {},
      questions: [{ ...question, defaultValue: 'docker' }],
    });
    expect(effectiveAnswers(expired)).toEqual({ q1: 'docker' });
    const open = record({ answers: {}, questions: [{ ...question, defaultValue: 'docker' }] });
    expect(effectiveAnswers(open)).toEqual({});
  });

  it('withApprovalQuestion 追加 decision 题且默认值是 reject（§8-10 的保守兜底）', () => {
    const withQuestion = withApprovalQuestion([]);
    expect(withQuestion).toHaveLength(1);
    expect(withQuestion[0]?.name).toBe('decision');
    expect(withQuestion[0]?.defaultValue).toBe('reject');
    // 已有同名题时不重复追加
    const existing = [{ ...question, name: 'decision' }];
    expect(withApprovalQuestion(existing)).toBe(existing);
  });
});

async function makeBaseOptions(): Promise<AutopilotOptions> {
  const fixture = await makeFixture('runtime-config');
  return testOptions(fixture);
}

describe('runtime config: mergeRuntimeConfig / runtimeConfigViewOf', () => {
  it('merges group objects per key without dropping the rest of the group', async () => {
    const options = await makeBaseOptions();
    const merged = mergeRuntimeConfig(options, { remote: { url: '/tmp/r.git' }, baseBranch: 'develop' });
    expect(merged.remote.url).toBe('/tmp/r.git');
    expect(merged.remote.sshKeyEnv).toBe(options.remote.sshKeyEnv); // 未覆盖的键保留
    expect(merged.remote.platform).toBe(options.remote.platform);
    expect(merged.baseBranch).toBe('develop');
    // runtimeConfigViewOf 投影的是生效配置的可覆盖子集
    expect(runtimeConfigViewOf(merged).remote.url).toBe('/tmp/r.git');
  });

  it('replaces arrays wholesale (gates.commands)', async () => {
    const options = await makeBaseOptions();
    const merged = mergeRuntimeConfig(options, { gates: { commands: ['pnpm run typecheck'] } });
    expect(merged.gates.commands).toEqual(['pnpm run typecheck']);
    expect(merged.gates.requireCiGreen).toBe(options.gates.requireCiGreen);
  });

  it('undefined overlay entries are skipped', async () => {
    const options = await makeBaseOptions();
    const merged = mergeRuntimeConfig(options, { remote: { url: undefined } });
    expect(merged.remote.url).toBe(options.remote.url);
  });
});

describe('runtime config: service.setRuntimeConfig hot-applies and persists', () => {
  it('applies an override immediately and persists it to state', async () => {
    const fixture = await makeFixture('runtime-config-service');
    const service = await AutopilotService.create(testOptions(fixture));
    const view = service.setRuntimeConfig({ remote: { url: '/tmp/other.git' }, baseBranch: 'develop' });
    expect(view.remote.url).toBe('/tmp/other.git');
    expect(view.baseBranch).toBe('develop');
    await service.dispose();
    const persisted = JSON.parse(await readFile(join(fixture.stateDir, 'state.json'), 'utf8')) as {
      runtimeConfig?: { remote?: { url?: string }; baseBranch?: string };
    };
    expect(persisted.runtimeConfig?.remote?.url).toBe('/tmp/other.git');
    expect(persisted.runtimeConfig?.baseBranch).toBe('develop');
  });

  it('a partial override does not clobber non-overridden keys', async () => {
    const fixture = await makeFixture('runtime-config-merge');
    const service = await AutopilotService.create(testOptions(fixture));
    const before = service.runtimeConfigView();
    const after = service.setRuntimeConfig({ remote: { url: '/tmp/third.git' } });
    expect(after.remote.url).toBe('/tmp/third.git');
    expect(after.remote.sshKeyEnv).toBe(before.remote.sshKeyEnv);
    await service.dispose();
  });
});
