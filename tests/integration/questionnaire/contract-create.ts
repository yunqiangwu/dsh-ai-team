/** contract_create 写前校验（场景六）：悬空依赖 / 坏 id / 撞禁区 / 成环 / 域超限，合法写盘收养（原 test-questionnaire.ts 拆出）。 */
import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AutopilotService } from '../../../src/service.js';
import type { ContractDraft } from '../../../src/service/contracts.js';
import type { AutopilotOptions } from '../../../src/service/options.js';
import { gitTest, makeFixture, testOptions, writeContract } from '../../helpers.js';
import type { Fixture } from '../../helpers.js';

interface Ctx {
  service: AutopilotService;
  fixture: Fixture;
  teamId: string;
  repoPath: string;
  leaderId: string;
  cleanup: () => Promise<void>;
}

async function makeCtx(
  prefix: string,
  overrides: Partial<AutopilotOptions> = {},
  members: { role: 'leader' | 'developer' | 'reviewer' }[] = [{ role: 'leader' }, { role: 'developer' }],
): Promise<Ctx> {
  const fixture = await makeFixture(prefix);
  const service = await AutopilotService.create(testOptions(fixture, overrides));
  const team = await service.createTeam({ name: `${prefix}-team`, members });
  const [leader] = team.members.filter((member) => member.role === 'leader');
  return {
    service,
    fixture,
    teamId: team.id,
    repoPath: team.repoPath,
    leaderId: leader!.id,
    cleanup: () => service.dispose(),
  };
}

async function readText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

describe('contract_create: 写前校验（场景六）', () => {
  const valid: ContractDraft = {
    id: 'CORE-1',
    title: '核心骨架',
    owner: 'developer',
    touches: ['server/core/'],
    body: '```gherkin\nGiven 仓库\nWhen 实现\nThen 验收通过\n```',
  };
  const contractDraft = (overrides: Partial<ContractDraft>): ContractDraft => ({ ...valid, ...overrides });

  it('悬空依赖 / 非法 id / touches 撞禁区 / 成环 / 跨域超限一律拒绝且不留文件', async () => {
    const ctx = await makeCtx('contract');
    try {
      await writeContract(join(ctx.repoPath, '.tasks', 'Q-1.md'), { id: 'Q-1', title: '已有的单子', touches: ['app/'] });
      gitTest(['add', '-A'], ctx.repoPath);
      gitTest(['commit', '-m', 'tasks: seed'], ctx.repoPath);

      const cases: { name: string; contract: ContractDraft; expect: RegExp }[] = [
        { name: 'dangling dep', contract: contractDraft({ dependsOn: ['NOPE-9'] }), expect: /depends_on "NOPE-9" does not exist/ },
        { name: 'bad id', contract: contractDraft({ id: 'core-1' }), expect: /must match <DOMAIN>-<number>/ },
        { name: 'duplicate id', contract: contractDraft({ id: 'Q-1' }), expect: /already exists on disk/ },
        { name: 'self dep', contract: contractDraft({ dependsOn: ['CORE-1'] }), expect: /includes itself/ },
        { name: 'no owner', contract: contractDraft({ owner: '' }), expect: /owner is required/ },
        { name: 'no touches', contract: contractDraft({ touches: [] }), expect: /touches is required/ },
        { name: 'no body', contract: contractDraft({ body: ' ' }), expect: /body is required/ },
        { name: 'bad status', contract: contractDraft({ status: 'done' }), expect: /cannot be created/ },
        { name: 'self forbidden', contract: contractDraft({ touches: ['docs/'], forbidden: ['docs/'] }), expect: /forbidden by this contract itself/ },
        { name: 'global forbidden', contract: contractDraft({ touches: ['LICENSE'] }), expect: /security\.forbiddenPaths/ },
        { name: 'too many domains', contract: contractDraft({ touches: ['a/', 'b/', 'c/', 'd/'] }), expect: /distinct domains/ },
      ];
      for (const item of cases) {
        const error = await ctx.service
          .contractCreate({ teamId: ctx.teamId, contracts: [item.contract] })
          .then(() => null, (caught: unknown) => caught as Error);
        expect(error?.message, item.name).toMatch(item.expect);
        expect(error?.message).toContain('nothing was written');
      }
      // 批量依赖成环：前置允许指向同批兄弟，但不允许闭环。
      const cycle = await ctx.service
        .contractCreate({
          teamId: ctx.teamId,
          contracts: [
            contractDraft({ id: 'A-1', touches: ['a/'], dependsOn: ['A-2'] }),
            contractDraft({ id: 'A-2', touches: ['b/'], dependsOn: ['A-1'] }),
          ],
        })
        .then(() => null, (caught: unknown) => caught as Error);
      expect(cycle?.message).toMatch(/dependency cycle: A-1 → A-2 → A-1/);

      // 「绝不留半个文件」的证据：盘上还是只有那张种下的契约，工作区干净。
      expect(await readdir(join(ctx.repoPath, '.tasks'))).toEqual(['Q-1.md']);
      expect(gitTest(['status', '--porcelain'], ctx.repoPath)).toBe('');
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it('合法契约写盘后被 syncContracts 收养，无需第二次人工动作', async () => {
    const ctx = await makeCtx('adopt', {}, [{ role: 'leader' }, { role: 'developer' }, { role: 'developer' }]);
    try {
      const created = await ctx.service.contractCreate({
        teamId: ctx.teamId,
        contracts: [valid, contractDraft({ id: 'CORE-2', title: '扩展', touches: ['server/ext/'], dependsOn: ['CORE-1'] })],
      });
      expect(created.created.map((item) => item.path)).toEqual(['.tasks/CORE-1.md', '.tasks/CORE-2.md']);
      const file = await readFile(join(ctx.repoPath, '.tasks', 'CORE-1.md'), 'utf8');
      expect(file).toContain('id: CORE-1');
      expect(file).toContain('status: pending');
      expect(file).toContain('- server/core/');
      expect(gitTest(['log', '--format=%s', 'main'], ctx.repoPath)).toContain('tasks: create CORE-1, CORE-2');

      const tick = await ctx.service.tickOnce();
      const team = ctx.service.teamView(ctx.teamId);
      const core1 = team.tasks.find((task) => task.contractId === 'CORE-1');
      expect(core1?.status).toBe('in_progress');
      expect(tick.dispatched).toContain(core1?.id);
      // CORE-2 前置未完 → 仍在 pending，说明契约是被正常解析而不是被忽略。
      expect(team.tasks.find((task) => task.contractId === 'CORE-2')?.status).toBe('pending');

      expect(await readText(join(ctx.repoPath, '.tasks', '_board.md'))).toContain('CORE-1');
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);
});