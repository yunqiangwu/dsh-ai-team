/**
 * Unattended-operation test: daemon loop branches (crash recovery, dispatch
 * with dependency + domain locks, stuck detection, review-round ceiling,
 * needs-human triage, completion) and the security hard rules (secret
 * redaction, command allowlist).
 */
import { describe, expect, it } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../src/service.js';
import { autopilotProjectionSchema } from '../src/schema.js';
import { CommandNotAllowedError, runGateCommand } from '../src/gates.js';
import { SecretRedactor } from '../src/secrets.js';
import { DEFAULT_LEARNINGS } from '../src/learnings.js';
import { defaultProfile } from '../src/profile.js';
import { gitTest, makeFixture, seedTeam, testOptions, writeContract, commitInWorktree } from './helpers.js';
import type { Fixture, SeedContract } from './helpers.js';

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
 * 与 serviceWithContracts 同构，但复用调用方的 service：调用方建 service 时已把
 * remote.url 指向自己 fixture 那个本地 bare 仓库，这里只补团队、契约与成员。
 */
async function seedTeamWithContract(
  service: AutopilotService,
  prefix: string,
  contracts: SeedContract[] = [{ id: 'CORE-1', title: 'core', touches: ['server/core/'] }],
): Promise<{ teamId: string; repoPath: string }> {
  const team = await seedTeam(service, {
    name: `${prefix}-team`,
    cloneRemote: true,
    contracts,
    members: [{ role: 'developer' }, { role: 'developer' }, { role: 'reviewer' }],
  });
  return { teamId: team.id, repoPath: team.repoPath };
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

/**
 * approve 被挡住的可观测结果：任务没动，base 上也没长出合并提交。
 * 断言落在结果而非错误文案上 —— 临时目录名里就带着 "ci"，匹配 message 会假通过。
 */
function assertNotMerged(service: AutopilotService, teamId: string, repoPath: string, taskId: string): void {
  expect(service.teamView(teamId).tasks.find((task) => task.id === taskId)?.status).toBe('in_review');
  expect(gitTest(['log', '--format=%s', 'main'], repoPath)).not.toMatch(/^merge: task\//);
}

/** 真实等待：卡死豁免这类断言要越过 daemon.stuckMinutes 的时间窗，没法用假计时器。 */
const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
};

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
      { daemon: { maxReviewRounds: 3, stuckMinutes: 0, pollIntervalSeconds: 1 } },
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

  it('等人回答的任务豁免 stuckMinutes，答完之后才照判（§6.5）', async () => {
    // 0.02 分钟 = 1.2 秒：派发拍绝不会判死，等人期间才越线。
    const { service, teamId, cleanup } = await serviceWithContracts(
      'awaiting',
      [{ id: 'H-1', title: 'asks a human' }],
      { daemon: { maxReviewRounds: 3, stuckMinutes: 0.02, pollIntervalSeconds: 1 } },
    );
    const taskOf = () => service.teamView(teamId).tasks.find((candidate) => candidate.contractId === 'H-1')!;
    try {
      await service.tickOnce(); // 派发 H-1
      const asked = await service.askHuman({
        teamId,
        taskId: taskOf().id,
        title: '跨域阈值按哪个数算',
        questions: [{ name: 'threshold', label: '按契约数还是提交数？', type: 'text', options: [], required: true, defaultValue: '' }],
      });
      await sleep(1400); // 越过一次卡死窗口

      // 窗口已经过了，豁免必须真的挡住它：一次合法的追问不该变成 needs-human、
      // 直方图里的一条计数，更不该喂给模型一条根本不存在的教训。
      expect((await service.tickOnce()).escalated).toEqual([]);
      expect(taskOf().status).toBe('in_progress');
      expect(service.escalations.all.some((record) => record.reason === 'task-stuck')).toBe(false);
      expect(service.teamView(teamId).metrics.escalations['task-stuck']).toBeUndefined();

      const before = taskOf().lastActivityAt;
      const answered = await service.answerQuestionnaire({
        questionnaireId: asked.questionnaire.id,
        answers: { threshold: '按契约数' },
      });
      expect(answered.ok).toBe(true);
      // 答案本身算一次活动：否则人想了 40 分钟，组长一回来任务就被判「40 分钟没动静」。
      expect(taskOf().lastActivityAt).toBeGreaterThanOrEqual(before);

      // 豁免不是免死金牌：答完之后再越线，就该照常升级。
      await sleep(1400);
      const after = await service.tickOnce();
      expect(after.escalated).toContain(taskOf().id);
      expect(service.escalations.all.some((record) => record.reason === 'task-stuck')).toBe(true);
      expect(service.teamView(teamId).metrics.escalations['task-stuck']).toBe(1);
      expect(taskOf().status).toBe('needs-human');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('wall-clock budget escalates a long-running task as budget-exceeded', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts(
      'budget',
      [{ id: 'B-1', title: 'spins forever' }],
      // 1/3_600_000 h = 1 ms：派发后第一个 tick 即超预算（testOptions 直构
      // options，绕过 zod 的 min 约束，所以小数小时合法）。
      { daemon: { maxReviewRounds: 3, stuckMinutes: 45, pollIntervalSeconds: 1, maxTaskHours: 1 / 3_600_000 } },
    );
    try {
      const tick1 = await service.tickOnce(); // dispatch B-1
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      const tick2 = await service.tickOnce();
      // 与 stuck 用例同理：升级落在派发拍或下一拍。
      expect(tick1.escalated.length + tick2.escalated.length).toBeGreaterThan(0);
      expect(
        service.escalations.all.some((record) => record.reason === 'budget-exceeded'),
      ).toBe(true);
      const view = service.teamView(teamId);
      expect(view.tasks[0]?.status).toBe('needs-human');
      // 直方图在 escalateTask 内累加，checkBudget 不重复计。
      expect(view.metrics.escalations['budget-exceeded']).toBe(1);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('run metrics accumulate across the gated review flow', async () => {
    const { service, teamId, fixture, cleanup } = await serviceWithContracts('metrics', [
      { id: 'M-1', title: 'counted' },
    ]);
    try {
      await service.tickOnce(); // dispatch
      let view = service.teamView(teamId);
      expect(view.metrics.dispatched).toBe(1);
      const task = view.tasks[0]!;
      const dev = view.members.find((member) => member.id === task.assigneeId)!;
      const reviewer = view.members.find((member) => member.role === 'reviewer')!;
      commitInWorktree(dev.workspacePath, 'm.ts', 'export {};\n', 'feat: m');
      await service.updateTask({ taskId: task.id, status: 'in_review' });
      await service.runGatesForTask({ taskId: task.id }); // 门第 1 跑（绿）
      await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'request_changes', comments: 'redo' });
      commitInWorktree(dev.workspacePath, 'm.ts', 'export const two = 2;\n', 'feat: m2');
      await service.updateTask({ taskId: task.id, status: 'in_review' });
      await service.runGatesForTask({ taskId: task.id }); // 门第 2 跑
      await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' });

      view = service.teamView(teamId);
      expect(view.metrics).toEqual({
        dispatched: 1,
        completed: 1,
        reviewRounds: 1,
        gateRuns: 2,
        gateFailures: 0,
        deploys: 0,
        rollbacks: 0,
        escalations: {},
      });
      expect(view.tasks[0]?.status).toBe('done');

      // 完成（唯一任务 done → 下一拍写报告），报告里带指标段与耗时行。
      await service.tickOnce();
      const report = await readFile(join(fixture.stateDir, 'completion.md'), 'utf8');
      expect(report).toContain('## run metrics');
      expect(report).toContain('- dispatched 1 / completed 1 / review rounds 1');
      expect(report).toMatch(/- task durations \(dispatch → done\)/);
      expect(report).toContain('M-1:');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('review-round ceiling escalates after maxReviewRounds', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts(
      'rounds',
      [{ id: 'R-1', title: 'rework-prone' }],
      { daemon: { maxReviewRounds: 2, stuckMinutes: 45, pollIntervalSeconds: 1 } },
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

  it('description truncation never drops the ownership hard rules', async () => {
    const longOwnership = 'x'.repeat(4200);
    const { service, teamId, cleanup } = await serviceWithContracts('desctrunc', [
      { id: 'BIG-1', title: 'huge contract', touches: ['server/'] },
    ], {
      profile: {
        ...defaultProfile(),
        ownership: [{ glob: 'server/', role: 'backend', rules: [longOwnership] }],
      },
      learnings: { ...DEFAULT_LEARNINGS, enabled: true, injectMaxCount: 5, injectCharBudget: 1200 },
    });
    try {
      // 先攒几条教训，让三段（正文 / 教训 / 所有权）同时很长。
      for (let index = 0; index < 5; index += 1) {
        await service.learningRecord({
          teamId,
          kind: 'manual',
          summary: `lesson number ${index} with a deliberately long tail to eat budget ${'y'.repeat(200)}`,
          touches: ['server/'],
        });
      }
      const contractPath = join(service.teamView(teamId).repoPath, '.tasks', 'BIG-1.md');
      const contract = await readFile(contractPath, 'utf8');
      await writeFile(contractPath, `${contract}${'body text that is quite long. '.repeat(300)}`, 'utf8');
      gitTest(['add', '-A'], service.teamView(teamId).repoPath);
      gitTest(['commit', '-m', 'tasks: fatten BIG-1'], service.teamView(teamId).repoPath);

      const dev = service.teamView(teamId).members.find((m) => m.role === 'developer')!;
      const task = await service.assignTask({
        teamId,
        title: 'huge contract',
        assigneeId: dev.id,
        contractId: 'BIG-1',
      });
      // 注释承诺"所有权规则留在最末尾，agent 读到的最后一段必须是不可协商的"，
      // 而旧的尾部 clip 恰好把这段最先裁掉。
      expect(task.description.length).toBeLessThanOrEqual(6000);
      expect(task.description).toContain('域所有权');
      expect(task.description.trimEnd().endsWith(longOwnership)).toBe(true);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('projection schema accepts a pre-learnings (v2) payload by filling defaults', () => {
    const v2 = {
      loopState: 'running',
      teams: [
        {
          id: 'team_x', name: 't', repoPath: '/tmp/r', baseBranch: 'main', branches: ['main'],
          members: [], tasks: [], reviews: [], createdAt: 1,
        },
      ],
      activeTeamId: 'team_x',
      escalations: [], deploys: [],
      heartbeat: { at: 1, loopState: 'running', tick: 1 },
      blocked: [],
    };
    // v3 把 learnings 加成必填数组，旧 session 的事件负载里没有这个键。
    const parsed = autopilotProjectionSchema.parse(v2);
    expect(parsed.teams[0]?.learnings).toEqual([]);
    // v6 同理：老负载没有 phase 必须补成 developing —— 补成 intake 等于升级插件后
    // 存量团队一夜之间不再派发任务，那是一次没人签字的行为变更。
    expect(parsed.teams[0]?.phase).toBe('developing');
  });

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

  it('option-like branch names are refused instead of reaching git argv', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('refinject', [
      { id: 'CORE-1', title: 'core', touches: ['server/core/'] },
    ]);
    try {
      // 先建一条正常分支作为受害者：它没有被任何 worktree 检出，
      // 因此 `git branch -D <victim>` 在今天会真的执行成功。
      await service.branch({ teamId, action: 'create', branch: 'task/victim' });
      expect(service.teamView(teamId).branches).toContain('task/victim');

      // team_branch 的 branch 参数由模型自由填写：`-D` 会被拼成
      // `git branch -D task/victim`，把别人的任务分支静默删掉。
      await expect(
        service.branch({ teamId, action: 'create', branch: '-D', target: 'task/victim' }),
      ).rejects.toThrow(/invalid branch name/i);
      expect(service.teamView(teamId).branches).toContain('task/victim');

      // 其它选项注入与非法字符同样要挡住。
      await expect(
        service.branch({ teamId, action: 'merge', branch: '--abort', target: 'main' }),
      ).rejects.toThrow(/invalid branch name/i);
      await expect(
        service.branch({ teamId, action: 'create', branch: 'task/; rm -rf .' }),
      ).rejects.toThrow(/invalid branch name/i);

      // 合法名字仍然要放行（含 profile 模板渲染出的 task/<id>）。
      await service.branch({ teamId, action: 'create', branch: 'task/CORE-1_rework-2' });
      expect(service.teamView(teamId).branches).toContain('task/CORE-1_rework-2');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('requireCiGreen blocks approve when CI status was never verified', async () => {
    const fixture = await makeFixture('cinever');
    const service = await AutopilotService.create(
      testOptions(fixture, {
        remote: { url: fixture.remotePath, sshKeyEnv: 'AUTOPILOT_TEST_GIT_KEY', platform: 'github' },
        gates: { commands: ['git --version'], requireCiGreen: true, timeoutMinutes: 1 },
      }),
    );
    try {
      const { teamId, repoPath } = await seedTeamWithContract(service, 'cinever');
      const { task, reviewer } = await taskInReview(service, teamId, 'CORE-1');
      // 门全绿、契约齐备，但从未 pr_sync 过 → ciStatus 仍是 null。
      // 今天这个 null 让整条 CI 判定消失，等于 requireCiGreen 形同关闭。
      expect(service.teamView(teamId).tasks.find((t) => t.id === task.id)?.ciStatus).toBeNull();
      await expect(
        service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' }),
      ).rejects.toThrow();
      assertNotMerged(service, teamId, repoPath, task.id);
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('requireCiGreen still applies when pushRequiresGates is off', async () => {
    const fixture = await makeFixture('ciindep');
    const service = await AutopilotService.create(
      testOptions(fixture, {
        remote: { url: fixture.remotePath, sshKeyEnv: 'AUTOPILOT_TEST_GIT_KEY', platform: 'github' },
        gates: { commands: ['git --version'], requireCiGreen: true, timeoutMinutes: 1 },
        security: {
          forbiddenPaths: ['LICENSE'],
          commandAllowlist: ['git', 'pnpm', 'sh', 'echo'],
          pushRequiresGates: false,
        },
      }),
    );
    try {
      const { teamId, repoPath } = await seedTeamWithContract(service, 'ciindep');
      const { task, reviewer } = await taskInReview(service, teamId, 'CORE-1');
      // 门全绿（pushRequiresGates 关闭时不看门），但 CI 从未验证过。
      // CI 门属于远端侧约束，不该被 pushRequiresGates 这个本地开关整体短路。
      await expect(
        service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' }),
      ).rejects.toThrow();
      assertNotMerged(service, teamId, repoPath, task.id);
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('requireCiGreen does not block platforms that cannot report CI status', async () => {
    const fixture = await makeFixture('cigeneric');
    const service = await AutopilotService.create(
      testOptions(fixture, {
        remote: { url: fixture.remotePath, sshKeyEnv: 'AUTOPILOT_TEST_GIT_KEY', platform: 'generic' },
        gates: { commands: ['git --version'], requireCiGreen: true, timeoutMinutes: 1 },
      }),
    );
    try {
      const { teamId } = await seedTeamWithContract(service, 'cigeneric');
      const { task, reviewer } = await taskInReview(service, teamId, 'CORE-1');
      // 特征测试：prSync 在非 github 平台恒置 ciStatus='unknown'，若把它当
      // 「未绿」，默认配置（platform generic + requireCiGreen true）将永远无法 approve。
      const verdict = await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' });
      expect(verdict.merged).toBe(true);
    } finally {
      await service.dispose();
    }
  }, 60_000);

  it('rewriting AGENTS.md no longer trips the forbidden gate (default list is LICENSE only)', async () => {
    const fixture = await makeFixture('agents-ok');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      const { teamId, repoPath } = await seedTeamWithContract(service, 'agents-ok');
      const { task, dev, reviewer } = await taskInReview(service, teamId, 'CORE-1');
      // 2026-08-29：AGENTS.md 移出默认禁区，改它、提交它、合它都不该再被拦。
      commitInWorktree(dev.workspacePath, 'AGENTS.md', '# rewritten by the leader\n', 'docs: promote a lesson');
      const verdict = await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' });
      expect(verdict.merged).toBe(true);
      expect(gitTest(['log', '--format=%s', 'main'], repoPath)).toContain('merge: task/CORE-1');
      expect(gitTest(['show', 'main:AGENTS.md'], repoPath)).toContain('rewritten by the leader');
      expect(service.escalations.all.some((record) => record.reason === 'forbidden-paths')).toBe(false);
    } finally {
      await service.dispose();
    }
  }, 60_000);
});

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

  it('依赖死锁：查无此 id 的前置升级 blocked-dependency，而"还没完成"照常安静等待', async () => {
    const { service, teamId, cleanup } = await serviceWithContracts('blocked-dep', [
      { id: 'D-1', title: 'base', touches: ['base/'] },
      { id: 'D-2', title: 'waits', dependsOn: ['D-1'], touches: ['waits/'] },
      { id: 'D-3', title: 'typo', dependsOn: ['GHOST-9'], touches: ['ghost/'] },
    ]);
    try {
      const report = await service.tickOnce();
      // 每次都现取视图：teamView 返回的是当拍快照，跨拍复用会把断言变成读旧状态。
      const byContract = (id: string) =>
        service.teamView(teamId).tasks.find((task) => task.contractId === id)!;
      expect(byContract('D-3').status).toBe('needs-human');
      // D-1 派出去了，D-2 的前置只是"还没完成"：既不能派发，也不能升级。
      expect(byContract('D-1').status).toBe('in_progress');
      expect(byContract('D-2').status).toBe('pending');
      const escalation = service.projection().escalations.find((item) => item.taskId === byContract('D-3').id);
      expect(escalation?.reason).toBe('blocked-dependency');
      expect(escalation?.message).toContain('GHOST-9');
      expect(report.events).toContain(`blocked-dependency:${byContract('D-3').id}`);
      expect(service.projection().escalations.filter((item) => item.taskId === byContract('D-2').id)).toEqual([]);

      // 前置被人工挂起后，下游同拍就该升级：链上每一跳都要一拍到底，否则三跳依赖
      // 要等三拍才有人看见，而完成报告在这期间一直是"永不达标"。
      await service.escalateTask({
        taskId: byContract('D-1').id,
        reason: 'manual',
        message: 'base is stuck',
        suggestion: 'triage it',
      });
      const cascaded = await service.tickOnce();
      expect(byContract('D-2').status).toBe('needs-human');
      expect(cascaded.events).toContain(`blocked-dependency:${byContract('D-2').id}`);
      expect(service.teamView(teamId).metrics.escalations['blocked-dependency']).toBe(2);
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
