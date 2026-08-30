/**
 * Cordis smoke test: loads the BUILT plugin (lib/index.js) into a real
 * cordis Context the way the DSH Loader would — a stub `tools` runtime
 * stands in for the harness — and verifies the wiring the Loader depends on:
 *
 *   name / inject / Config schema / apply, ctx.provide('autopilot'),
 *   tool registration, the optional sessionProjections seam being absent,
 *   and ctx.effect cleanup on dispose.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../lib/index.js';

describe('smoke: cordis Loader contract', () => {
  it('named exports + Config validation + service wiring + cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ai-team-smoke-'));

    expect(plugin.name).toBe('dsh-ai-team');
    expect(plugin.inject).toEqual(['tools']);
    expect(plugin.Config).toBeDefined();

    // The Config schema validates and fills defaults at load time.
    const config = plugin.Config({ rootDir: root }) as {
      maxMembers: number;
      maxTasks: number;
      remote: { platform: string; sshKeyEnv: string };
      daemon: { maxReviewRounds: number };
      security: { forbiddenPaths: string[] };
      bootstrap: { setupCommand: string; verifyCommand: string };
    };
    expect(config.maxMembers).toBe(8);
    expect(config.maxTasks).toBe(512);
    expect(config.remote.platform).toBe('generic');
    expect(config.remote.sshKeyEnv).toBe('AUTOPILOT_GIT_KEY');
    expect(config.daemon.maxReviewRounds).toBe(3);
    expect(config.security.forbiddenPaths).toEqual(['LICENSE']);
    // 已知坑 1 的回归钉：默认引导命令必须是空串（跳过）。空 remote 时团队仓库是
    // 空仓库、真实用户仓库也没有普适脚本 —— 默认指向任何具体命令都会让
    // autopilot_init 一上来就 bootstrap-failed。要跑 setup/verify 的人自己在
    // 配置里指认目标仓库真实存在的命令。
    expect(config.bootstrap.setupCommand).toBe('');
    expect(config.bootstrap.verifyCommand).toBe('');
    // Misconfiguration fails loud and names the key.
    expect(() => plugin.Config({ rootDir: root, maxMembers: 0 })).toThrow(/maxMembers/);
    expect(() => plugin.Config({ rootDir: root, remote: { platform: 'gitlab-' } })).toThrow(/platform/);

    const registered: string[] = [];
    const ctx = new Context();
    // Minimal stand-in for the harness tool runtime (dsh-tools ToolRuntime).
    ctx.provide('tools', {
      register(definition: { name: string }) {
        registered.push(definition.name);
        return () => {};
      },
    });

    const fiber = await ctx.plugin(plugin as never, plugin.Config({ rootDir: root }));

    // The service is provided for other plugins to inject.
    const service = (ctx as unknown as { autopilot: import('../lib/index.js').AutopilotService }).autopilot;
    expect(service).toBeDefined();
    const team = await service.createTeam({ name: 'smoke' });
    expect(team.members[0]?.role).toBe('leader');

    expect(registered.toSorted()).toEqual(
      [
        'answer_questionnaire',
        'ask_human',
        'autopilot_init',
        'config_set',
        'config_show',
        'autopilot_pause',
        'autopilot_phase',
        'autopilot_resume',
        'autopilot_run',
        'autopilot_status',
        'code_review',
        'contract_create',
        'deploy_run',
        'doc_approve',
        'doc_write',
        'escalate',
        'escalation_resolve',
        'gates_run',
        'learning_list',
        'learning_promote',
        'learning_record',
        'pr_sync',
        'task_assign',
        'task_cancel',
        'task_clarify',
        'task_replan',
        'task_update',
        'team_add_member',
        'team_branch',
        'team_create',
        'team_list',
        'team_status',
      ].toSorted(),
    );

    // Unloading the plugin fiber runs the ctx.effect cleanup (state flush).
    await fiber.dispose();
    const persisted = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as {
      teams: { name: string }[];
    };
    expect(persisted.teams[0]?.name).toBe('smoke');
  }, 60_000);

  it('ships + provisions the autopilot-team agent preset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ai-team-preset-'));
    const userRoot = join(root, '.agent-presets');

    // Provision the shipped template into a fresh user root.
    const first = await plugin.ensureAutopilotTeamPreset(userRoot);
    expect(first).toBe(join(userRoot, 'autopilot-team'));
    const composition = await readFile(join(first as string, 'agent.cordis.yml'), 'utf8');
    expect(composition).toContain('Autopilot Team');
    const metadata = await readFile(join(first as string, 'preset.yml'), 'utf8');
    expect(metadata).toContain('Autopilot 团队');

    // Idempotent: re-provisioning returns the same dir and does not overwrite.
    const second = await plugin.ensureAutopilotTeamPreset(userRoot);
    expect(second).toBe(first);

    // Best-effort: an unwritable root must not throw; it resolves undefined.
    expect(await plugin.ensureAutopilotTeamPreset('/proc/not/writable')).toBeUndefined();
  }, 30_000);

  it('keeps the client bundle browser-safe (架构铁律 5)', async () => {
    // view.ts 现在是「值来自 vocab.ts、类型来自 schema.ts」的门面，对 schema.ts
    // 必须是纯类型 re-export。有人把它写成值导入时不会有任何编译错误，
    // zod 会被安静地内联进前端产物 —— 所以这条只能靠产物本身来守。
    const bundle = await readFile(join(import.meta.dirname!, '..', 'lib', 'client.js'), 'utf8');
    expect(bundle).not.toMatch(/\bZodError\b/);
    expect(bundle).not.toMatch(/require\(\s*["']zod["']\s*\)/);
    expect(bundle).not.toMatch(/from\s+["']zod["']/);
    expect(bundle).not.toMatch(/require\(\s*["']node:/);
    // 词表是运行时需要，必须确实在产物里（否则面板的枚举渲染会静默空掉）
    expect(bundle).toContain('needs-clarification');
    expect(bundle).toContain('rollback-failed');
    // 面板作答靠这个同源前缀发请求：它定义在 vocab.ts，服务端与客户端共用。
    // 常量没带出来，面板就会往 `undefined/<id>/answer` 提交。
    expect(bundle).toContain('/autopilot/ticket');
  });
});
