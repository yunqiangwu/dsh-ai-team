/**
 * 工单端点的**同源围栏**行为锁定：面板那条路由只有作答（POST …/answer）认同源围栏，
 * 读侧仍要 token；DNS rebinding / 跨站表单 / Host-Origin 不一致都被挡，可信 authority 放行。
 */
import { describe, expect, it } from 'vitest';
import { serve, call, panelHeaders, buildHandler, stubStore, TOKEN, PANEL_BASE } from './helpers.js';

describe('ticket http: 同源围栏只授予作答', () => {
  it('POST …/answer 过得了围栏，GET 表单页过不了', async () => {
    const store = stubStore();
    const endpoint = await serve(buildHandler(store, { basePath: PANEL_BASE, trust: 'fence-or-token' }));
    try {
      const answered = await call(endpoint.port, 'POST', `${PANEL_BASE}/esc_open/answer`, {
        headers: { ...panelHeaders(endpoint.port), 'content-type': 'application/json' },
        body: JSON.stringify({ answers: { decision: '同意该方案' } }),
      });
      expect(answered.status).toBe(200);
      expect(await answered.body).toBe('{"ok":true}');
      expect(store.submissions).toEqual([{ id: 'esc_open', answers: { decision: '同意该方案' } }]);

      // 读侧仍要 token：渲染出来的页面里有一次性审批码，围栏换不到它。
      const formWithoutToken = await call(endpoint.port, 'GET', `${PANEL_BASE}/esc_open`, {
        headers: panelHeaders(endpoint.port),
      });
      expect(formWithoutToken.status).toBe(404);
      const formWithToken = await call(endpoint.port, 'GET', `${PANEL_BASE}/esc_open?t=${TOKEN}`);
      expect(formWithToken.status).toBe(200);
    } finally {
      await endpoint.close();
    }
  });

  it('带 token 的 JSON 作答在面板路由上同样有效（邮件链接点进同源页也能答）', async () => {
    const store = stubStore();
    const endpoint = await serve(buildHandler(store, { basePath: PANEL_BASE, trust: 'fence-or-token' }));
    try {
      const submitted = await call(endpoint.port, 'POST', `${PANEL_BASE}/esc_open/answer?t=${TOKEN}`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: '同意' }),
      });
      expect(submitted.status).toBe(200);
      // 答复体允许是裸映射，不强制包一层 answers。
      expect(store.submissions).toEqual([{ id: 'esc_open', answers: { decision: '同意' } }]);
    } finally {
      await endpoint.close();
    }
  });

  it('DNS rebinding（Host 与 Origin 同为 evil.com）被挡；声明过的可信 authority 放行', async () => {
    const endpoint = await serve(
      buildHandler(stubStore(), {
        basePath: PANEL_BASE,
        trust: 'fence-or-token',
        trustedAuthorities: ['team.example.com', 'pinned.example.com:8443'],
      }),
    );
    try {
      const post = (headers: Record<string, string>) =>
        call(endpoint.port, 'POST', `${PANEL_BASE}/esc_open/answer`, {
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ answers: { decision: 'x' } }),
        });

      // 只比"Origin 是否等于 Host"是挡不住 rebinding 的：evil.com 解析到 127.0.0.1 时
      // 这两个头完全相等。所以第一道门先看 Host 可不可信。
      expect((await post({ host: 'evil.com', origin: 'http://evil.com' })).status).toBe(404);

      // 反代后面的面板要还能作答，否则面板一半能用一半 404。
      // 不带端口的条目匹配该主机**任意**端口（与宿主对 /api 的规则同一条）。
      expect((await post({ host: 'team.example.com', origin: 'https://team.example.com' })).status).toBe(200);
      expect(
        (await post({ host: 'team.example.com:8443', origin: 'https://team.example.com:8443' })).status,
      ).toBe(200);
      // 写了端口的条目必须逐字相等：换一个端口就不是它了。
      expect(
        (await post({ host: 'pinned.example.com:9999', origin: 'https://pinned.example.com:9999' })).status,
      ).toBe(404);
      // 可信清单只对它列出的主机放开：同端口用回环之外的别的 Host 仍然不通。
      expect((await post({ host: 'other.example.com', origin: 'https://other.example.com' })).status).toBe(404);
    } finally {
      await endpoint.close();
    }
  });

  it('跨站表单（sec-fetch-site: cross-site）即使 Host 是回环也拒', async () => {
    const store = stubStore();
    const endpoint = await serve(buildHandler(store, { basePath: PANEL_BASE, trust: 'fence-or-token' }));
    try {
      const crossSite = await call(endpoint.port, 'POST', `${PANEL_BASE}/esc_open/answer`, {
        headers: panelHeaders(endpoint.port, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }),
        body: JSON.stringify({ answers: { decision: 'x' } }),
      });
      expect(crossSite.status).toBe(404);
      expect(store.submissions).toHaveLength(0);
    } finally {
      await endpoint.close();
    }
  });

  it('Origin 与 Host 不一致拒；没有 Origin 放行（本机浏览器直接打开链接）', async () => {
    const endpoint = await serve(buildHandler(stubStore(), { basePath: PANEL_BASE, trust: 'fence-or-token' }));
    try {
      const mismatch = await call(endpoint.port, 'POST', `${PANEL_BASE}/esc_open/answer`, {
        headers: { host: '127.0.0.1', origin: 'http://localhost:1234', 'content-type': 'application/json' },
        body: JSON.stringify({ answers: { decision: 'x' } }),
      });
      expect(mismatch.status).toBe(404);
      const noOrigin = await call(endpoint.port, 'POST', `${PANEL_BASE}/esc_open/answer`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers: { decision: 'x' } }),
      });
      expect(noOrigin.status).toBe(200);
    } finally {
      await endpoint.close();
    }
  });
});