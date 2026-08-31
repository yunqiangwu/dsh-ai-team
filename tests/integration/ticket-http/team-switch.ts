/**
 * 面板团队切换端点（P3-2）行为锁定：同源 POST 切到存在的团队返回 200 并调用 store，
 * 围栏失败与非 POST、未知团队、坏请求体各回对应的 404 / 400。
 */
import { describe, expect, it } from 'vitest';
import { serveSwitch, call, panelHeaders } from './helpers.js';

describe('team switch http: 面板团队切换（P3-2）', () => {
  const TEAM_BASE = '/autopilot/team';

  it('同源 POST 切到存在的团队返回 200 并调用 store', async () => {
    const switched: string[] = [];
    const endpoint = await serveSwitch({ switchTeam: (id) => (switched.push(id), id === 'team-a') });
    try {
      const ok = await call(endpoint.port, 'POST', TEAM_BASE, {
        headers: panelHeaders(endpoint.port, { 'content-type': 'application/json' }),
        body: JSON.stringify({ teamId: 'team-a' }),
      });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body)).toEqual({ ok: true });
      expect(switched).toEqual(['team-a']);
    } finally {
      await endpoint.close();
    }
  });

  it('围栏失败与非 POST 一律 404，不调用 store', async () => {
    const switched: string[] = [];
    const endpoint = await serveSwitch({ switchTeam: (id) => (switched.push(id), true) });
    try {
      const rebinding = await call(endpoint.port, 'POST', TEAM_BASE, {
        headers: { host: 'evil.com', origin: 'http://evil.com', 'content-type': 'application/json' },
        body: JSON.stringify({ teamId: 'team-a' }),
      });
      expect(rebinding.status).toBe(404);
      const get = await call(endpoint.port, 'GET', TEAM_BASE, { headers: panelHeaders(endpoint.port) });
      expect(get.status).toBe(404);
      expect(switched).toHaveLength(0);
    } finally {
      await endpoint.close();
    }
  });

  it('未知团队回 404；坏请求体回 400', async () => {
    const endpoint = await serveSwitch({ switchTeam: () => false });
    try {
      const unknown = await call(endpoint.port, 'POST', TEAM_BASE, {
        headers: panelHeaders(endpoint.port, { 'content-type': 'application/json' }),
        body: JSON.stringify({ teamId: 'team-nope' }),
      });
      expect(unknown.status).toBe(404);
      const broken = await call(endpoint.port, 'POST', TEAM_BASE, {
        headers: panelHeaders(endpoint.port, { 'content-type': 'application/json' }),
        body: '{"teamId": ',
      });
      expect(broken.status).toBe(400);
      const missing = await call(endpoint.port, 'POST', TEAM_BASE, {
        headers: panelHeaders(endpoint.port, { 'content-type': 'application/json' }),
        body: '{}',
      });
      expect(missing.status).toBe(400);
    } finally {
      await endpoint.close();
    }
  });
});