/**
 * Unattended-operation test: crash recovery — state reload resurfaces
 * in_progress tasks, tasks stay bound to their assignee, and a corrupt
 * state.json is preserved on disk instead of being overwritten.
 */
import { describe, expect, it } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../../../src/service.js';
import { gitTest, makeFixture, testOptions, writeContract } from '../../helpers.js';

describe('unattended: daemon loop', () => {
  it('crash recovery: state reload + in_progress tasks resurface on first tick', async () => {
    const fixture = await makeFixture('recovery');
    const options = testOptions(fixture);
    const first = await AutopilotService.create(options);
    const team = await first.createTeam({ name: 'recovery-team' });
    await writeContract(join(team.repoPath, '.tasks', 'C-1.md'), { id: 'C-1', title: 'crash me' });
    gitTest(['add', '-A'], team.repoPath);
    gitTest(['commit', '-m', 'tasks: C-1'], team.repoPath);
    await first.addMember({ teamId: team.id, role: 'developer' });
    await first.tickOnce(); // dispatch C-1
    expect(first.teamView(team.id).tasks[0]?.status).toBe('in_progress');
    // Simulate a host crash: the daemon was running, state was flushed by the
    // debounced persist, but dispose() never ran.
    await first.startLoop();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    first.pauseLoop(); // quiesce the loop without a clean shutdown
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));

    const second = await AutopilotService.create(options);
    try {
      // State restored; a crashed run's loop drops to paused.
      expect(second.getLoopState()).toBe('paused');
      const tick = await second.tickOnce();
      expect(tick.recovered.length).toBeGreaterThan(0);
      const restored = second.teamView(team.id);
      expect(restored.tasks[0]?.contractId).toBe('C-1');
      expect(restored.members.length).toBe(2);
    } finally {
      await second.dispose();
      await first.dispose();
    }
  }, 60_000);

  it('crash recovery keeps the task bound to its assignee, then converges via stuck', async () => {
    const fixture = await makeFixture('recoverbound');
    const options = testOptions(fixture);
    const first = await AutopilotService.create(options);
    const team = await first.createTeam({ name: 'recoverbound-team' });
    await writeContract(join(team.repoPath, '.tasks', 'K-1.md'), { id: 'K-1', title: 'crash mid work' });
    gitTest(['add', '-A'], team.repoPath);
    gitTest(['commit', '-m', 'tasks: K-1'], team.repoPath);
    const dev = await first.addMember({ teamId: team.id, role: 'developer' });
    await first.tickOnce(); // dispatch K-1
    const taskId = first.teamView(team.id).tasks[0]!.id;
    // 落盘是 100ms 防抖的；这里刻意不调 dispose —— 要模拟的就是没有干净关闭的崩溃。
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));

    // 重载一份状态：崩溃恢复刻意**不**把任务抢回 pending —— 那样会把同一个任务
    // 分支二次派给别的开发者。它该由 stuck 检测收敛。
    const second = await AutopilotService.create(
      testOptions(fixture, { daemon: { ...options.daemon, stuckMinutes: 0 } }),
    );
    try {
      expect(second.getLoopState()).toBe('stopped');
      const stillBound = second.teamView(team.id);
      expect(stillBound.tasks[0]?.status).toBe('in_progress');
      expect(stillBound.tasks[0]?.assigneeId).toBe(dev.id);
      expect(stillBound.members.find((m) => m.id === dev.id)?.currentTaskId).toBe(taskId);

      const tick = await second.tickOnce();
      expect(tick.escalated).toContain(taskId);
      expect(second.teamView(team.id).tasks[0]?.status).toBe('needs-human');
      expect(second.escalations.all.some((record) => record.reason === 'task-stuck')).toBe(true);
    } finally {
      await second.dispose();
      await first.dispose();
    }
  }, 60_000);

  it('a corrupt state.json is preserved on disk instead of silently dropping every team', async () => {
    const fixture = await makeFixture('corruptstate');
    const garbage = '{"version": 1, "teams": [  // truncated by a power loss\n';
    await writeFile(join(fixture.stateDir, 'state.json'), garbage, 'utf8');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      // 插件仍可启动（不能把宿主带崩），但坏文件必须留在磁盘上可查可恢复。
      const leftovers = (await readdir(fixture.stateDir)).filter((name) => name.startsWith('state.json.corrupt-'));
      expect(leftovers.length).toBe(1);
      expect(await readFile(join(fixture.stateDir, leftovers[0]!), 'utf8')).toBe(garbage);
    } finally {
      await service.dispose();
    }
  }, 60_000);
});