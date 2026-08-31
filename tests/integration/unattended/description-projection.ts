/**
 * Unattended-operation test: the description budget must never drop the
 * ownership hard rules, and the autopilot projection schema must round-trip
 * v2 pre-learnings payloads and real snapshots without stripping keys.
 */
import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../../../src/service.js';
import { autopilotProjectionSchema } from '../../../src/schema.js';
import { DEFAULT_LEARNINGS } from '../../../src/learnings.js';
import { defaultProfile } from '../../../src/profile.js';
import {
  gitTest,
  makeFixture,
  seedTeam,
  testOptions,
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

describe('unattended: daemon loop', () => {
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
});

describe('unattended: knowledge loop, clarification and pre-dispatch gates', () => {
  /** 开启知识回路的覆盖项（默认关闭，所以每个用例要显式打开才有捕获）。 */
  const withLearnings = { learnings: { ...DEFAULT_LEARNINGS, enabled: true } };

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