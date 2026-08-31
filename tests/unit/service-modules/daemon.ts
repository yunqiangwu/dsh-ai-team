/**
 * service/daemon.ts 的纯函数单测：守护循环的纯判定层。
 */
import { describe, expect, it } from 'vitest';
import { budgetExceeded, reviewRoundsExceeded, taskStuck } from '../../../src/service/daemon.js';
import type { TaskRecord } from '../../../src/service/state.js';

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