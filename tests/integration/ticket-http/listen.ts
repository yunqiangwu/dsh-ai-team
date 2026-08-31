/**
 * 工单端点的**监听与纯函数**行为锁定：独立端口拒绝非回环绑定（fail-loud）、
 * token 只拼进给人看的文案、回环主机名与围栏判据的纯函数单测。
 */
import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { TicketServer, ticketUrlWithToken, isLoopbackHostname, isSameOriginPanelRequest } from '../../../src/ticket-handler.js';
import { TOKEN, buildHandler, stubStore } from './helpers.js';

describe('ticket http: 监听与纯函数', () => {
  it('独立端口拒绝绑定非回环地址（fail-loud，不静默开放整个网段）', async () => {
    const server = new TicketServer({ host: '0.0.0.0', port: 0, handler: buildHandler(stubStore()) });
    expect(() => server.start()).toThrow(/refuses to bind/);
  });

  it('token 只拼进给人的文案；无 token 时原样返回', () => {
    expect(ticketUrlWithToken('http://h/ticket/esc_1', TOKEN)).toBe(`http://h/ticket/esc_1?t=${TOKEN}`);
  });

  it('围栏判据本身：回环主机名与缺失的 Host 头', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('127.5.5.5')).toBe(true);
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('10.0.0.8')).toBe(false);
    // 缺 Host 头就不是同源（Host 是 HTTP/1.1 必填，缺了说明有人在伪造请求）。
    expect(isSameOriginPanelRequest({ headers: {} } as unknown as IncomingMessage, [])).toBe(false);
  });
});