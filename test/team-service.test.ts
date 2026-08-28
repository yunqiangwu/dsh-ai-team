// Unit tests for TeamService. Uses an in-memory fake git backend so the test
// never touches the filesystem's git and stays deterministic.
//
// Run with: pnpm test  (uses tsx, which maps the `.js` import specifiers to `.ts`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { TeamService } from '../src/service.js';
import type { GitBackend } from '../src/git.js';
import type { MemberRole } from '../src/types.js';

class FakeGit implements GitBackend {
  async init(): Promise<void> {}
  async addWorktree(): Promise<void> {}
  async checkout(): Promise<void> {}
  async createBranch(): Promise<void> {}
  async merge(): Promise<{ conflict: boolean }> {
    return { conflict: false };
  }
  async status(): Promise<{ branch: string; dirty: boolean }> {
    return { branch: 'main', dirty: false };
  }
  async diffStat(): Promise<{ files: number; insertions: number; deletions: number }> {
    return { files: 3, insertions: 42, deletions: 1 };
  }
  async listBranches(): Promise<string[]> {
    return ['main'];
  }
}

async function makeService() {
  const dir = await mkdtemp(join(tmpdir(), 'ai-team-test-'));
  const events = new EventEmitter();
  const service = new TeamService({ stateDir: dir, git: new FakeGit(), events });
  return { service, dir, events };
}

test('createTeam bootstraps a shared repo and assigns a leader', async () => {
  const { service, dir } = await makeService();
  const team = await service.createTeam({
    name: 'Squad',
    members: [
      { role: 'leader' },
      { role: 'developer' },
      { role: 'developer' },
      { role: 'reviewer' },
    ],
  });
  assert.equal(team.members.length, 4);
  assert.ok(team.leaderId, 'a leader should be chosen');
  assert.equal(team.members[0].role, 'leader');
  assert.equal(team.repositoryPath, join(dir, team.id, 'repo'));
  await service.disposeTeam(team.id);
  await rm(dir, { recursive: true, force: true });
});

test('addMember creates an isolated workspace', async () => {
  const { service, dir } = await makeService();
  const team = await service.createTeam({ name: 'S', members: [{ role: 'leader' }] });
  const before = team.members.length;
  const m = await service.addMember(team.id, { role: 'developer', name: 'Dev2' });
  assert.equal(m.role, 'developer');
  assert.equal(m.name, 'Dev2');
  assert.equal(service.getTeam(team.id).members.length, before + 1);
  await service.disposeTeam(team.id);
  await rm(dir, { recursive: true, force: true });
});

test('assignTask routes work to a developer and marks it in progress', async () => {
  const { service, dir } = await makeService();
  const team = await service.createTeam({
    name: 'S',
    members: [{ role: 'leader' }, { role: 'developer' }, { role: 'reviewer' }],
  });
  const task = await service.assignTask(team.id, {
    title: 'Build API',
    description: 'Implement the endpoint',
    assigneeRole: 'developer',
    priority: 'high',
  });
  assert.equal(task.status, 'in_progress');
  assert.ok(task.assigneeId, 'a developer should be assigned');
  const dev = team.members.find((m) => m.id === task.assigneeId);
  assert.equal(dev?.status, 'busy');
  await service.disposeTeam(team.id);
  await rm(dir, { recursive: true, force: true });
});

test('updateTaskStatus to done frees the assignee', async () => {
  const { service, dir } = await makeService();
  const team = await service.createTeam({
    name: 'S',
    members: [{ role: 'leader' }, { role: 'developer' }],
  });
  const task = await service.assignTask(team.id, { title: 'T', description: 'd', assigneeRole: 'developer' });
  await service.updateTaskStatus(team.id, task.id, 'done');
  const dev = team.members.find((m) => m.id === task.assigneeId);
  assert.equal(dev?.status, 'idle');
  await service.disposeTeam(team.id);
  await rm(dir, { recursive: true, force: true });
});

test('reviewCode returns an approval with a non-empty diff', async () => {
  const { service, dir } = await makeService();
  const team = await service.createTeam({
    name: 'S',
    members: [{ role: 'leader' }, { role: 'developer' }, { role: 'reviewer' }],
  });
  const result = await service.reviewCode(team.id, { branch: 'agent/x', base: 'main' });
  assert.equal(result.diffStat.files, 3);
  assert.equal(result.approved, true);
  assert.ok(Array.isArray(result.comments));
  await service.disposeTeam(team.id);
  await rm(dir, { recursive: true, force: true });
});

test('snapshot reflects teams and members', async () => {
  const { service, dir } = await makeService();
  const team = await service.createTeam({
    name: 'S',
    members: [{ role: 'leader' }, { role: 'developer' } as { role: MemberRole }],
  });
  const snap = service.snapshot();
  assert.equal(snap.teams.length, 1);
  assert.equal(snap.teams[0].members.length, 2);
  await service.disposeTeam(team.id);
  await rm(dir, { recursive: true, force: true });
});
