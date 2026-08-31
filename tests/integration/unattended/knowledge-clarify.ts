/**
 * Unattended-operation test: the knowledge loop (review comments written to
 * the contract and captured as lessons, lessons injected into the next task),
 * clarification, and the pre-dispatch gates (forbidden touches, oversized
 * diffs).
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../../../src/service.js';
import { DEFAULT_LEARNINGS } from '../../../src/learnings.js';
import {
  gitTest,
  makeFixture,
  seedTeam,
  testOptions,
  writeContract,
  commitInWorktree,
} from '../../helpers.js';
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

/**
 * 走到达评审门槛的那几步：派发一个契约、提交改动、推到 in_review 并跑门。
 * @returns 任务与 developer / reviewer / leader 三个角色成员
 */
async function taskInReview(service: AutopilotService, teamId: string, contractId: string, file = 'work.ts') {
  await service.tickOnce();
  const team = service.teamView(teamId);
  const task = team.tasks.find((candidate) => candidate.contractId === contractId)!;
  const dev = team.members.find((member) => member.id === task.assigneeId)!;
  const reviewer = team.members.find((member) => member.role === 'reviewer')!;
  const leader = team.members.find((member) => member.role === 'leader')!;
  commitInWorktree(dev.workspacePath, file, 'export const a = 1;\n', 'feat: work');
  await service.updateTask({ taskId: task.id, status: 'in_review' });
  await service.runGatesForTask({ taskId: task.id });
  return { task, dev, reviewer, leader };
}

