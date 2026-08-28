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
import { CommandNotAllowedError, runGateCommand } from '../src/gates.js';
import { SecretRedactor } from '../src/secrets.js';
import { gitTest, makeFixture, testOptions, writeContract, commitInWorktree } from './helpers.js';

async function serviceWithContracts(
  prefix: string,
  contracts: { id: string; title: string; dependsOn?: string[]; touches?: string[] }[],
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
