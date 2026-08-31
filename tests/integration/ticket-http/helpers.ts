/**
 * ticket-http 各 describe 分片共用的启动 / 请求辅助块。
 *
 * 注意：这里的请求全部走 node:http 裸客户端 —— `fetch` 不给改 `Host`，而用例都在测
 * Host / Origin / sec-fetch-site 三个头的组合。
 */
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  TICKET_PATH_PREFIX,
  TeamSwitchHandler,
  TicketHandler,
  TicketServer,
  ticketUrlWithToken,
  type TicketStore,
} from '../../../src/ticket-handler.js';
import type { TicketField } from '../../../src/formmodel.js';

export const TOKEN = '0123456789abcdef0123456789abcdef';
/** 面板那条路由的前缀；测试自己写死，与 vocab 的常量各测一头（漂移由 smoke 断言）。 */
export const PANEL_BASE = '/autopilot/ticket';

const FIELDS: TicketField[] = [{ name: 'decision', label: 'D', type: 'textarea', required: true }];

/** 只关心鉴权与路由，落点用最小 store：能渲染、能把缺项报回去。 */
export function stubStore(): TicketStore & { submissions: { id: string; answers: Record<string, string> }[] } {
  const submissions: { id: string; answers: Record<string, string> }[] = [];
  return {
    submissions,
    renderTicket: async (id) =>
      id === 'esc_open'
        ? { title: `Confirm ${id}`, notice: '需要你分诊', fields: FIELDS }
        : null,
    handleSubmit: async (id, answers) => {
      if (id !== 'esc_open') return { ok: false, message: 'ticket not found' };
      if ((answers.decision ?? '').trim() === '') {
        return { ok: false, message: '还有必填项没有作答', missing: ['D'] };
      }
      submissions.push({ id, answers });
      return { ok: true };
    },
    hasTicket: (id) => id === 'esc_open',
  };
}

export function buildHandler(
  store: TicketStore,
  overrides: Partial<Pick<ConstructorParameters<typeof TicketHandler>[0], 'trust' | 'basePath' | 'trustedAuthorities'>> = {},
) {
  return new TicketHandler({
    basePath: overrides.basePath ?? TICKET_PATH_PREFIX,
    store,
    trust: overrides.trust ?? 'token-only',
    tokenOf: (id) => (id === 'esc_open' ? TOKEN : undefined),
    trustedAuthorities: () => overrides.trustedAuthorities ?? [],
  });
}

export interface Endpoint {
  base: string;
  port: number;
  close: () => Promise<void>;
}

/** 起一个真监听：鉴权判据读的是 socket 上的原始头，伪装不了。 */
export async function serve(handler: TicketHandler): Promise<Endpoint> {
  const server = createServer((request, response) => {
    void handler.handle(request, response);
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}

/** 团队切换端点的起服：与 `serve` 同构，只是 handler 是 TeamSwitchHandler。 */
export async function serveSwitch(store: { switchTeam: (teamId: string) => boolean }): Promise<Endpoint> {
  const handler = new TeamSwitchHandler({ store });
  const server = createServer((request, response) => {
    void handler.handle(request, response);
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}

export interface Call {
  status: number;
  body: string;
  contentType: string;
}

/**
 * 手写一次请求。`fetch` 不给改 `Host`，而这里全部用例都在测 Host / Origin /
 * sec-fetch-site 这三个头的组合，所以走 node:http。
 */
export function call(
  port: number,
  method: string,
  path: string,
  input: { headers?: Record<string, string>; body?: string } = {},
): Promise<Call> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: input.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            contentType: String(response.headers['content-type'] ?? ''),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(input.body);
  });
}

/** 面板那条请求长得这样：同源、本机、Origin 带端口（浏览器就是这么发的）。 */
export function panelHeaders(port: number, extra: Record<string, string> = {}): Record<string, string> {
  return { origin: `http://127.0.0.1:${port}`, ...extra };
}