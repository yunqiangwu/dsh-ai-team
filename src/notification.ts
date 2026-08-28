/**
 * Human-notification loop — how the unattended daemon reaches a person when it
 * needs one (spec §4.4 "needs-human": confirm a decision, provide a secret,
 * answer a question).
 *
 * Two halves, deliberately decoupled from the daemon loop and from cordis:
 *
 * 1. **`Mailer`** — an SMTP client built on Node's built-in `net`/`tls` (no
 *    third-party dependency, so it works on a bare host with only Node
 *    present). Credentials are read from env var NAMES and registered with the
 *    SecretRedactor so nothing sensitive ever hits a log. It sends the
 *    human-readable summary plus a ticket link.
 *
 * 2. **`TicketServer`** — a tiny local HTTP endpoint serving one form per
 *    escalation (`GET /ticket/<id>`), and accepting the POSTed answers
 *    (`POST /ticket/<id>`). It never stores anything on disk; the submitted
 *    payload is handed to a callback the service wires up, which writes the
 *    answer back to the task contract and (when `autoResume`) clears the
 *    escalation and resumes the loop.
 *
 * Delivery status is data on the record (mailDelivered, ticketUrl, submitted),
 * so the Web panel and the escalation feed can surface whether the human was
 * actually reached and whether a ticket has been answered.
 */
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolveOptionalEnvRef, SecretRedactor } from './secrets.js';

// ── mailer ───────────────────────────────────────────────────────────────────

export interface MailerOptions {
  host: string;
  port: number;
  /** Env var name for the SMTP login username (account). */
  userEnv: string;
  /** Env var name for the SMTP password / auth code. */
  passEnv: string;
  /** Env var name for the "From" address; defaults to userEnv. */
  fromEnv?: string | undefined;
  /** Implicit TLS (port 465). When true, no plaintext precedes AUTH. */
  secure: boolean;
  /**
   * Issue STARTTLS on a plaintext connection (port 587/25). Defaults to true.
   * Set false for a bare host / test relay with no TLS at all.
   */
  startTls?: boolean | undefined;
  redactor: SecretRedactor;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string | undefined;
}

/**
 * A deliberately minimal SMTP client. Supports AUTH LOGIN + STARTTLS (and
 * implicit TLS via `secure`), which covers QQ / 163 / Gmail / generic relays.
 * Failures are surfaced as thrown strings; the caller decides delivery policy.
 */
export class Mailer {
  constructor(private readonly options: MailerOptions) {}

  static create(options: MailerOptions): Mailer {
    return new Mailer(options);
  }

  private user(): string {
    const value = resolveOptionalEnvRef(this.options.userEnv);
    if (value === undefined) throw new Error(`notification: SMTP user env "${this.options.userEnv}" is unset`);
    return value;
  }

  private pass(): string {
    const value = resolveOptionalEnvRef(this.options.passEnv);
    if (value === undefined) throw new Error(`notification: SMTP pass env "${this.options.passEnv}" is unset`);
    return value;
  }

  private from(): string {
    const value = resolveOptionalEnvRef(this.options.fromEnv);
    return value ?? this.user();
  }

