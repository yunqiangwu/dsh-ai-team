/**
 * 工单端点的**失败形状**行为锁定：JSON 漏必填回到 400 并带回 missing、非 JSON 体
 * 回 400、超大体积回 413（两条路）、畸形 request.url 不抛异常。
 */
import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serve, call, panelHeaders, buildHandler, stubStore, TOKEN, PANEL_BASE } from './helpers.js';

describe('ticket http: 失败形状', () => {
  it('JSON 作答漏必填返回 400 并带回 missing，输入不被吞掉', async () => {
    const store = stubStore();
    const endpoint = await serve(buildHandler(store, { basePath: PANEL_BASE, trust: 'fence-or-token' }));
    try {
      const partial = await call(endpoint.port, 'POST', `${PANEL_BASE}/esc_open/answer`, {
        headers: { ...panelHeaders(endpoint.port), 'content-type': 'application/json' },
        body: JSON.stringify({ answers: { note: '先说一句' } }),
      });
      expect(partial.status).toBe(400);
      expect(JSON.parse(partial.body)).toEqual({ ok: false, message: '还有必填项没有作答', missing: ['D'] });
      expect(store.submissions).toHaveLength(0);
    } finally {
      await endpoint.close();
    }
  });

  it('非 JSON 请求体是 400 而不是把异常原文回显出去', async () => {
    const endpoint = await serve(buildHandler(stubStore(), { basePath: PANEL_BASE, trust: 'fence-or-token' }));
    try {
      const broken = await call(endpoint.port, 'POST', `${PANEL_BASE}/esc_open/answer`, {
        headers: { ...panelHeaders(endpoint.port), 'content-type': 'application/json' },
        body: '{"answers": ',
      });
      expect(broken.status).toBe(400);
      expect(JSON.parse(broken.body).ok).toBe(false);
    } finally {
      await endpoint.close();
    }
  });

  it('超出体积上限回 413（JSON 与表单两条路都是），而不是 500', async () => {
    const endpoint = await serve(buildHandler(stubStore(), { basePath: PANEL_BASE, trust: 'fence-or-token' }));
    try {
      const huge = 'x'.repeat(300 * 1024);
      const json = await call(endpoint.port, 'POST', `${PANEL_BASE}/esc_open/answer`, {
        headers: { ...panelHeaders(endpoint.port), 'content-type': 'application/json' },
        body: JSON.stringify({ answers: { decision: huge } }),
      });
      expect(json.status).toBe(413);
      expect(JSON.parse(json.body).ok).toBe(false);
      const form = await call(endpoint.port, 'POST', `${PANEL_BASE}/esc_open?t=${TOKEN}`, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `decision=${huge}`,
      });
      expect(form.status).toBe(413);
    } finally {
      await endpoint.close();
    }
  });

  it('畸形 request.url 不抛（它被 void 调起来，抛出去就是一条没人接的 rejection）', async () => {
    const handler = buildHandler(stubStore());
    const messages: string[] = [];
    const fake = {
      method: 'GET',
      url: 'http://[::1',
      headers: { host: '127.0.0.1' },
      on: () => fake,
      resume: () => fake,
      destroy: () => fake,
    } as unknown as IncomingMessage;
    const response = {
      writeHead: (status: number) => {
        messages.push(String(status));
        return response;
      },
      end: () => response,
    } as unknown as ServerResponse;
    await handler.handle(fake, response);
    expect(messages).toEqual(['404']);
  });
});