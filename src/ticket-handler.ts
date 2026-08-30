/**
 * 工单 HTTP 端点 —— 人工作答的**入向**那一半（出向的 SMTP / webhook 投递住在
 * `notification.ts`，docs/design-interaction.md §7）。
 *
 * 一份 handler 两处挂载，行为差别只在"接受哪种凭据"：
 *
 * - **`TicketServer`（独立端口）**：服务**邮件里的链接**。读写都必须带 `?t=<token>`。
 * - **宿主同源路由**：`src/index.ts` 把同一个 handler `register` 到 `ctx.webServer`
 *   的 `TICKET_ROUTE_PREFIX` 前缀上，服务**面板里的卡片**。只有
 *   `POST <base>/<id>/answer` 这一条写侧接受同源围栏；读侧（表单页）仍然要 token，
 *   否则本机任意进程都能用围栏换到一张写着审批码的页面。
 *
 * 为什么要有同源那一份：dsh web 面板本身就是明文 `node:http`（宿主
 * `dsh-host-webserver` 在"已知限制"里写明不提供 TLS / 认证 / 来源策略），面板发
 * **相对路径**既不会撞混合内容（跟着页面走同一个 scheme 与 host，用户自建的 HTTPS
 * 反代自动骑得过去），也不用把实际监听端口告诉浏览器（`ticket.port` 默认 0 是运行
 * 时才知道的）。顺带一条 CORS 都不用开 —— 给一个刚加上鉴权的端点放 CORS 白名单，
 * 等于顺手把 CSRF 的门也撑开了。
 *
 * 本模块**不认识 escalation 也不认识 questionnaire**：一张工单意味着什么由 `store`
 * 决定（见 `TicketStore`），本层只管鉴权、画表单、收答复。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { normalizeOption, type TicketField } from './formmodel.js';
import { MULTI_VALUE_SEP } from './vocab.js';

// ── 工单契约（与 store 之间唯一的边界）────────────────────────────────────────

/** 填好的工单落到哪里：由 service 接线的回调。 */
export interface TicketStore {
  /**
   * 渲染一张表单。store 实现自由决定这张表单是什么（升级分诊 / 问卷作答 /
   * 文档审批），本模块只负责把它给出的字段画出来（字段形状见 `formmodel.ts`）。
   * 未命中返回 `null`。
   */
  renderTicket(id: string): Promise<{ title: string; notice: string; fields: TicketField[] } | null>;
  /**
   * 工单被提交时调用；返回要持久化的答复。两条挂载路径（独立端口的 urlencoded
   * 表单、面板的 JSON）在这里汇成一条 —— 都是"人亲自答的工单"，同一个来源。
   */
  handleSubmit(
    id: string,
    answers: Record<string, string>,
  ): Promise<{ ok: boolean; message?: string; missing?: string[] }>;
  /**
   * 这张工单在不在（答过、过期都算在）。提交路径先问它，是为了让"未知 id"在**两个
   * 挂载点**上都回与凭据失败逐字节相同的 404 —— 否则同源那条过了围栏的请求就能靠
   * 400/404 的差别把工单号试出来。
   */
  hasTicket(id: string): boolean;
}

/** 投递给工单 id 上挂的 token；本模块只认它，不铸造也不吊销。 */
export const TICKET_TOKEN_PARAM = 't';

/** 拼一条带凭据的工单地址。**只用于给人的文案**，投影里的 ticketUrl 刻意不带它。 */
export function ticketUrlWithToken(url: string, token: string): string {
  return `${url}?${TICKET_TOKEN_PARAM}=${encodeURIComponent(token)}`;
}

// ── 同源围栏（整抄宿主 dsh-client-connection 的 /api 判定）─────────────────────

/**
 * 回环主机名。Node 没有 `net.isLoopback`，而这段判据错了等于把端点开放给整个网段，
 * 所以自己实现并留在这里：`localhost` / `::1` / 整个 `127/8`。
 */
export function isLoopbackHostname(value: string): boolean {
  const hostname = value.replace(/^\[|\]$/g, '').toLowerCase();
  return hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
}

interface Authority {
  /** `host:port`（无端口时就是 host）。 */
  host: string;
  /** 去掉了 IPv6 方括号的小写主机名。 */
  hostname: string;
  port: string;
}

