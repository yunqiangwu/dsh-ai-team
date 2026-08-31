/**
 * Unattended-operation test: needs-human triage re-opens a task when its
 * contract is edited back to pending, and multi-team escalations carry
 * the owning teamId end-to-end.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../../../src/service.js';
import { autopilotProjectionSchema } from '../../../src/schema.js';
import { makeFixture, seedTeam, testOptions } from '../../helpers.js';
import type { Fixture, SeedContract } from '../../helpers.js';

async function serviceWithContracts(
  prefix: string,
  contracts: SeedContract[],
): Promise<{ service: AutopilotService; teamId: string; cleanup: () => Promise<void> }> {
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
    cleanup: async () => {
      await service.dispose();
    },
  };
}

describe('unattended: daemon loop', () => {
  it('needs-human triage: editing the contract back to pending re-opens the task', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('triage', [{ id: 'T-1', title: 'triage me' }]);
    try {
      await service.tickOnce(); // dispatch
      const team = service.teamView(teamId);
      const task = team.tasks.find((candidate) => candidate.contractId === 'T-1');
      const record = await service.escalateTask({
        taskId: task!.id,
        reason: 'manual',
        message: 'needs clarification',
        suggestion: 'edit the contract, then flip status back to pending',
      });
      expect(service.teamView(teamId).tasks[0]?.status).toBe('needs-human');
      // The contract file carries the label and the note.
      const contractPath = join(team.repoPath, '.tasks', 'T-1.md');
      const labeled = await readFile(contractPath, 'utf8');
      expect(labeled).toContain('needs-human');
      expect(labeled).toContain('needs clarification');

      // Human triage: flip the contract back to pending.
      const { patchTaskContract } = await import('../../../src/team.js');
      await patchTaskContract(contractPath, { status: 'pending', owner: null });
      const tick = await service.tickOnce();
      expect(tick.events.some((event) => event.startsWith('triaged:'))).toBe(true);
      expect(service.escalations.all.find((candidate) => candidate.id === record.id)?.resolvedAt).not.toBeNull();
      // Re-dispatched afterwards.
      expect(service.teamView(teamId).tasks[0]?.status).toBe('in_progress');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('multi-team: escalations carry the owning teamId (TECH-4)', async () => {
    const fixture = await makeFixture('tech4-teams');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      const teamA = await seedTeam(service, {
        name: 'team-a',
        contracts: [{ id: 'A-1', title: 'work in team a' }],
        members: [{ role: 'developer' }],
      });
      const teamB = await seedTeam(service, {
        name: 'team-b',
        contracts: [{ id: 'B-1', title: 'work in team b' }],
        members: [{ role: 'developer' }],
      });
      await service.tickOnce(); // 让两侧契约都同步成任务

      // A：团队级升级，显式传 teamId（service 内部调用点的口径）。
      await service.escalateTask({
        teamId: teamA.id,
        taskId: null,
        reason: 'manual',
        message: 'team-level escalation from a',
        suggestion: 'inspect team a',
      });
      // B：任务级升级，不传 teamId —— escalateTask 按 taskId 反查兜底（工具侧口径）。
      const taskB = service.teamView(teamB.id).tasks.find((candidate) => candidate.contractId === 'B-1');
      expect(taskB).toBeDefined();
      await service.escalateTask({
        taskId: taskB!.id,
        reason: 'manual',
        message: 'task-level escalation from b',
        suggestion: 'inspect team b',
      });

      // 各归各，互不串（§11-4：多团队并行时单团队视图按 teamId 过滤）。
      const fromA = service.escalations.all.find((record) => record.message.includes('from a'));
      const fromB = service.escalations.all.find((record) => record.message.includes('from b'));
      expect(fromA?.teamId).toBe(teamA.id);
      expect(fromB?.teamId).toBe(teamB.id);

      // 投影同样携带（stateVersion 8 的形状契约）。
      const projection = autopilotProjectionSchema.parse(service.projection());
      expect(projection.escalations.find((record) => record.message.includes('from a'))?.teamId).toBe(teamA.id);
      expect(projection.escalations.find((record) => record.message.includes('from b'))?.teamId).toBe(teamB.id);
    } finally {
      await service.dispose();
    }
  }, 60_000);
});