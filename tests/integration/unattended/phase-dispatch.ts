/**
 * Unattended-operation test: team phases (persistence, dispatch gating,
 * assignTask takeover), replanning dispatch parity, out-of-band workbench
 * snapshots, and bad-contract isolation (INT-1).
 */
import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../../../src/service.js';
import { gitTest, makeFixture, seedTeam, testOptions } from '../../helpers.js';
import type { Fixture, SeedContract } from '../../helpers.js';

async function serviceWithContracts(
  prefix: string,
  contracts: SeedContract[],
): Promise<{ service: AutopilotService; teamId: string; fixture: Fixture; cleanup: () => Promise<void> }> {
  const fixture = await makeFixture(prefix);
  const service = await AutopilotService.create(testOptions(fixture));
  const team = await seedTeam(service, {
    name: `${prefix}-team`,
    contracts,
    members: [{ role: 'developer' }, { role: 'developer' }, { role: 'reviewer' }],
  });
  return {
    service,
    teamId: team.id,
    fixture,
    cleanup: async () => {
      await service.dispose();
    },
  };
}

describe('unattended: 团队阶段、依赖死锁与带外快照（INT-1）', () => {
  it('phase 是持久化维度：落盘、重启后保持，老 state.json 缺字段时兜底 developing', async () => {
    const fixture = await makeFixture('phase-persist');
    const options = testOptions(fixture);
    const first = await AutopilotService.create(options);
    const team = await first.createTeam({ name: 'phase-team' });
    const teamId = team.id;
    // 新建团队默认 developing —— 升级插件不能改变既有"init → 加成员 → run"的用法。
    expect(first.teamView(teamId).phase).toBe('developing');
    first.setPhase({ teamId, phase: 'intake' });
    expect(first.teamView(teamId).phase).toBe('intake');
    await first.dispose();

    const statePath = join(fixture.stateDir, 'state.json');
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { teams: { phase?: string }[] };
    expect(persisted.teams[0]?.phase).toBe('intake');

    // 模拟 v6 之前落盘的老状态：整个键都不存在，读取处必须兜底而不是冻住团队。
    delete persisted.teams[0]?.phase;
    await writeFile(statePath, JSON.stringify(persisted), 'utf8');
    const second = await AutopilotService.create(options);
    try {
      expect(second.teamView(teamId).phase).toBe('developing');
    } finally {
      await second.dispose();
    }
  }, 60_000);

  it('阶段门：intake / 待批 / 搭骨架 一律不派发，切回 developing 后同样的契约照常派发', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('phase-gate', [
      { id: 'P-1', title: 'first', touches: ['alpha/'] },
      { id: 'P-2', title: 'second', touches: ['beta/'] },
    ]);
    try {
      for (const phase of ['intake', 'kickoff_pending_approval', 'scaffolding'] as const) {
        service.setPhase({ teamId, phase });
        const report = await service.tickOnce();
        const view = service.teamView(teamId);
        expect(report.dispatched).toEqual([]);
        expect(view.phase).toBe(phase);
        // 契约照常收养（否则人看不出循环是"在等审批"还是"根本没看见契约"）
        expect(view.tasks.map((task) => task.status)).toEqual(['pending', 'pending']);
        expect(view.members.filter((member) => member.role === 'developer').map((member) => member.status))
          .toEqual(['idle', 'idle']);
      }
      service.setPhase({ teamId, phase: 'developing' });
      const report = await service.tickOnce();
      expect(report.dispatched).toHaveLength(2);
      expect(service.teamView(teamId).tasks.map((task) => task.status)).toEqual(['in_progress', 'in_progress']);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('assignTask 接管已被收养的 pending 契约：复用任务点名为指定开发者，而非报 already-on-board', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('assign-takeover', [
      { id: 'TA-1', title: 'whitelist core', touches: ['server/core/'] },
    ]);
    try {
      // intake 阶段：契约被收养为 pending（以 leader 名义占位），dispatch 不派发 → dev 全 idle。
      service.setPhase({ teamId, phase: 'intake' });
      await service.tickOnce();
      const before = service.teamView(teamId);
      const boardTask = before.tasks.find((task) => task.contractId === 'TA-1')!;
      expect(boardTask.status).toBe('pending');
      const dev = before.members.find((member) => member.role === 'developer')!;
      expect(dev.status).toBe('idle');

      // 组长点名派发同一张契约：应"接管"那张待办任务（复用、不新建、不报错）。
      const assigned = await service.assignTask({
        teamId, title: 'whitelist core', assigneeId: dev.id, contractId: 'TA-1',
      });
      const after = service.teamView(teamId);
      const taken = after.tasks.find((task) => task.contractId === 'TA-1')!;
      expect(taken.id).toBe(boardTask.id);            // 复用同一张任务，未新建
      expect(taken.status).toBe('in_progress');
      expect(taken.assigneeId).toBe(dev.id);
      expect(assigned.assigneeId).toBe(dev.id);
      expect(after.members.find((member) => member.id === dev.id)?.status).toBe('working');
      expect(after.metrics.dispatched).toBe(before.metrics.dispatched + 1);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('assignTask 对已被真正负责的契约给出可操作提示而非裸报错', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('assign-owned', [
      { id: 'OW-1', title: 'owned work', touches: ['server/core/'] },
    ]);
    try {
      service.setPhase({ teamId, phase: 'developing' });
      await service.tickOnce(); // 派发给某 dev → in_progress
      const view = service.teamView(teamId);
      const owned = view.tasks.find((task) => task.contractId === 'OW-1')!;
      expect(owned.status).toBe('in_progress');
      const owner = view.members.find((member) => member.id === owned.assigneeId)!;
      const otherDev = view.members.find(
        (member) => member.role === 'developer' && member.id !== owner.id,
      )!;
      await expect(
        service.assignTask({ teamId, title: 'dup', assigneeId: otherDev.id, contractId: 'OW-1' }),
      ).rejects.toThrow(/is already in_progress on the board and is being handled by/);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('replanning 与 developing 同样可派发：两个阶段走的是同一条派发路径', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('phase-replan', [
      { id: 'R-1', title: 'first', touches: ['alpha/'] },
    ]);
    try {
      service.setPhase({ teamId, phase: 'replanning' });
      const report = await service.tickOnce();
      expect(report.dispatched).toHaveLength(1);
      const view = service.teamView(teamId);
      const task = view.tasks[0]!;
      expect(task.status).toBe('in_progress');
      expect(view.members.find((member) => member.id === task.assigneeId)?.role).toBe('developer');
      // 派发真的动了 git：接手者的工作区已经切到任务分支上。
      // （不查 team.branches —— 那份缓存在 createBranch 之前刷新，当拍不含新分支。）
      const assignee = view.members.find((member) => member.id === task.assigneeId)!;
      expect(assignee.branch).toBe(task.branch);
      expect(assignee.currentTaskId).toBe(task.id);
      expect(service.projection().blocked).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('工单答复立刻推一帧快照，快照里就带着答复（不必等下一次工具调用）', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('ticket-publish', [
      { id: 'Q-1', title: 'needs a human', touches: ['q/'] },
    ]);
    try {
      await service.tickOnce();
      const task = service.teamView(teamId).tasks[0]!;
      const record = await service.escalateTask({
        taskId: task.id,
        reason: 'manual',
        message: 'which database?',
        suggestion: 'answer the ticket',
      });
      // 升级本身不是"带外变更"，不该触发发布器 —— 只有落在 session 之外的那条路径才需要。
      let published = 0;
      let answered: string | undefined;
      service.setSnapshotPublisher(() => {
        published += 1;
        answered = service.projection().escalations.find((item) => item.id === record.id)?.notification?.submitted?.decision;
      });
      expect(published).toBe(0);

      const result = await service.submitTicketAnswer(record.id, { decision: '换成 sqlite' });
      expect(result.ok).toBe(true);
      expect(published).toBe(1);
      expect(answered).toBe('换成 sqlite');

      // 注销之后必须彻底安静：插件卸载后 session 可能已经销毁。
      service.setSnapshotPublisher(undefined);
      await service.submitTicketAnswer(record.id, { decision: '再改一次' });
      expect(published).toBe(1);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('坏契约只弄坏它自己：看板不清空、告警只发一次', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('bad-contract', [
      { id: 'G-1', title: 'one', touches: ['g1/'] },
      { id: 'G-2', title: 'two', touches: ['g2/'] },
      { id: 'G-3', title: 'three', touches: ['g3/'] },
    ]);
    const repoPath = service.teamView(teamId).repoPath;
    try {
      // 没有 frontmatter 的文件：以前 parseTaskContract 抛穿会让整块看板消失。
      await writeFile(join(repoPath, '.tasks', 'G-BROKEN.md'), '# 手搓了一半的契约\n', 'utf8');
      gitTest(['add', '-A'], repoPath);
      gitTest(['commit', '-m', 'tasks: add a broken contract'], repoPath);

      const report = await service.tickOnce();
      const rejected = report.events.filter((event) => event.startsWith('contract-rejected:'));
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toContain('G-BROKEN.md');
      // 三个合法契约全部收养，看板没被那个坏文件带走。
      const view = service.teamView(teamId);
      expect(view.tasks.map((task) => task.contractId).toSorted()).toEqual(['G-1', 'G-2', 'G-3']);
      const board = await readFile(join(repoPath, '.tasks', '_board.md'), 'utf8');
      expect(board).toContain('G-1');
      expect(board).toContain('G-3');
      // 坏文件不参与收养，也就不会被当成一个"没有契约"的任务派出去。
      expect(view.tasks.some((task) => task.title.includes('BROKEN'))).toBe(false);

      // 第二拍不得重复告警：events 永远非空会让空闲退避彻底失效。
      const second = await service.tickOnce();
      expect(second.events.filter((event) => event.startsWith('contract-rejected:'))).toEqual([]);
      expect(service.teamView(teamId).tasks).toHaveLength(3);
    } finally {
      await cleanup();
    }
  }, 60_000);
});