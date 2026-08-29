/**
 * Unattended-operation test: daemon loop branches (crash recovery, dispatch
 * with dependency + domain locks, stuck detection, review-round ceiling,
 * needs-human triage, completion) and the security hard rules (secret
 * redaction, command allowlist).
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../src/service.js';
import { autopilotProjectionSchema } from '../src/projection.js';
import { CommandNotAllowedError, runGateCommand } from '../src/gates.js';
import { SecretRedactor } from '../src/secrets.js';
import { DEFAULT_LEARNINGS } from '../src/learnings.js';
import { gitTest, makeFixture, testOptions, writeContract, commitInWorktree } from './helpers.js';

async function serviceWithContracts(
  prefix: string,
  contracts: { id: string; title: string; dependsOn?: string[]; touches?: string[]; forbidden?: string[] }[],
  overrides: Parameters<typeof testOptions>[1] = {},
): Promise<{ service: AutopilotService; teamId: string; cleanup: () => Promise<void> }> {
  const fixture = await makeFixture(prefix);
  const service = await AutopilotService.create(testOptions(fixture, overrides));
  const team = await service.createTeam({ name: `${prefix}-team` });
  for (const contract of contracts) {
    await writeContract(join(team.repoPath, '.tasks', `${contract.id}.md`), contract);
  }
  gitTest(['add', '-A'], team.repoPath);
  gitTest(['commit', '-m', 'tasks: seed contracts'], team.repoPath);
  await service.addMember({ teamId: team.id, role: 'developer' });
  await service.addMember({ teamId: team.id, role: 'developer' });
  await service.addMember({ teamId: team.id, role: 'reviewer' });
  return {
    service,
    teamId: team.id,
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

describe('unattended: daemon loop', () => {
  it('dispatches pending contracts respecting depends_on and domain locks', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('dispatch', [
      { id: 'CORE-1', title: 'core', touches: ['server/core/'] },
      { id: 'CORE-2', title: 'core extension', dependsOn: ['CORE-1'], touches: ['server/core/ext/'] },
      { id: 'FE-1', title: 'ui', touches: ['app/'] },
    ]);
    try {
      const tick1 = await service.tickOnce();
      // CORE-1 and FE-1 dispatched (disjoint domains, deps satisfied);
      // CORE-2 waits on CORE-1.
      expect(tick1.dispatched).toHaveLength(2);
      const team = service.teamView(teamId);
      const core2 = team.tasks.find((task) => task.contractId === 'CORE-2');
      expect(core2?.status).toBe('pending');
      // The two dispatched tasks sit with the two idle developers.
      const busyDevs = team.members.filter((member) => member.role === 'developer' && member.status === 'working');
      expect(busyDevs).toHaveLength(2);

      // Finish CORE-1 through the gated review flow.
      const core1 = team.tasks.find((task) => task.contractId === 'CORE-1');
      expect(core1).toBeDefined();
      const dev = team.members.find((member) => member.id === core1?.assigneeId);
      const reviewer = team.members.find((member) => member.role === 'reviewer');
      commitInWorktree(dev!.workspacePath, 'server/core/index.ts', 'export {};\n', 'feat: core');
      await service.updateTask({ taskId: core1!.id, status: 'in_review' });
      await service.runGatesForTask({ taskId: core1!.id });
      await service.review({ taskId: core1!.id, reviewerId: reviewer!.id, verdict: 'approve' });

      // Next tick: CORE-2's dependency is done → dispatched to the freed dev.
      const tick2 = await service.tickOnce();
      expect(tick2.dispatched).toContain(core2?.id ?? 'CORE-2');
      const after = service.teamView(teamId);
      expect(after.tasks.find((task) => task.contractId === 'CORE-2')?.status).toBe('in_progress');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('domain lock blocks overlapping touches', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('domainlock', [
      { id: 'A-1', title: 'first', touches: ['server/db/'] },
      { id: 'A-2', title: 'overlapping', touches: ['server/db/schema/'] },
    ]);
    try {
      const tick = await service.tickOnce();
      expect(tick.dispatched).toHaveLength(1);
      const team = service.teamView(teamId);
      const locked = team.tasks.find((task) => task.status === 'pending');
      expect(locked?.contractId).toBe('A-2');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('stuck tasks escalate and pause at task granularity', async () => {
    const { service, cleanup } = await serviceWithContracts(
      'stuck',
      [{ id: 'S-1', title: 'will stall' }],
      { daemon: { heartbeatSeconds: 1, maxReviewRounds: 3, stuckMinutes: 0, pollIntervalSeconds: 1 } },
    );
    try {
      const tick1 = await service.tickOnce(); // dispatch S-1
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      const tick2 = await service.tickOnce(); // stuckMinutes: 0 → immediately stale
      // stuckMinutes: 0 makes the task stale the moment it is dispatched, so
      // the escalation lands on the dispatch tick or the next one.
      expect(tick1.escalated.length + tick2.escalated.length).toBeGreaterThan(0);
      expect(
        service.escalations.all.some((record) => record.reason === 'task-stuck'),
      ).toBe(true);
      // pauseOnEscalation: task → loop itself stays runnable.
      expect(service.getLoopState()).not.toBe('escalated');
      const projection = service.projection();
      expect(projection.blocked.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('review-round ceiling escalates after maxReviewRounds', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts(
      'rounds',
      [{ id: 'R-1', title: 'rework-prone' }],
      { daemon: { heartbeatSeconds: 1, maxReviewRounds: 2, stuckMinutes: 45, pollIntervalSeconds: 1 } },
    );
    try {
      await service.tickOnce(); // dispatch
      const team = service.teamView(teamId);
      const task = team.tasks.find((candidate) => candidate.contractId === 'R-1');
      const reviewer = team.members.find((member) => member.role === 'reviewer');
      // Two rounds of request_changes hit the ceiling of 2.
      await service.updateTask({ taskId: task!.id, status: 'in_review' });
      await service.review({ taskId: task!.id, reviewerId: reviewer!.id, verdict: 'request_changes', comments: 'fix' });
      await service.updateTask({ taskId: task!.id, status: 'in_review' });
      await service.review({ taskId: task!.id, reviewerId: reviewer!.id, verdict: 'request_changes', comments: 'again' });
      const tick = await service.tickOnce();
      expect(tick.escalated).toContain(task!.id);
      expect(
        service.escalations.all.some((record) => record.reason === 'review-rounds-exceeded'),
      ).toBe(true);
      expect(service.teamView(teamId).tasks.find((candidate) => candidate.contractId === 'R-1')?.status).toBe(
        'needs-human',
      );
    } finally {
      await cleanup();
    }
  }, 60_000);

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
      const { patchTaskContract } = await import('../src/team.js');
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

  it('completion: all tasks done → completed report + loop stops', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('complete', [{ id: 'D-1', title: 'last one' }]);
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
      const report = await readFile(join(team.repoPath, '.tasks', '_completion.md'), 'utf8');
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

describe('unattended: knowledge loop, clarification and pre-dispatch gates', () => {
  /** 开启知识回路的覆盖项（默认关闭，所以每个用例要显式打开才有捕获）。 */
  const withLearnings = { learnings: { ...DEFAULT_LEARNINGS, enabled: true } };

  it('request_changes writes the review comments onto the task contract and captures a lesson', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts(
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
      // 生成物落盘并随 .tasks/ 一起提交（集成检出保持干净）。
      const ledger = await readFile(join(repoPath, '.tasks', '_learnings.md'), 'utf8');
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
      daemon: { heartbeatSeconds: 1, maxReviewRounds: 3, stuckMinutes: 45, pollIntervalSeconds: 1, maxDiffLines: 10 },
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

  it('does not deploy when the base branch only advanced on .tasks/ commits', async () => {
    let healthChecks = 0;
    const countingFetch = (async () => {
      healthChecks += 1;
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const { service, teamId, cleanup } = await serviceWithContracts('deployskip', [{ id: 'P-1', title: 'one', touches: ['app/'] }], {
      deploy: { enabled: true, command: 'git --version', healthCheckUrl: 'http://health.local/check', secretsEnv: [] },
      fetchFn: countingFetch,
      ...withLearnings,
    });
    try {
      const { task, reviewer } = await taskInReview(service, teamId, 'P-1');
      await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' });
      await service.tickOnce();
      // 基线：代码合入 base 之后确实部署过（首拍没有历史基线可比对，必然部署一次）。
      const afterCode = service.projection().deploys.length;
      expect(afterCode).toBeGreaterThan(0);
      expect(healthChecks).toBeGreaterThan(0);

      // 接下来只有知识台账推进了 base —— 不含任何代码，不该再部署一次。
      healthChecks = 0;
      await service.learningRecord({ taskId: task.id, kind: 'manual', summary: 'a lesson worth keeping', touches: ['app/'] });
      await service.tickOnce();
      await service.tickOnce();
      expect(service.projection().deploys.length).toBe(afterCode);
      expect(healthChecks).toBe(0);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('the real projection survives the zod viewSchema with nothing stripped', async () => {
    // projection.ts 的 schema 与 view.ts 类型没有任何编译期对齐，且 z.object 会
    // 静默剥掉未声明的键：漏写字段不会报错，只会让面板永远拿不到那个值。
    // 所以这里喂一份含三样新东西的真实快照，并要求 parse 结果与原值全等。
    const { service, teamId, cleanup } = await serviceWithContracts(
      'projectionshape',
      [{ id: 'X-1', title: 'shape', touches: ['app/'] }],
      withLearnings,
    );
    try {
      await service.tickOnce();
      const team = service.teamView(teamId);
      const task = team.tasks.find((candidate) => candidate.contractId === 'X-1')!;
      const dev = team.members.find((member) => member.id === task.assigneeId)!;
      await service.clarifyTask({ taskId: task.id, memberId: dev.id, question: 'which default?' });
      await service.escalateTask({
        taskId: null, // 团队级：否则 needs-human 会覆盖掉要考察的 needs-clarification 形状
        reason: 'change-too-large',
        message: 'oversized on purpose',
        suggestion: 'split it',
      });
      await service.learningRecord({ taskId: task.id, kind: 'manual', summary: 'a shape-checking lesson', touches: ['app/'] });

      const snapshot = service.projection();
      const parsed = autopilotProjectionSchema.parse(snapshot);
      expect(parsed).toEqual(snapshot);
      const after = service.teamView(teamId);
      expect(after.tasks.find((candidate) => candidate.id === task.id)?.status).toBe('needs-clarification');
      expect(after.learnings.map((learning) => learning.summary)).toContain('a shape-checking lesson');
      expect(parsed.escalations.some((record) => record.reason === 'change-too-large')).toBe(true);
      expect(parsed.blocked).toContain(task.id);
    } finally {
      await cleanup();
    }
  }, 60_000);
});

describe('unattended: security hard rules', () => {
  it('command allowlist rejects non-allowlisted gate commands', async () => {
    const fixture = await makeFixture('allowlist');
    const redactor = new SecretRedactor();
    await expect(
      runGateCommand('rm -rf /', {
        cwd: fixture.root,
        commands: [],
        allowlist: ['git', 'pnpm'],
        timeoutMs: 5000,
        redactor,
        taskId: 't',
        branch: 'b',
      }),
    ).rejects.toThrow(CommandNotAllowedError);
    // Allowlisted prefix passes and captures output.
    const result = await runGateCommand('git --version', {
      cwd: fixture.root,
      commands: [],
      allowlist: ['git', 'pnpm'],
      timeoutMs: 5000,
      redactor,
      taskId: 't',
      branch: 'b',
    });
    expect(result.passed).toBe(true);
    expect(result.logTail).toContain('git version');
  });

  it('secrets never survive into logs (redaction)', async () => {
    process.env['AUTOPILOT_TEST_SECRET'] = 'super-secret-token-value';
    try {
      const fixture = await makeFixture('redact');
      const redactor = new SecretRedactor();
      redactor.registerEnvNames(['AUTOPILOT_TEST_SECRET']);
      const result = await runGateCommand('echo "token is $AUTOPILOT_TEST_SECRET"', {
        cwd: fixture.root,
        commands: [],
        allowlist: ['echo', 'sh', 'git'],
        timeoutMs: 5000,
        redactor,
        taskId: 't',
        branch: 'b',
      });
      expect(result.logTail).not.toContain('super-secret-token-value');
      expect(result.logTail).toContain('***');
    } finally {
      delete process.env['AUTOPILOT_TEST_SECRET'];
    }
  });

  it('escalation webhook payload is redacted and delivery failure is data', async () => {
    process.env['AUTOPILOT_TEST_WEBHOOK'] = 'http://webhook.local/notify';
    process.env['AUTOPILOT_TEST_SECRET2'] = 'another-secret-value';
    try {
      const fixture = await makeFixture('webhook');
      const bodies: string[] = [];
      const fetchFn = ((url: string, init?: RequestInit) => {
        expect(url).toBe('http://webhook.local/notify');
        bodies.push(String(init?.body ?? ''));
        return Promise.resolve(new Response('ok', { status: 200 }));
      }) as typeof fetch;
      const service = await AutopilotService.create(
        testOptions(fixture, {
          escalation: { webhookUrlEnv: 'AUTOPILOT_TEST_WEBHOOK', label: 'needs-human', pauseOnEscalation: 'task' },
          fetchFn,
        }),
      );
      try {
        service.redactor.register('another-secret-value');
        const record = await service.escalateTask({
          taskId: null,
          reason: 'manual',
          message: 'leaking another-secret-value here',
          suggestion: 'rotate keys',
        });
        expect(record.webhookDelivered).toBe(true);
        expect(record.message).not.toContain('another-secret-value');
        expect(bodies[0]).not.toContain('another-secret-value');
      } finally {
        await service.dispose();
      }
    } finally {
      delete process.env['AUTOPILOT_TEST_WEBHOOK'];
      delete process.env['AUTOPILOT_TEST_SECRET2'];
    }
  });

  it('force-push to shared branches is refused (force-with-lease only for task branches)', async () => {
    const { pushBranch } = await import('../src/git.js');
    const fixture = await makeFixture('forcepush');
    await expect(
      pushBranch(fixture.remotePath, 'main', { forceWithLease: true }),
    ).rejects.toThrow(/force-push/);
  });
});
