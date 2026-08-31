/**
 * service/report.ts 的纯函数单测：完成报告渲染与周期小结。
 */
import { describe, expect, it } from 'vitest';
import { renderCompletionReport, renderCycleSummary } from '../../../src/service/report.js';
import type { LearningRecord } from '../../../src/learnings.js';
import type { DeployView } from '../../../src/view.js';
import type { TaskRecord, TeamRecord } from '../../../src/service/state.js';

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

  it('renderCycleSummary 汇总单周期的任务完成情况', () => {
    const cycle = { id: 'cycle_1', name: 'M1', status: 'in_review', goal: 'ship auth', scope: ['server/auth/'], taskIds: ['A-1', 'A-2'], createdAt: 1 };
    const out = renderCycleSummary(
      team({
        tasks: [
          taskRecord({ contractId: 'A-1', title: 'oauth', status: 'done' }),
          taskRecord({ contractId: 'A-2', title: 'token refresh', status: 'cancelled' }),
          taskRecord({ contractId: 'A-3', title: 'outside cycle', status: 'done' }), // 不归本周期 → 不列
        ],
      }),
      cycle,
    );
    expect(out).toContain('### cycle M1 — ship auth');
    expect(out).toContain('- status: in_review');
    expect(out).toContain('- tasks: 2/2 done or cancelled');
    expect(out).toContain('- A-1 oauth — done');
    expect(out).toContain('- A-2 token refresh — cancelled');
    expect(out).not.toContain('A-3');
    // 未验收的周期没有完成时间戳，也不渲染那一行。
    expect(out).not.toContain('completed at');
  });

  it('renderCompletionReport 把各周期小结并进按周期汇总段', () => {
    const cycle = { id: 'cycle_1', name: 'M1', status: 'done', goal: 'ship auth', scope: [], taskIds: ['A-1'], createdAt: 1, completedAt: 1_700_000_000_500 };
    const out = renderCompletionReport({
      ...base,
      team: team({ cycles: [cycle], tasks: [taskRecord({ contractId: 'A-1', title: 'oauth', status: 'done' })] }),
      deploys: [],
      promoteAfterHits: undefined,
    });
    expect(out).toContain('## cycles');
    expect(out).toContain('### cycle M1 — ship auth');
    expect(out).toContain('- completed at:');
  });
});