/** 解析 `Host` / `Origin` 里的 authority。解析不出来一律视为不可信。 */
function parseAuthority(value: string): Authority | null {
  try {
    const url = new URL(`http://${value}`);
    return { host: url.host, hostname: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port: url.port };
  } catch {
    return null;
  }
}

/** 端口省略的条目匹配该主机任意端口；写了端口的必须逐字相等（与宿主同规则）。 */
function authorityTrusted(authority: Authority, trusted: readonly Authority[]): boolean {
  return trusted.some((entry) => (entry.port === '' ? entry.hostname === authority.hostname : entry.host === authority.host));
}

/**
 * 请求是否来自"我们自己那张面板"。三段缺一不可，少任何一段都是一个能绕的法子：
 *
 * 1. **先看 `Host`**：必须是回环或运维声明的可信 authority。只比 `Origin === Host`
 *    挡不住 DNS rebinding —— `evil.com` 解析到 127.0.0.1 时这两个头是相等的。
 * 2. `sec-fetch-site: cross-site` 一律拒（跨站表单 POST 走不到下一步）。
 * 3. 有 `Origin` 时它的 host 必须等于 `Host`；**没有** `Origin` 时放行 —— 本机
 *    浏览器直接打开链接就是这一类，宿主对 `/api` 也是这个姿态。
 *
 * ⚠️ 诚实边界：本机任意进程（`curl` 会老老实实设上这几个头）在围栏范围之外。这道门
 * 挡的是端口扫描、跨站表单与顺手绕过，不挡已被注入的 agent —— 与全仓库的命令白名单
 * 同一定位（见 AGENTS.md 安全硬规则 2）。
 */
export function isSameOriginPanelRequest(
  request: IncomingMessage,
  trustedAuthorities: readonly Authority[],
): boolean {
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  const authority = parseAuthority(host);
  if (authority === null) return false;
  if (!isLoopbackHostname(authority.hostname) && !authorityTrusted(authority, trustedAuthorities)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (typeof origin !== 'string') return true;
  const originAuthority = parseAuthority(origin.replace(/^[a-z]+:\/\//i, ''));
  return originAuthority !== null && originAuthority.host === authority.host;
}

// ── 表单渲染与解析 ────────────────────────────────────────────────────────────

const MAX_BODY = 256 * 1024;

/** 请求体超限。单独成一个类型，是为了让它回 413 而不是被当成 500。 */
class BodyTooLargeError extends Error {
  constructor() {
    super('body too large');
  }
}

/**
 * 读取请求体，超过 `MAX_BODY` 即判定失败。**判定后继续排空而不 destroy**：
 * 直接掐连接会让 413 响应送不出去，人看到的就只剩一个"网络错误"，
 * 而这里想说的其实是"你贴的东西太长"。不累积后续分片，内存仍然有界。
 */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    let rejected = false;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        rejected = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!rejected) resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', (error) => {
      if (!rejected) reject(error);
    });
  });
}

/**
 * 解析 urlencoded 表单。**同名键会重复出现**（复选框组就是一组同名 input），
 * 所以这里按 `, ` 连接而不是后写覆盖 —— 覆盖会把多选答案静默裁成一项。
 * `, ` 同时是问卷答案的序列化分隔符（见 vocab.ts 的 MULTI_VALUE_SEP）。
 */
function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pairs = body.split('&');
  for (const pair of pairs) {
    if (pair === '') continue;
    const index = pair.indexOf('=');
    if (index === -1) continue;
    const key = decodeURIComponent(pair.slice(0, index));
    const value = decodeURIComponent(pair.slice(index + 1).replace(/\+/g, ' '));
    const existing = out[key];
    out[key] = existing === undefined ? value : `${existing}${MULTI_VALUE_SEP}${value}`;
  }
  return out;
}

/**
 * JSON 答复体的取值：字符串原样，字符串数组按分隔符连接（面板的多选就是数组）。
 * 其它形状一律丢掉的值 —— 端点面对的是人手工拼的 JSON，宁可少收也不要猜。
 */
