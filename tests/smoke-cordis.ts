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
    };
    expect(config.maxMembers).toBe(8);
    expect(config.maxTasks).toBe(512);
    expect(config.remote.platform).toBe('generic');
    expect(config.remote.sshKeyEnv).toBe('AUTOPILOT_GIT_KEY');
    expect(config.daemon.maxReviewRounds).toBe(3);
    expect(config.security.forbiddenPaths).toContain('AGENTS.md');
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
        'autopilot_init',
        'autopilot_pause',
        'autopilot_resume',
        'autopilot_run',
        'autopilot_status',
        'code_review',
        'deploy_run',
        'escalate',
        'escalation_resolve',
        'gates_run',
        'pr_sync',
        'task_assign',
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
});