describe('unattended: knowledge loop, clarification and pre-dispatch gates', () => {
  /** 开启知识回路的覆盖项（默认关闭，所以每个用例要显式打开才有捕获）。 */
  const withLearnings = { learnings: { ...DEFAULT_LEARNINGS, enabled: true } };

  it('request_changes writes the review comments onto the task contract and captures a lesson', async () => {
    const { service, teamId, fixture, cleanup } = await serviceWithContracts(
      'reviewnote',
      [{ id: 'R-1', title: 'needs review', touches: ['app/'] }],
      withLearnings,
    );
    try {
      const { task, reviewer } = await taskInReview(service, teamId, 'R-1');
      const repoPath = service.teamView(teamId).repoPath;
      await service.review({
        taskId: task.id,
        reviewerId: reviewer.id,
        verdict: 'request_changes',
        comments: 'The acceptance criterion mentions a cache; there is none. Add it or drop the claim.',
      });
      // 评审意见必须进任务单：此前这条分支只改内存，接手者永远看不见为什么被打回。
      const contract = await readFile(join(repoPath, '.tasks', 'R-1.md'), 'utf8');
      expect(contract).toContain('[review]');
      expect(contract).toContain('drop the claim');
      expect(contract).toContain('status: changes_requested');
      // 同一轮意见还要成为可注入的教训。
      const learnings = service.teamView(teamId).learnings;
      expect(learnings).toHaveLength(1);
      expect(learnings[0]?.kind).toBe('review-change-request');
      expect(learnings[0]?.domain).toBe('app/');
      expect(learnings[0]?.hits).toBe(1);
      // 台账落在 stateDir，不进目标仓库；下一句断言运行态没有污染用户仓库。
      const ledger = await readFile(join(fixture.stateDir, 'learnings.md'), 'utf8');
      expect(ledger).toContain('自动生成，勿手改');
      expect(ledger).toContain('drop the claim');
      expect(gitTest(['status', '--porcelain'], repoPath)).toBe('');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('a captured lesson is injected into the next task description in the same domain', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts(
      'inject',
      [
        { id: 'I-1', title: 'first', touches: ['server/'] },
        { id: 'I-2', title: 'second', touches: ['server/db/'] },
      ],
      withLearnings,
    );
    try {
      const { task, reviewer } = await taskInReview(service, teamId, 'I-1', 'server/a.ts');
      await service.review({
        taskId: task.id,
        reviewerId: reviewer.id,
        verdict: 'request_changes',
        comments: 'Run db:check-parity before touching server/db schema files.',
      });
      // 注入发生在"派发那一刻"：I-1 被打回后让出域锁，下一拍 I-2 才派得出去，
      // 它的描述里就带上了刚才那条教训。
      await service.tickOnce();
      const second = service.teamView(teamId).tasks.find((candidate) => candidate.contractId === 'I-2');
      expect(second?.status).toBe('in_progress');
      expect(second?.description).toContain('已知教训');
      expect(second?.description).toContain('db:check-parity');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('clarification sends the contract back to the leader without spending a rework round', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts(
      'clarify',
      [{ id: 'C-1', title: 'ambiguous', touches: ['app/'] }],
      withLearnings,
    );
    try {
      await service.tickOnce();
      const team = service.teamView(teamId);
      const task = team.tasks.find((candidate) => candidate.contractId === 'C-1')!;
      const dev = team.members.find((member) => member.id === task.assigneeId)!;
      const leader = team.members.find((member) => member.role === 'leader')!;
      const escalationsBefore = service.escalations.all.length;

      await service.clarifyTask({
        taskId: task.id,
        memberId: dev.id,
        question: 'Should the flag default to on for existing users?',
        ambiguousPoints: ['acceptance says "no migration" but the field is non-nullable'],
        proposedResolutions: ['default off', 'backfill in a second task'],
      });

      const after = service.teamView(teamId);
      const held = after.tasks.find((candidate) => candidate.id === task.id)!;
      expect(held.status).toBe('needs-clarification');
      // 核心诉求：问清楚不是返工，也不该惊动人。
      expect(held.reviewRound).toBe(0);
      expect(service.escalations.all.length).toBe(escalationsBefore);
      const freedDev = after.members.find((member) => member.id === dev.id)!;
      expect(freedDev.status).toBe('idle');
      expect(freedDev.currentTaskId).toBeNull();
      const repoPath = after.repoPath;
      const contract = await readFile(join(repoPath, '.tasks', 'C-1.md'), 'utf8');
      expect(contract).toContain('[needs-clarification]');
      expect(contract).toContain('no migration');
      expect(contract).toContain('status: needs-clarification');

      // 挂起期间循环不得把它当待派发任务重新派出去。
      const idleTick = await service.tickOnce();
      expect(idleTick.dispatched).not.toContain(task.id);

      // developer 自己解锁 = 用"问一句"绕过返工预算，必须挡住。
      await expect(
        service.updateTask({ taskId: task.id, status: 'pending', actorId: dev.id }),
      ).rejects.toThrow(/only leader/);

      await service.updateTask({
        taskId: task.id,
        status: 'pending',
        actorId: leader.id,
        note: 'Decision: default off for existing users; backfill is a separate contract.',
      });
      const answered = await readFile(join(repoPath, '.tasks', 'C-1.md'), 'utf8');
      expect(answered).toContain('[clarify-answer]');
      expect(answered).toContain('default off for existing users');
      expect(answered).toContain('status: pending');
      // 答案落地后下一拍应当被重新派发。
      const redispatch = await service.tickOnce();
      expect(redispatch.dispatched).toContain(task.id);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('rejects touches that overlap the contract’s own forbidden zone on both dispatch paths', async () => {
    // 工具驱动路径：leader 直接 task_assign 时抛错，不建分支也不占工作区。
    const direct = await serviceWithContracts('forbiddendir', [{ id: 'F-1', title: 'x', touches: ['app/'] }]);
    try {
      const team = direct.service.teamView(direct.teamId);
      const dev = team.members.find((member) => member.role === 'developer')!;
      await writeContract(join(team.repoPath, '.tasks', 'F-2.md'), {
        id: 'F-2',
        title: 'self-contradictory',
        touches: ['app/'],
        forbidden: ['app/server/'],
      });
      gitTest(['add', '-A'], team.repoPath);
      gitTest(['commit', '-m', 'tasks: add F-2'], team.repoPath);
      await expect(
        direct.service.assignTask({ teamId: direct.teamId, title: 'x', assigneeId: dev.id, contractId: 'F-2' }),
      ).rejects.toThrow(/declares forbidden: app\//);
    } finally {
      await direct.cleanup();
    }

    // 循环驱动路径：契约文件里就写着违规 touches → 升级并跳过派发。
    const { service, teamId, cleanup } = await serviceWithContracts('forbiddeloop', [
      { id: 'F-3', title: 'overlaps', touches: ['.github/'], forbidden: ['.github/'] },
    ]);
    try {
      const tick = await service.tickOnce();
      expect(tick.dispatched).toHaveLength(0);
      expect(tick.escalated.length).toBe(1);
      const record = service.escalations.all.find((candidate) => candidate.reason === 'forbidden-paths');
      expect(record?.message).toContain('forbidden');
      expect(record?.message).toContain('.github/');
      expect(service.teamView(teamId).tasks.find((task) => task.contractId === 'F-3')?.status).toBe('needs-human');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('refuses to approve an oversized change only when the diff gate is configured', async () => {
    const body = `${'export const row = 1;\n'.repeat(40)}`;
    const strict = await serviceWithContracts('diffgate', [{ id: 'G-1', title: 'big', touches: ['app/'] }], {
      daemon: { maxReviewRounds: 3, stuckMinutes: 45, pollIntervalSeconds: 1, maxDiffLines: 10 },
    });
    try {
      const { task, dev, reviewer } = await taskInReview(strict.service, strict.teamId, 'G-1');
      commitInWorktree(dev.workspacePath, 'app/big.ts', body, 'feat: too big at once');
      await strict.service.runGatesForTask({ taskId: task.id });
      await expect(
        strict.service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve', comments: 'lgtm' }),
      ).rejects.toThrow(/changed lines \(limit 10\)/);
      const record = strict.service.escalations.all.find((candidate) => candidate.reason === 'change-too-large');
      expect(record?.message).toContain('limit 10');
      // 拒绝 approve 之后任务必须还停在评审台上，而不是被静默合入。
      expect(strict.service.teamView(strict.teamId).tasks.find((candidate) => candidate.id === task.id)?.status).toBe(
        'needs-human',
      );
    } finally {
      await strict.cleanup();
    }

    // 同一坨改动在默认配置（门关）下照常合入 —— 升级不改变既有团队行为。
    const { service, teamId, cleanup } = await serviceWithContracts('diffopen', [
      { id: 'G-2', title: 'big', touches: ['app/'] },
    ]);
    try {
      const { task, dev, reviewer } = await taskInReview(service, teamId, 'G-2');
      commitInWorktree(dev.workspacePath, 'app/big.ts', body, 'feat: big but allowed');
      await service.runGatesForTask({ taskId: task.id });
      const verdict = await service.review({
        taskId: task.id,
        reviewerId: reviewer.id,
        verdict: 'approve',
        comments: 'lgtm',
      });
      expect(verdict.merged).toBe(true);
    } finally {
      await cleanup();
    }
  }, 60_000);
});