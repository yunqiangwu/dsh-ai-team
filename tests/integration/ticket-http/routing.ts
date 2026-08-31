/**
 * 工单端点的**鉴权与路由**行为锁定（.tasks/INT-3.md 场景二）：
 * 未知 id / 无凭据 / 前缀写错三条路径必须逐字节相同、挂载前缀与锚点不放过界构造、
 * 独立端口连面板式同源头也不放行、单选 OPTIONS 是 405。
 */
import { describe, expect, it } from 'vitest';
import { serve, call, panelHeaders, buildHandler, stubStore, TOKEN, PANEL_BASE } from './helpers.js';

describe('ticket http: 路由与凭据（场景二）', () => {
  it('未知 id、错 token、无 token 三条路径响应体逐字节相同', async () => {
    const endpoint = await serve(buildHandler(stubStore()));
    try {
      const unknown = await call(endpoint.port, 'GET', '/ticket/esc_nope');
      const noToken = await call(endpoint.port, 'GET', '/ticket/esc_open');
      const wrongToken = await call(endpoint.port, 'GET', `/ticket/esc_open?t=${'f'.repeat(32)}`);
      const sameLengthToken = await call(endpoint.port, 'GET', `/ticket/esc_open?t=${'0'.repeat(31)}1`);
      for (const response of [unknown, noToken, wrongToken, sameLengthToken]) {
        expect(response.status).toBe(404);
        expect(response.body).toBe('ticket not found');
      }
      // 凭据对了才换到页面。
      const ok = await call(endpoint.port, 'GET', `/ticket/esc_open?t=${TOKEN}`);
      expect(ok.status).toBe(200);
      expect(ok.body).toContain('Confirm esc_open');
    } finally {
      await endpoint.close();
    }
  });

  it('挂载前缀不匹配时不调用它答复工单', async () => {
    const store = stubStore();
    const endpoint = await serve(buildHandler(store, { basePath: PANEL_BASE }));
    try {
      // 挂在 /autopilot/ticket 上却收到 /ticket/... —— 独立端口那条路必须 404。
      const wrongMount = await call(endpoint.port, 'GET', `/ticket/esc_open?t=${TOKEN}`);
      expect(wrongMount.status).toBe(404);
      const rightMount = await call(endpoint.port, 'GET', `${PANEL_BASE}/esc_open?t=${TOKEN}`);
      expect(rightMount.status).toBe(200);
      expect(store.submissions).toHaveLength(0);
    } finally {
      await endpoint.close();
    }
  });

  it('id 之后的多余路径不命中（锚点缺失曾是真漏洞）', async () => {
    const endpoint = await serve(buildHandler(stubStore()));
    try {
      for (const path of ['/ticket/esc_open/../..', '/ticket/esc_open/x', '/ticket/esc_open/answer/extra']) {
        expect((await call(endpoint.port, 'GET', path)).status).toBe(404);
      }
      // 尾斜杠是同一张单子，不是多余路径。
      expect((await call(endpoint.port, 'GET', `/ticket/esc_open/?t=${TOKEN}`)).status).toBe(200);
    } finally {
      await endpoint.close();
    }
  });

  it('独立端口连面板式的同源头也不给放行（读、写都不给）', async () => {
    const endpoint = await serve(buildHandler(stubStore()));
    try {
      const read = await call(endpoint.port, 'GET', '/ticket/esc_open', { headers: panelHeaders(endpoint.port) });
      expect(read.status).toBe(404);
      const write = await call(endpoint.port, 'POST', '/ticket/esc_open/answer', {
        headers: { ...panelHeaders(endpoint.port), 'content-type': 'application/json' },
        body: JSON.stringify({ answers: { decision: '同意' } }),
      });
      expect(write.status).toBe(404);
    } finally {
      await endpoint.close();
    }
  });

  it('同源路由过了围栏也不给"这单子存不存在"（未知 id 仍是那个 404）', async () => {
    const store = stubStore();
    const endpoint = await serve(buildHandler(store, { basePath: PANEL_BASE, trust: 'fence-or-token' }));
    try {
      const deny = { host: `127.0.0.1:${endpoint.port}`, origin: 'http://evil.com', 'content-type': 'application/json' };
      const fenceFail = await call(endpoint.port, 'POST', `${PANEL_BASE}/esc_nope/answer`, {
        headers: deny,
        body: JSON.stringify({ answers: { decision: 'x' } }),
      });
      // 围栏放行 + 单子不存在：`handleSubmit` 会说 "ticket not found"，状态码却是 400 ——
      // 与凭据失败的 404 一比就是个枚举器。`store.hasTicket` 那道闸就是为这条存在的。
      const fencePass = await call(endpoint.port, 'POST', `${PANEL_BASE}/esc_nope/answer`, {
        headers: panelHeaders(endpoint.port, { 'content-type': 'application/json' }),
        body: JSON.stringify({ answers: { decision: 'x' } }),
      });
      expect(fenceFail.status).toBe(404);
      expect(fencePass.status).toBe(404);
      expect(fencePass.body).toBe(fenceFail.body);
      expect(store.submissions).toHaveLength(0);

      // 闸只管"不存在"，不能顺手把真单子的 400 也吞成 404。
      const known = await call(endpoint.port, 'POST', `${PANEL_BASE}/esc_open/answer`, {
        headers: panelHeaders(endpoint.port, { 'content-type': 'application/json' }),
        body: JSON.stringify({ answers: { decision: '' } }),
      });
      expect(known.status).toBe(400);
      expect(known.body).toContain('missing');
    } finally {
      await endpoint.close();
    }
  });

  it('OPTIONS 明确 405：这里没有 CORS，是一条事实而不是一句注释', async () => {
    const endpoint = await serve(buildHandler(stubStore(), { basePath: PANEL_BASE, trust: 'fence-or-token' }));
    try {
      const preflight = await call(endpoint.port, 'OPTIONS', `${PANEL_BASE}/esc_open/answer`);
      expect(preflight.status).toBe(405);
      expect(preflight.contentType).toContain('text/plain');
    } finally {
      await endpoint.close();
    }
  });
});