function parseJsonAnswers(body: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = (parsed as { answers?: unknown }).answers ?? parsed;
  if (typeof raw !== 'object' || raw === null) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      out[key] = (value as string[]).join(MULTI_VALUE_SEP);
    }
  }
  return out;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formFieldHtml(field: TicketField): string {
  const name = escapeHtml(field.name);
  const label = escapeHtml(field.label);
  const placeholder = field.placeholder === undefined ? '' : ` placeholder="${escapeHtml(field.placeholder)}"`;
  const required = field.required === true ? ' required' : '';
  const common = `class="field" name="${name}" id="${name}"${placeholder}${required}`;
  const options = (field.options ?? []).map((option) => normalizeOption(option));
  if (field.type === 'textarea') {
    return `<label for="${name}">${label}</label><textarea ${common} rows="5"></textarea>`;
  }
  if (field.type === 'select') {
    // 必填的下拉框若没有预选项，首项必须是空的"请选择"：否则 required 形同虚设，
    // 人不用看选项就能提交掉第一个方案。
    const needsBlank = field.required === true && !options.some((option) => option.checked === true);
    const blank = needsBlank ? `<option value="">${escapeHtml(field.placeholder ?? '请选择…')}</option>` : '';
    const items = options
      .map((option) => `<option value="${escapeHtml(option.value)}"${option.checked === true ? ' selected' : ''}>${escapeHtml(option.label)}${option.impact ? ` — ${escapeHtml(option.impact)}` : ''}</option>`)
      .join('\n');
    return `<label for="${name}">${label}</label><select ${common}>${blank}${items}</select>`;
  }
  if (field.type === 'multiselect') {
    // 复选框组：required 挂在首个 checkbox 上，浏览器把同名复选框当一个组校验；
    // 真正的门在服务端（缺失项会 400 重述），这里只是少一次无谓往返。
    const items = options
      .map(
        (option, index) =>
          `<label class="choice"><input type="checkbox" class="field--inline" name="${name}" value="${escapeHtml(option.value)}"${option.checked === true ? ' checked' : ''}${index === 0 ? required : ''} /><span><b>${escapeHtml(option.label)}</b>${option.impact ? ` <em>${escapeHtml(option.impact)}</em>` : ''}</span></label>`,
      )
      .join('\n');
    return `<fieldset class="group"><legend>${label}</legend>${items}</fieldset>`;
  }
  const inputType = field.type === 'password' ? 'password' : 'text';
  return `<label for="${name}">${label}</label><input type="${inputType}" ${common} />`;
}

