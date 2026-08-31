/**
 * Unattended-operation test: runtime artifacts (learnings ledger, completion
 * report, regenerated _board.md) stay out of the target repo.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../../../src/service.js';
import { DEFAULT_LEARNINGS } from '../../../src/learnings.js';
import { gitTest, makeFixture, seedTeam, testOptions, commitInWorktree } from '../../helpers.js';
import type { Fixture, SeedContract } from '../../helpers.js';

async function serviceWithContracts(
  prefix: string,
  contracts: SeedContract[],
  overrides: Parameters<typeof testOptions>[1] = {},
): Promise<{ service: AutopilotService; teamId: string; fixture: Fixture; cleanup: () => Promise<void> }> {
  const fixture = await makeFixture(prefix);
  const service = await AutopilotService.create(testOptions(fixture, overrides));
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

describe('unattended: 运行态产物不入库', () => {
  it('learnings land under stateDir, never committed into the target repo', async () => {
    const { service, teamId, fixture, cleanup } = await serviceWithContracts(
      'learn-artifact',
      [{ id: 'L-1', title: 'lesson source', touches: ['server/'] }],
      { learnings: { ...DEFAULT_LEARNINGS, enabled: true } },
    );
    try {
      await service.learningRecord({ teamId, kind: 'manual', summary: 'a reusable pitfall', touches: ['server/'] });
      const repoPath = service.teamView(teamId).repoPath;
      // 目标仓库里既不该出现这个文件，也不该出现为它而做的提交。
      await expect(readFile(join(repoPath, '.tasks', '_learnings.md'), 'utf8')).rejects.toThrow(/ENOENT/);
      expect(gitTest(['log', '--format=%s', 'main'], repoPath)).not.toContain('learnings');
      expect(gitTest(['status', '--porcelain'], repoPath)).toBe('');
      // 真相源在 state.json，给人看的便利视图就落在同一个目录。
      const ledger = await readFile(join(fixture.stateDir, 'learnings.md'), 'utf8');
      expect(ledger).toContain('a reusable pitfall');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('the completion report is written to stateDir, not into the repo', async () => {
    const { service, teamId, fixture, cleanup } = await serviceWithContracts('completion-artifact', [
      { id: 'D-1', title: 'the only task' },
    ]);
    const repoPath = service.teamView(teamId).repoPath;
    try {
      await service.tickOnce();
      const team = service.teamView(teamId);
      const task = team.tasks.find((candidate) => candidate.contractId === 'D-1')!;
      const dev = team.members.find((member) => member.id === task.assigneeId)!;
      const reviewer = team.members.find((member) => member.role === 'reviewer')!;
      commitInWorktree(dev.workspacePath, 'work.ts', 'export const a = 1;\n', 'feat: work');
      await service.updateTask({ taskId: task.id, status: 'in_review' });
      await service.runGatesForTask({ taskId: task.id });
      await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' });
      const tick = await service.tickOnce();
      expect(tick.completed).toBe(true);

      await expect(readFile(join(repoPath, '.tasks', '_completion.md'), 'utf8')).rejects.toThrow(/ENOENT/);
      expect(gitTest(['log', '--format=%s', 'main'], repoPath)).not.toContain('completion report');
      const report = await readFile(join(fixture.stateDir, 'completion.md'), 'utf8');
      expect(report).toContain('# Autopilot completion report');
      expect(report).toContain('D-1');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('_board.md is byte-stable so regenerating it does not dirty the worktree', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('board-stable', [
      { id: 'B-1', title: 'a contract', touches: ['app/'] },
    ]);
    const repoPath = service.teamView(teamId).repoPath;
    try {
      await service.tickOnce();
      const first = await readFile(join(repoPath, '.tasks', '_board.md'), 'utf8');
      // 再来一拍：状态没有任何变化，看板必须逐字节不变。
      await service.tickOnce();
      const second = await readFile(join(repoPath, '.tasks', '_board.md'), 'utf8');
      expect(second).toBe(first);
      expect(first).not.toMatch(/regenerated at/);
      // 看板仍然如实反映契约
      expect(first).toContain('B-1');
    } finally {
      await cleanup();
    }
  }, 60_000);
});