  /** Split a comma/space-separated recipient list into addresses. */
  private recipients(to: string): string[] {
    return to
      .split(/[,\s;]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  /** Send one message. Throws a descriptive string on any protocol error. */
  async send(message: MailMessage): Promise<{ ok: true; messageId: string }> {
    const user = this.user();
    const pass = this.pass();
    const from = this.from();
    const recipients = this.recipients(message.to);
    if (recipients.length === 0) throw new Error('notification: no recipients in mail message');

    // Register credentials so any accidental log line is scrubbed.
    this.options.redactor.register(user);
    this.options.redactor.register(pass);

    let socket: net.Socket | tls.TLSSocket | null = null;

    /** Read one SMTP reply: code + final line. Accumulates multi-line (250-) replies. */
    const readLine = (): Promise<{ code: number; line: string }> =>
      new Promise((resolvePromise, reject) => {
        const done = (code: number, line: string) => {
          cleanup();
          resolvePromise({ code, line });
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        let buffer = '';
        let pendingCode: number | null = null;
        let lastLine = '';
        const onData = (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let index = buffer.indexOf('\n');
          while (index !== -1) {
            const line = buffer.slice(0, index).replace(/\r$/, '');
            buffer = buffer.slice(index + 1);
            const code = Number.parseInt(line.slice(0, 3), 10);
            if (Number.isNaN(code)) {
              fail(new Error(`SMTP unexpected reply: ${line}`));
              return;
            }
            // A reply's final line is "<code> <text>"; continuation lines use '<code>-'.
            if (pendingCode === null) {
              pendingCode = code;
              lastLine = line;
            } else {
              lastLine = line;
            }
            const isFinal = line.length > 3 ? line[3] === ' ' : true;
            if (!isFinal) {
              index = buffer.indexOf('\n');
              continue; // more continuation lines coming
            }
            done(pendingCode, lastLine);
            return;
          }
        };
        const onError = (error: Error) => fail(error);
        const onEnd = () => fail(new Error('SMTP connection closed unexpectedly'));
        const cleanup = () => {
          socket?.off('data', onData);
          socket?.off('error', onError);
          socket?.off('end', onEnd);
        };
        socket?.on('data', onData);
        socket?.on('error', onError);
        socket?.on('end', onEnd);
      });

    const sendLine = (line: string): Promise<void> =>
      new Promise((resolvePromise, reject) => {
        if (socket === null) return reject(new Error('SMTP socket not connected'));
        socket.write(`${line}\r\n`, (error) => (error === null ? resolvePromise() : reject(error)));
      });

    const writeRaw = (data: string): Promise<void> =>
      new Promise((resolvePromise, reject) => {
        if (socket === null) return reject(new Error('SMTP socket not connected'));
        socket.write(data, (error) => (error === null ? resolvePromise() : reject(error)));
      });

    const createSocket = (): net.Socket =>
      this.options.secure
        ? tls.connect({ host: this.options.host, port: this.options.port, servername: this.options.host })
        : net.connect({ host: this.options.host, port: this.options.port });

    const expect = async (code: number): Promise<void> => {
      const reply = await readLine();
      if (reply.code !== code) {
        throw new Error(`SMTP expected ${code}, got ${reply.code}: ${reply.line}`);
      }
    };

    try {
      socket = createSocket();
      const connected = new Promise<void>((resolvePromise, reject) => {
        socket!.once('error', reject);
        socket!.once(socket instanceof tls.TLSSocket ? 'secureConnect' : 'connect', resolvePromise);
      });
      await connected;
      socket = socket as net.Socket | tls.TLSSocket;

      await expect(220); // greeting

      if (!this.options.secure && this.options.startTls !== false) {
        // Plain connect → STARTTLS upgrade (port 587/25 → implicit TLS).
        await sendLine('EHLO dsh-ai-team');
        const ehlo = await readLine();
        if (ehlo.code !== 250) throw new Error(`SMTP EHLO failed: ${ehlo.line}`);
        await sendLine('STARTTLS');
        await expect(220);
        const rawSocket = socket as net.Socket;
        socket = tls.connect({ socket: rawSocket, servername: this.options.host });
        const upgraded = new Promise<void>((resolvePromise, reject) => {
          socket!.once('error', reject);
          socket!.once('secureConnect', resolvePromise);
        });
        await upgraded;
        await sendLine('EHLO dsh-ai-team');
        const ehloTls = await readLine();
        if (ehloTls.code !== 250) throw new Error(`SMTP EHLO after TLS failed: ${ehloTls.line}`);
      } else {
        // implicit TLS (secure:true) or a plaintext relay with startTls off:
        // nothing to upgrade, just take EHLO then AUTH.
        await sendLine('EHLO dsh-ai-team');
        const ehlo = await readLine();
        if (ehlo.code !== 250) throw new Error(`SMTP EHLO failed: ${ehlo.line}`);
      }

      await sendLine('AUTH LOGIN');
      await expect(334);
      await sendLine(Buffer.from(user, 'utf8').toString('base64'));
      await expect(334);
      await sendLine(Buffer.from(pass, 'utf8').toString('base64'));
      await expect(235);

      await sendLine(`MAIL FROM:<${from}>`);
      await expect(250);
      for (const recipient of recipients) {
        await sendLine(`RCPT TO:<${recipient}>`);
        await expect(250);
      }

      await sendLine('DATA');
      await expect(354);

      const encodedHeaders = [
        `From: ${from}`,
        `To: ${recipients.join(', ')}`,
        `Subject: ${sanitizeHeader(message.subject)}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        'Date: ' + new Date().toUTCString(),
      ].join('\r\n');

      const body = `\r\n${message.text.replace(/\./g, '..').replace(/^\./gm, '..')}`;
      const payload = `${encodedHeaders}\r\n\r\n${body}\r\n.\r\n`;
      await writeRaw(payload);
      await expect(250);

      await sendLine('QUIT');
      const messageId = `dsh-ai-team-${randomUUID().slice(0, 12)}`;
      socket.end();
      socket = null;
      return { ok: true, messageId };
    } catch (error) {
      try {
        socket?.end();
      } catch {
        /* ignore */
      }
      throw error instanceof Error ? new Error(`mail send failed: ${error.message}`) : new Error(String(error));
    }
  }
}

function sanitizeHeader(value: string): string {
  return value.replace(/[^\w @./:,()[\]-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── ticket server ───────────────────────────────────────────────────────────

/** Where a filled ticket lands: the callbacks the service wires up. */
export interface TicketStore {
  /**
   * Render the form for one escalation. The store implementation is free to
   * look up escalation context (reason / message / suggestion / taskId) by id
   * and shape it into fields; this module stays agnostic of escalation shape.
   */
  renderTicket(id: string): Promise<{ title: string; fields: TicketField[] } | null>;
  /** Called once a ticket is submitted; returns answers to persist. */
  handleSubmit(
    id: string,
    answers: Record<string, string>,
  ): Promise<{ ok: boolean; message?: string }>;
}

export interface TicketField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'password' | 'select';
  required?: boolean;
  options?: string[];
  placeholder?: string;
}

export interface TicketServerOptions {
  host: string;
  port: number;
  store: TicketStore;
  /** "From" label shown on the form; not network-bound. */
  publicUrl?: string | undefined;
}

const MAX_BODY = 256 * 1024;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    request.on('error', (error) => reject(error));
  });
}

function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pairs = body.split('&');
  for (const pair of pairs) {
    if (pair === '') continue;
    const index = pair.indexOf('=');
    if (index === -1) continue;
    const key = decodeURIComponent(pair.slice(0, index));
    const value = decodeURIComponent(pair.slice(index + 1).replace(/\+/g, ' '));
    out[key] = value;
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
  if (field.type === 'textarea') {
    return `<label for="${name}">${label}</label><textarea ${common} rows="5"></textarea>`;
  }
  if (field.type === 'select') {
    const options = (field.options ?? [])
      .map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`)
      .join('\n');
    return `<label for="${name}">${label}</label><select ${common}>${options}</select>`;
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
  label { font-size: 13px; font-weight: 600; color: #374151; }
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

/**
 * The local ticket endpoint. Listens on host:port; every request carries a
 * ticket id. GET renders the form; POST parses urlencoded answers and hands
 * them to the store. Returns null on failure to bind (the service records a
 * warning and keeps going — notification is best-effort, never fatal).
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

  /** Start listening. Resolves once bound. */
  start(): Promise<void> {
    if (this.server !== null) return this.bound;
    const server = createServer((request, response) => {
      void this.handle(request, response);
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

  /** The actual bound endpoint (e.g. 127.0.0.1:0 → 127.0.0.1:43210). */
  get address(): { host: string; port: number } | null {
    return this.boundTo;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const match = /^\/ticket\/([A-Za-z0-9_-]+)/.exec(url.pathname);
    if (request.method === 'GET' && match !== null) {
      await this.renderForm(response, match[1]!);
      return;
    }
    if (request.method === 'POST' && match !== null) {
      await this.submitForm(request, response, match[1]!);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  }

  private async renderForm(response: ServerResponse, id: string): Promise<void> {
    try {
      const ticket = await this.options.store.renderTicket(id);
      if (ticket === null) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('ticket not found');
        return;
      }
      const fields = ticket.fields
        .map((field) => formFieldHtml(field))
        .join('\n');
      const body = `<div class="card">
<h1>${escapeHtml(ticket.title)}</h1>
<p class="sub">dsh-ai-team 的人工确认工单 — 请填写后提交</p>
<div class="meta">该任务已被 AI 团队标记为 <b>needs-human</b>，需要你确认决策、提供密钥或补充信息。提交后系统会自动处理。</div>
<form method="post" action="/ticket/${escapeHtml(id)}">
${fields}
<div class="btn-row"><button type="submit">提交</button><span class="hint">提交即确认以上内容</span></div>
</form>
</div>`;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(renderPage(ticket.title, body));
    } catch (error) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`ticket not found: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async submitForm(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    try {
      const body = await readBody(request);
      const answers = parseForm(body);
      const result = await this.options.store.handleSubmit(id, answers);
      if (!result.ok) {
        const html = renderPage('提交失败', `<div class="card"><div class="done"><div class="err">${escapeHtml(
          result.message ?? '处理失败，请重试',
        )}</div><p><a href="/ticket/${escapeHtml(id)}">返回工单</a></p></div></div>`);
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html);
        return;
      }
      const html = renderPage(
        '提交成功',
        `<div class="card"><div class="done"><div class="tick">✅</div><h2>感谢确认</h2><p>你的答复已收到，AI 团队将据此继续。你可以关闭此页。</p></div></div>`,
      );
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`submit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async close(): Promise<void> {
    if (this.server === null) return;
    await new Promise<void>((resolvePromise) => {
      this.server?.close(() => resolvePromise());
      this.server = null;
    });
  }
}

export { resolveOptionalEnvRef };
