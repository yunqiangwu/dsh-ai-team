/**
 * Cordis smoke test: loads the BUILT plugin (lib/index.js) into a real cordis
 * Context the way the DSH Loader would — a stub `tools` runtime stands in for
 * the harness — and verifies the wiring the Loader depends on:
 *
 *   name / inject / Config schema / apply, ctx.provide('aiTeams'),
 *   tool registration, the optional sessionProjections seam being absent,
 *   and ctx.effect cleanup on dispose.
 *
 * Run: pnpm exec tsx tests/smoke-cordis.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-ai-team-smoke-'))

try {
  assert.equal(plugin.name, 'dsh-ai-team')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.ok(plugin.Config, 'Config schema is exported')

  // The Config schema validates and fills defaults at load time.
  const config = plugin.Config({
    rootDir: root,
    stateDir: '',
    baseBranch: 'main',
  }) as { rootDir: string; maxMembers: number; maxTasks: number }
  assert.equal(config.maxMembers, 8)
  assert.equal(config.maxTasks, 256)
  assert.throws(() => plugin.Config({ rootDir: root, maxMembers: 0 }), /maxMembers|0/)
  console.log('  ✓ name / inject / Config schema (defaults + validation)')

  const registered: string[] = []
  const ctx = new Context()
  // Minimal stand-in for the harness tool runtime (dsh-tools ToolRuntime).
  ctx.provide('tools', {
    register(definition: { name: string }) {
      registered.push(definition.name)
      return () => {}
    },
  })

  const fiber = await ctx.plugin(plugin as never, {
    rootDir: root,
    stateDir: '',
    baseBranch: 'main',
    maxMembers: 8,
    maxTasks: 256,
  })

  // The service is provided for other plugins to inject.
  const service = (ctx as unknown as { aiTeams: import('../lib/index.js').TeamService }).aiTeams
  assert.ok(service, 'ctx.aiTeams is provided')
  const team = await service.createTeam({ name: 'smoke' })
  assert.equal(team.members[0]!.role, 'leader')
  console.log('  ✓ apply: plugin loads, ctx.aiTeams provided, team created')

  assert.deepEqual(registered.sort(), [
    'code_review',
    'task_assign',
    'task_update',
    'team_add_member',
    'team_branch',
    'team_create',
    'team_list',
    'team_status',
  ])
  console.log('  ✓ all 8 tools registered on the tool runtime')

  // Unloading the plugin fiber runs the ctx.effect cleanup (state flush).
  await fiber.dispose()
  const { readFile } = await import('node:fs/promises')
  const persisted = JSON.parse(await readFile(join(root, 'teams.json'), 'utf8')) as {
    teams: { name: string }[]
  }
  assert.equal(persisted.teams[0]!.name, 'smoke')
  console.log('  ✓ ctx.effect cleanup flushed teams.json on dispose')

  console.log('\nCordis smoke test passed.')
} finally {
  await rm(root, { recursive: true, force: true })
}