function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f5f6f8; color: #1f2329; margin: 0; padding: 24px; }
  .card { max-width: 620px; margin: 24px auto; background: #fff; border-radius: 12px;
    box-shadow: 0 2px 16px rgba(0,0,0,.06); padding: 28px 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 20px; }
  .meta { background: #f0f6ff; border: 1px solid #d6e6ff; border-radius: 8px; padding: 12px 14px;
    font-size: 13px; color: #334155; margin-bottom: 20px; }
  .meta b { color: #0b3b8c; }
  .field { display: block; width: 100%; margin: 6px 0 16px; padding: 10px 12px; border: 1px solid #d1d5db;
    border-radius: 8px; font-size: 14px; }
  .field:focus { outline: 2px solid #3b82f6; border-color: transparent; }
  .field--inline { width: auto; margin: 0 8px 0 0; }
  label { font-size: 13px; font-weight: 600; color: #374151; }
  .group { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px 4px; margin: 6px 0 16px; }
  .group legend { font-size: 13px; font-weight: 600; color: #374151; padding: 0 4px; }
  .choice { display: flex; align-items: baseline; gap: 4px; font-weight: 400; font-size: 14px; margin-bottom: 8px; }
  .choice em, select + em { color: #9ca3af; font-style: normal; font-size: 12px; }
  button { background: #1f6feb; color: #fff; border: none; border-radius: 8px; padding: 11px 20px;
    font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { background: #1858b7; }
  .done { text-align: center; padding: 48px 0; }
  .done .tick { font-size: 48px; }
  .done h2 { margin: 12px 0 4px; }
  .done p { color: #6b7280; }
  .err { color: #b91c1c; font-size: 13px; margin-top: 6px; }
  .btn-row { display: flex; gap: 12px; align-items: center; margin-top: 8px; }
  .hint { font-size: 12px; color: #9ca3af; margin-top: 18px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** 表单主体。`error` 非空时在顶部插一条红字（提交被拒后重述缺什么）。 */
function formBodyHtml(
  action: string,
  ticket: { title: string; notice: string; fields: TicketField[] },
  error: string | null,
): string {
  const fields = ticket.fields.map((field) => formFieldHtml(field)).join('\n');
  const errorBlock = error === null ? '' : `<div class="err" role="alert">${escapeHtml(error)}</div>`;
  return `<div class="card">
<h1>${escapeHtml(ticket.title)}</h1>
<p class="sub">dsh-ai-team 的人工确认工单 — 请填写后提交</p>
<div class="meta">${escapeHtml(ticket.notice)}</div>
${errorBlock}
<form method="post" action="${escapeHtml(action)}">
${fields}
<div class="btn-row"><button type="submit">提交</button><span class="hint">提交即确认以上内容</span></div>
</form>
</div>`;
}

// ── handler ──────────────────────────────────────────────────────────────────

/** 一个挂载点接受哪种凭据。 */
export type TicketTrust =
  /** 独立工单端口：只认 `?t=`。围栏在这里等于没门。 */
  | 'token-only'
  /** 宿主同源路由：面板过围栏即可作答，邮件链接带 token 也认。 */
  | 'fence-or-token';

/**
 * 独立端口那条路由的前缀。与面板用的 `TICKET_ROUTE_PREFIX`（住在 vocab.ts，
 * 因为客户端也要读它）是两件事：这个常量只有服务端读得到。
 */
export const TICKET_PATH_PREFIX = '/ticket';

export interface TicketHandlerOptions {
  /** 挂载前缀，不含尾斜杠。独立端口是 `/ticket`，面板是 `TICKET_ROUTE_PREFIX`。 */
  basePath: string;
  store: TicketStore;
  trust: TicketTrust;
  /** 工单 id → token。未知或已作废返回 `undefined`。 */
  tokenOf: (id: string) => string | undefined;
  /**
   * 除回环之外还认这些 authority（`host` 或 `host:port`）。**每次请求求值**：
   * 挂载那一刻宿主的可信清单（`webRuntime.trustedHosts`）可能还没就位，且它会
   * 随 `--host 0.0.0.0` 这类配置变化而变。
   *
   * 这一清单的用途与宿主对 `/api` 用的完全相同（见 `isSameOriginPanelRequest`）：
   * 面板能调到 `/api` 就必须能答工单，否则面板会一半能用一半 404。
   */
  trustedAuthorities?: () => readonly string[];
  /** 详细原因只进日志。响应体里回显 `error.message` 等于替人做指纹。 */
  warn?: (message: string, error?: unknown) => void;
}

/** `<id>` 允许的形状。锚死整段路径：不锚的话 `/ticket/abc/../../x` 会命中 `abc`。 */
const ROUTE_RE = /^\/([A-Za-z0-9_-]{1,64})(?:\/answer)?\/?$/;

/**
 * 工单端点的请求处理。无状态、不落盘，因此同一个实例可以既挂在独立端口上、
 * 又挂在宿主同源路由上（各一个实例，只差 `basePath` 与 `trust`）。
 */
export class TicketHandler {
  constructor(private readonly options: TicketHandlerOptions) {}

  /** 每次请求解析可信 authority：清单本身是活的（见构造参数上的说明）。 */
  private authorities(): Authority[] {
    return (this.options.trustedAuthorities?.() ?? [])
      .map((entry) => parseAuthority(entry))
      .filter((entry): entry is Authority => entry !== null);
  }

  /** 宿主 `WebRoute.handler` 与 `node:http` 的回调签名，两边共用。绝不抛。 */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      // 畸形 request.url。本方法被 `void handle(...)` 调起来，抛出去就是一条
      // 没人接的 rejection —— 而它能一路把宿主进程带崩。
      TicketHandler.notFound(response);
      return;
    }
    const rest = this.strip(url.pathname);
    if (rest === null) {
      // 前缀对不上却被调到 —— 挂载点写错了，绝不能让它顺手答复工单。
      this.options.warn?.(`ticket: handler mounted at "${this.options.basePath}" got "${url.pathname}"`);
      TicketHandler.notFound(response);
      return;
    }
    if (request.method === 'OPTIONS') {
      // 同源不需要预检；独立端口也不需要（表单是导航与整页提交，不是 fetch）。
      // 明确 405 而不是静默放行，是为了让"这里没有 CORS"成为一个事实而不是一句注释。
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' });
      response.end('method not allowed');
      return;
    }
    const match = ROUTE_RE.exec(rest);
    if (match === null) {
      TicketHandler.notFound(response);
      return;
    }
    const id = match[1]!;
    const json = rest.endsWith('/answer') || rest.endsWith('/answer/');
    // 围栏只授予「作答」，不授予「读表单」：渲染出来的页面里有 `doc_approve` 的
    // 一次性审批码，而本机任意进程（默认命令白名单里有 `node`）都带得动围栏。
    // 于是同源这条路由变成"能替一张已知工单写答案，但读不到任何东西" —— 读侧一律
    // 要 token，那只有拿到邮件的人才有。
    if (!this.authorized(request, url, id, json)) {
      // 与"未知 id"逐字节相同的响应：状态码用 404 而不是 403，是为了不让
      // 扫描者拿响应差别枚举出哪些工单号真的存在（INT-3 场景二）。
      TicketHandler.notFound(response);
      return;
    }
    // 未知 id 在**这条已经过了凭据检查**的分支上也要回同一个 404：否则同源那条
    // 路由（凭围栏放行、没有 token 可比）会用 400 把"这张单子不存在"说出来，
    // 与凭据失败的 404 就成了一个可枚举的判别器。
    if (!this.options.store.hasTicket(id)) {
      TicketHandler.notFound(response);
      return;
    }
    if (request.method === 'GET' && !json) {
      await this.renderForm(response, id);
      return;
    }
    if (request.method === 'POST' && json) {
      await this.submitJson(request, response, id);
      return;
    }
    if (request.method === 'POST') {
      await this.submitForm(request, response, id);
      return;
    }
    TicketHandler.notFound(response);
  }

  /** 剥掉挂载前缀。前缀不匹配返回 null。 */
  private strip(pathname: string): string | null {
    const prefix = this.options.basePath;
    if (pathname === prefix) return '/';
    return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : null;
  }

  /**
   * 凭据检查。token 永远够用（两处挂载都认）；围栏是额外的通行证，且只给
   * `allowFence` 点亮的那条路由 —— 见调用处「只写不读」的说明。
   */
  private authorized(request: IncomingMessage, url: URL, id: string, allowFence: boolean): boolean {
    const provided = url.searchParams.get(TICKET_TOKEN_PARAM);
    if (provided !== null) return TicketHandler.tokenMatches(this.options.tokenOf(id), provided);
    return allowFence && this.options.trust === 'fence-or-token' && isSameOriginPanelRequest(request, this.authorities());
  }

  /**
   * token 比对。长度相同才逐字节比 —— 这是凭据不是文案，别用 `===` 短路成一个
   * 可测的前缀 oracle（与 `QuestionnaireManager.verifyApprovalCode` 同一写法）。
   */
  private static tokenMatches(expected: string | undefined, provided: string): boolean {
    if (expected === undefined) return false;
    const left = Buffer.from(expected, 'utf8');
    const right = Buffer.from(provided, 'utf8');
    if (left.length !== right.length) return false;
    let diff = 0;
    for (let index = 0; index < left.length; index += 1) {
      diff |= left[index]! ^ right[index]!;
    }
    return diff === 0;
  }

  /** 未知 id / 无凭据 / 前缀错三条路径共用同一个响应体，一字节都不能差。 */
  private static notFound(response: ServerResponse): void {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ticket not found');
  }

  /** 表单的提交目标：同源路由靠围栏，邮件那条必须把 token 带上。 */
  private actionFor(id: string): string {
    const base = `${this.options.basePath}/${encodeURIComponent(id)}`;
    const token = this.options.tokenOf(id);
    return token === undefined ? base : ticketUrlWithToken(base, token);
  }

  private async renderForm(response: ServerResponse, id: string): Promise<void> {
    try {
      const ticket = await this.options.store.renderTicket(id);
      if (ticket === null) {
        TicketHandler.notFound(response);
        return;
      }
      // 说明文案由 store 给：升级会说"已标记 needs-human"，问卷会说"AI 在等你的决策，
      // 没有任何东西坏掉"。这一层不该替它决定该怎么向人开口。
      const body = formBodyHtml(this.actionFor(id), ticket, null);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(renderPage(ticket.title, body));
    } catch (error) {
      // 渲染抛错是 bug，不是"这张工单不存在"：以前这里伪装成 404，把故障藏进了
      // 一个语义正确的状态码里。现在如实 500，细节只进日志。
      this.options.warn?.('ticket: form render failed', error);
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('ticket form failed');
    }
  }

  private async submitForm(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    let body: string;
    try {
      body = await readBody(request);
    } catch (error) {
      this.failToReadBody(request, response, error);
      return;
    }
    try {
      await this.applySubmit(response, id, parseForm(body));
    } catch (error) {
      this.options.warn?.('ticket: submit failed', error);
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('submit failed');
    }
  }

  /** 面板那条：JSON 进 JSON 出，缺失项必须回结构化数据而不是一页 HTML。 */
  private async submitJson(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    let body: string;
    try {
      body = await readBody(request);
    } catch (error) {
      this.failToReadBody(request, response, error, true);
      return;
    }
    const answers = parseJsonAnswers(body);
    if (answers === null) {
      TicketHandler.json(response, 400, { ok: false, message: '答复体必须是 JSON 对象' });
      return;
    }
    try {
      const result = await this.options.store.handleSubmit(id, answers);
      TicketHandler.json(response, result.ok ? 200 : 400, result);
    } catch (error) {
      this.options.warn?.('ticket: json submit failed', error);
      TicketHandler.json(response, 500, { ok: false, message: 'submit failed' });
    }
  }

  /**
   * `readBody` 的两种失败：超限是人的问题（413），其余是连接的问题（400）。
   * 响应形状跟着走 HTML 还是 JSON 那条路由。
   */
  private failToReadBody(
    request: IncomingMessage,
    response: ServerResponse,
    error: unknown,
    json = false,
  ): void {
    request.resume();
    const tooLarge = error instanceof BodyTooLargeError;
    const message = tooLarge ? '答复内容过大' : '无法读取答复内容';
    this.options.warn?.('ticket: request body rejected', error);
    if (json) {
      TicketHandler.json(response, tooLarge ? 413 : 400, { ok: false, message });
      return;
    }
    response.writeHead(tooLarge ? 413 : 400, { 'content-type': 'text/html; charset=utf-8' });
    response.end(renderPage(message, `<div class="card"><div class="done"><div class="err">${escapeHtml(message)}</div></div></div>`));
  }

  /** urlencoded 那条路由的落点：成功画成功页，被拒则**重画同一张表单**。 */
  private async applySubmit(
    response: ServerResponse,
    id: string,
    answers: Record<string, string>,
  ): Promise<void> {
    const result = await this.options.store.handleSubmit(id, answers);
    if (result.ok) {
      const html = renderPage(
        '提交成功',
        `<div class="card"><div class="done"><div class="tick">✅</div><h2>感谢确认</h2><p>${escapeHtml(
          result.message ?? '你的答复已收到，AI 团队将据此继续。你可以关闭此页。',
        )}</p></div></div>`,
      );
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    const missing = result.missing ?? [];
    const detail = [
      result.message ?? (missing.length === 0 ? '处理失败，请重试' : '还有必填项没有作答'),
      ...(missing.length === 0 ? [] : [`缺少必填项：${missing.join('、')}`]),
    ].join('；');
    // 只给一个"提交失败"的错误页，人就得回头重答已经填好的那些题 —— 而漏答往往
    // 正是没人愿意答第二次的地方。所以这里连着表单一起重画。
    const ticket = await this.options.store.renderTicket(id);
    const html =
      ticket === null
        ? renderPage('提交失败', `<div class="card"><div class="done"><div class="err">${escapeHtml(detail)}</div></div></div>`)
        : renderPage(ticket.title, formBodyHtml(this.actionFor(id), ticket, detail));
    response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  }

  private static json(response: ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
  }
}

// ── 独立监听（邮件链接那一条）────────────────────────────────────────────────

export interface TicketServerOptions {
  host: string;
  port: number;
  /** 请求处理全部委托给它；本类只管监听与关闭。 */
  handler: TicketHandler;
}

/**
 * 独立端口的工单监听器。绑定失败由调用方决定怎么处理（尽力而为的语义住在
 * `service.ts`），但**绑定地址不是回环属于配置错误**，一律拒绝启动 ——
 * 这个端点收的答案等于替 AI 团队做决策（`docs/design-interaction.md` §8-9）。
 */
export class TicketServer {
  private server: Server | null = null;
  private readonly bound: Promise<void>;
  private resolveBound!: () => void;
  private rejectBound!: (error: Error) => void;
  private boundTo: { host: string; port: number } | null = null;

  constructor(private readonly options: TicketServerOptions) {
    this.bound = new Promise<void>((resolvePromise, reject) => {
      this.resolveBound = resolvePromise;
      this.rejectBound = reject;
    });
  }

  /** 开始监听。绑定完成后 resolve。非回环绑定地址直接抛。 */
  start(): Promise<void> {
    if (this.server !== null) return this.bound;
    if (!isLoopbackHostname(this.options.host)) {
      throw new Error(
        `ticket endpoint refuses to bind "${this.options.host}": 它只该待在回环里，远程访问请走 SSH 隧道（PILOT.md）`,
      );
    }
    const server = createServer((request, response) => {
      void this.options.handler.handle(request, response);
    });
    server.on('error', (error) => this.rejectBound(error instanceof Error ? error : new Error(String(error))));
    server.on('listening', () => {
      const address = server.address();
      this.boundTo =
        typeof address === 'object' && address !== null ? { host: address.address, port: address.port } : null;
      this.resolveBound();
    });
    server.listen(this.options.port, this.options.host);
    this.server = server;
    return this.bound;
  }

  /** 实际绑定的端点（例如 127.0.0.1:0 → 127.0.0.1:43210）。 */
  get address(): { host: string; port: number } | null {
    return this.boundTo;
  }

  async close(): Promise<void> {
    if (this.server === null) return;
    await new Promise<void>((resolvePromise) => {
      this.server?.close(() => resolvePromise());
      this.server = null;
    });
  }
}

// ── 面板团队切换（P3-2）──────────────────────────────────────────────────────

/** 面板切换当前团队的数据源。 */
export interface TeamSwitchStore {
  /** 切换当前团队；返回 false 表示团队不存在。 */
  switchTeam(teamId: string): boolean;
}

export interface TeamSwitchHandlerOptions {
  store: TeamSwitchStore;
  /** 与工单同源的围栏清单（见 TicketHandlerOptions.trustedAuthorities）。 */
  trustedAuthorities?: () => readonly string[];
  warn?: (message: string, error?: unknown) => void;
}

/**
 * 面板团队切换端点。只认**同源面板**的 POST —— 这是视图偏好，不是决策，
 * 但围栏照旧：本机任意进程都不该能改别人面板在看哪个团队。
 */
export class TeamSwitchHandler {
  constructor(private readonly options: TeamSwitchHandlerOptions) {}

  private authorities(): Authority[] {
    return (this.options.trustedAuthorities?.() ?? [])
      .map((entry) => parseAuthority(entry))
      .filter((entry): entry is Authority => entry !== null);
  }

  /** 宿主 `WebRoute.handler` 与 `node:http` 回调签名共用。绝不抛。 */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || !isSameOriginPanelRequest(request, this.authorities())) {
      // 与工单同姿态：围栏失败回 404，不给扫描者任何判别面。
      TeamSwitchHandler.notFound(response);
      return;
    }
    let body: string;
    try {
      body = await readBody(request);
    } catch (error) {
      this.options.warn?.('team-switch: request body rejected', error);
      request.resume();
      TeamSwitchHandler.json(response, 400, { ok: false, message: '无法读取请求体' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      TeamSwitchHandler.json(response, 400, { ok: false, message: '请求体必须是 JSON 对象' });
      return;
    }
    const teamId = (parsed as { teamId?: unknown } | null)?.teamId;
    if (typeof teamId !== 'string' || teamId === '') {
      TeamSwitchHandler.json(response, 400, { ok: false, message: '缺少 teamId' });
      return;
    }
    if (!this.options.store.switchTeam(teamId)) {
      TeamSwitchHandler.notFound(response);
      return;
    }
    TeamSwitchHandler.json(response, 200, { ok: true });
  }

  private static notFound(response: ServerResponse): void {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('team not found');
  }

  private static json(response: ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
  }
}
