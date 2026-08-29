/**
 * 工单端点的**鉴权与路由**行为锁定（.tasks/INT-3.md 场景二）。
 *
 * M2 把一份 handler 挂在两个地方：独立端口（邮件里的链接，读写都要 token）与宿主
 * 同源路由（面板里的卡片，**只有作答那一条**认同源围栏）。这个文件锁的就是"哪个入口
 * 接受哪种凭据"这张表，以及几条一眼看不出问题、实际能绕的构造：
 *
 * - 未知 id / 无凭据 / 前缀写错三条路径必须**逐字节相同**，否则工单号可被枚举；
 * - DNS rebinding（`Host` 与 `Origin` 同为 evil.com）必须挡住 —— 只比这两个头是否
 *   相等是挡不住的；
 * - 面板那条若放开读侧，本机任意进程都能用围栏换到一张写着一次性审批码的页面。
 *
 * 表单渲染与答案解析的形状在 test-notification.ts / test-questionnaire.ts，这里不重复。
 */
import { describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  isLoopbackHostname,
  isSameOriginPanelRequest,
  TICKET_PATH_PREFIX,
  TicketHandler,
  TicketServer,
  ticketUrlWithToken,
  type TicketStore,
} from '../src/ticket-handler.js';
import type { TicketField } from '../src/formmodel.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
/** 面板那条路由的前缀；测试自己写死，与 vocab 的常量各测一头（漂移由 smoke 断言）。 */
const PANEL_BASE = '/autopilot/ticket';

const FIELDS: TicketField[] = [{ name: 'decision', label: 'D', type: 'textarea', required: true }];

/** 只关心鉴权与路由，落点用最小 store：能渲染、能把缺项报回去。 */
function stubStore(): TicketStore & { submissions: { id: string; answers: Record<string, string> }[] } {
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

function buildHandler(store: TicketStore, overrides: Partial<Pick<ConstructorParameters<typeof TicketHandler>[0], 'trust' | 'basePath' | 'trustedAuthorities'>> = {}) {
  return new TicketHandler({
    basePath: overrides.basePath ?? TICKET_PATH_PREFIX,
    store,
    trust: overrides.trust ?? 'token-only',
    tokenOf: (id) => (id === 'esc_open' ? TOKEN : undefined),
    trustedAuthorities: () => overrides.trustedAuthorities ?? [],
  });
}

interface Endpoint {
  base: string;
  port: number;
  close: () => Promise<void>;
}

/** 起一个真监听：鉴权判据读的是 socket 上的原始头，伪装不了。 */
async function serve(handler: TicketHandler): Promise<Endpoint> {
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

interface Call {
  status: number;
  body: string;
  contentType: string;
}

/**
 * 手写一次请求。`fetch` 不给改 `Host`，而这里全部用例都在测 Host / Origin /
 * sec-fetch-site 这三个头的组合，所以走 node:http。
 */
function call(
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
function panelHeaders(port: number, extra: Record<string, string> = {}): Record<string, string> {
  return { origin: `http://127.0.0.1:${port}`, ...extra };
}

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
