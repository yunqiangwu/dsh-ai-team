/**
 * Unattended-operation test: completion semantics — all tasks done produces
 * the completed report and stops the loop, loop controls are safe, and a
 * cancelled task does not block a completed run.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../../../src/service.js';
import { makeFixture, seedTeam, testOptions, commitInWorktree } from '../../helpers.js';
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

describe('unattended: daemon loop', () => {
  it('completion: all tasks done → completed report + loop stops', async () => {
    const { service, teamId, fixture, cleanup } = await serviceWithContracts('complete', [
      { id: 'D-1', title: 'last one' },
    ]);
    try {
      await service.tickOnce();
      const team = service.teamView(teamId);
      const task = team.tasks[0]!;
      const dev = team.members.find((member) => member.id === task.assigneeId);
      const reviewer = team.members.find((member) => member.role === 'reviewer');
      commitInWorktree(dev!.workspacePath, 'done.ts', 'export {};\n', 'feat: done');
      await service.updateTask({ taskId: task.id, status: 'in_review' });
      await service.runGatesForTask({ taskId: task.id });
      await service.review({ taskId: task.id, reviewerId: reviewer!.id, verdict: 'approve' });
      const tick = await service.tickOnce();
      expect(tick.completed).toBe(true);
      expect(service.getLoopState()).toBe('completed');
      const report = await readFile(join(fixture.stateDir, 'completion.md'), 'utf8');
      expect(report).toContain('D-1');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('loop controls: start is idempotent, pause/resume/stop land safely', async () => {
    const { service, cleanup } = await serviceWithContracts('loopctl', [{ id: 'L-1', title: 'loop' }]);
    try {
      const started = await service.startLoop();
      expect(started.loopState).toBe('running');
      // Idempotent: second call does not spawn a second loop.
      const again = await service.startLoop();
      expect(again.loopState).toBe('running');
      expect(service.pauseLoop()).toBe('paused');
      expect(service.resumeLoop()).toBe('running');
      await service.stopLoop();
      expect(service.getLoopState()).toBe('stopped');
    } finally {
      await cleanup();
    }
  }, 60_000);
});

describe('unattended: 需求变更与重规划（M3 / INT-4）', () => {
  it('场景一补充：已废弃的任务不挡完成报告 —— done + cancelled 即收尾', async () => {
    const { service, teamId, fixture, cleanup } = await serviceWithContracts('m3-complete', [
      { id: 'T-1', title: 'real work', touches: ['t1/'] },
      { id: 'T-2', title: 'dropped work', dependsOn: ['T-1'], touches: ['t2/'] },
    ]);
    try {
      await service.tickOnce(); // T-1 派发；T-2 等前置，保持 pending
      await service.taskCancel({ taskId: service.teamView(teamId).tasks.find((task) => task.contractId === 'T-2')!.id });
      const view = service.teamView(teamId);
      const task = view.tasks.find((candidate) => candidate.contractId === 'T-1')!;
      const dev = view.members.find((member) => member.id === task.assigneeId)!;
      const reviewer = view.members.find((member) => member.role === 'reviewer')!;
      commitInWorktree(dev.workspacePath, 't1/index.ts', 'export {};\n', 'feat: t1');
      await service.updateTask({ taskId: task.id, status: 'in_review' });
      await service.runGatesForTask({ taskId: task.id });
      await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' });

      const tick = await service.tickOnce();
      expect(tick.completed).toBe(true);
      const report = await readFile(join(fixture.stateDir, 'completion.md'), 'utf8');
      expect(report).toContain('T-1');
    } finally {
      await cleanup();
    }
  }, 60_000);
});