/**
 * service/views.ts 的纯函数单测：视图投影纯映射。
 */
import { describe, expect, it } from 'vitest';
import { memberView as memberViewOf, cycleView as cycleViewOf, taskView as taskViewOf } from '../../../src/service/views.js';
import type { MemberRecord, TaskRecord, TeamRecord } from '../../../src/service/state.js';

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

  it('cycleView 把记录侧可选时间折算成视图侧 null（不丢字段、不复制引用）', () => {
    const view = cycleViewOf({
      id: 'cycle_1',
      name: 'M1',
      status: 'planned',
      goal: '首期目标',
      scope: ['app/'],
      taskIds: ['M1-1'],
      createdAt: 123,
    });
    expect(view).toEqual({
      id: 'cycle_1',
      name: 'M1',
      status: 'planned',
      goal: '首期目标',
      scope: ['app/'],
      taskIds: ['M1-1'],
      startedAt: null,
      completedAt: null,
      createdAt: 123,
    });
    // 拷贝数组：改原记录不会透过投影污染视图。
    const withTimes = cycleViewOf({
      id: 'cycle_2',
      name: 'M2',
      status: 'done',
      goal: '',
      scope: ['server/'],
      taskIds: [],
      startedAt: 1,
      completedAt: 2,
      createdAt: 0,
    });
    expect(withTimes.startedAt).toBe(1);
    expect(withTimes.completedAt).toBe(2);
  });
});