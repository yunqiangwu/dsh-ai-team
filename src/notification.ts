/**
 * 人工通知闭环的**出向**那一半 —— 无人值守的守护进程在需要人时如何联系到人
 * （spec §4.4 "needs-human"：确认决策、提供密钥、回答问题）。两条通道，刻意与
 * 守护进程主循环以及 cordis 解耦：
 *
 * 1. **`Mailer`** —— 基于 Node 内置 `net`/`tls` 实现的 SMTP 客户端（无第三方
 *    依赖，因此在只装了 Node 的裸机上也可用）。凭据按 env var NAMES 读取，并
 *    注册到 SecretRedactor，确保敏感信息绝不落入日志。它负责发送人类可读的
 *    摘要以及工单链接。
 *
 * 2. **`postHumanWebhook`** —— 一条通用 HTTP 钩子（IM 群机器人之类）。
 *
 * **入向**那一半（工单表单怎么画、答复怎么收、token 与同源围栏怎么判）住在
 * `ticket-handler.ts`。本模块只把工单链接写进文案，不认识那个端点的形状。
 *
 * 投递状态作为记录上的数据（mailDelivered、ticketUrl、submitted）保存，
 * 这样 Web 面板和升级信息流就能呈现是否真的联系上了人、工单是否已被答复。
 */
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { resolveOptionalEnvRef, SecretRedactor } from './secrets.js';

// ── mailer ───────────────────────────────────────────────────────────────────

export interface MailerOptions {
  host: string;
  port: number;
  /** SMTP 登录用户名的环境变量名（账号）。 */
  userEnv: string;
  /** SMTP 密码 / 授权码的环境变量名。 */
  passEnv: string;
  /** "From" 地址的环境变量名；缺省回落到 userEnv。 */
  fromEnv?: string | undefined;
  /** 隐式 TLS（端口 465）。为 true 时，AUTH 之前没有明文阶段。 */
  secure: boolean;
  /**
   * 在明文连接上发起 STARTTLS（端口 587/25）。默认 true。
   * 对完全没有 TLS 的裸机 / 测试 relay 设为 false。
   */
  startTls?: boolean | undefined;
  redactor: SecretRedactor;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * 一个刻意保持极简的 SMTP 客户端。支持 AUTH LOGIN + STARTTLS（以及通过
 * `secure` 的隐式 TLS），可覆盖 QQ / 163 / Gmail / 通用 relay。
 * 失败以抛出的字符串呈现；由调用方决定投递策略。
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

  /** 把逗号/空格分隔的收件人列表拆成地址。 */
  private recipients(to: string): string[] {
    return to
      .split(/[,\s;]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  /** 发送一条消息。任何协议错误都会抛出一个描述性的字符串。 */
  async send(message: MailMessage): Promise<{ ok: true; messageId: string }> {
    const user = this.user();
    const pass = this.pass();
    const from = this.from();
    const recipients = this.recipients(message.to);
    if (recipients.length === 0) throw new Error('notification: no recipients in mail message');

    // 登记凭据，这样任何意外进入日志的行都会被抹掉。
    this.options.redactor.register(user);
    this.options.redactor.register(pass);

    let socket: net.Socket | tls.TLSSocket | null = null;

    /** 读一条 SMTP 回复：code + 最终行。累加多行（250-）回复。 */
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
            // 一条回复的最终行是 "<code> <text>"；续行用 '<code>-'.
            if (pendingCode === null) {
              pendingCode = code;
              lastLine = line;
            } else {
              lastLine = line;
            }
            const isFinal = line.length > 3 ? line[3] === ' ' : true;
            if (!isFinal) {
              index = buffer.indexOf('\n');
              continue; // 后面还有续行
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
        // 明文连接 → STARTTLS 升级（端口 587/25 → 隐式 TLS）。
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
        // 隐式 TLS（secure:true）或关闭 startTls 的明文 relay：
        // 无需升级，直接 EHLO 后 AUTH。
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

      // RFC 5321 §4.5.2 点填充：仅行首的 `.` 需要再加一个 `.`，接收方会剥掉。
      // 注意不能把正文里的句点也翻倍 —— 那会原样送达，静默损坏内容。
      const body = `\r\n${message.text.replace(/^\./gm, '..')}`;
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

// ── webhook ──────────────────────────────────────────────────────────────────

/**
 * 给人看的 webhook 投递（IM / 飞书群机器人 / 任意 HTTP 钩子）。
 *
 * 失败一律折成 `false`：投递状态是记录上的数据，不是流程开关 —— 一条发不出去的
 * 通知不该让问卷创建失败。URL 里常常带着 token（Slack 类钩子就是），所以读出来
 * 就登记进脱敏器。
 *
 * ⚠️ 升级侧仍用它自己那份 `EscalationManager.deliverWebhook`：本次改动明确不动
 * `escalate.ts` 的行为（`.tasks/INT-2.md` 场景一要求 `escalate` 一字不改），
 * 所以这里只服务问卷。两条路径合并是后续的搬家工作，不是遗漏。
 */
export async function postHumanWebhook(input: {
  urlEnv?: string | undefined;
  text: string;
  payload: Record<string, unknown>;
  redactor: SecretRedactor;
  fetchFn?: typeof fetch | undefined;
}): Promise<boolean> {
  const url = resolveOptionalEnvRef(input.urlEnv);
  if (url === undefined) return false;
  input.redactor.register(url);
  const fetchImpl = input.fetchFn ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: input.redactor.redact(input.text), ...input.payload }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 升级通知邮件的文案渲染（纯函数）：service 只负责发送与状态记录。
 * 放在这里而不是 service.ts，是为了让邮件文案与 Mailer 靠在一起，
 * 改措辞时不用翻两千行的编排文件。
 */
export function renderEscalationMail(input: {
  /** 展示主体：任务标题，或部署 / 全局事件。 */
  subject: string;
  reason: string;
  message: string;
  suggestion: string;
  /** 带 token 的工单链接；未配置工单端点时为 null。 */
  link: string | null;
}): { subject: string; text: string } {
  const text = [
    `[dsh-ai-team] 需要你的人工确认`,
    ``,
    `任务: ${input.subject}`,
    `原因: ${input.reason}`,
    `说明: ${input.message}`,
    ``,
    `建议动作: ${input.suggestion}`,
    ``,
    input.link === null ? `（未配置工单端点，请在 dsh 面板查看）` : `请填写工单以继续：${input.link}`,
    ``,
    `回答会回写到任务单；如需密钥请用环境变量提供，勿粘贴明文。`,
  ].join('\n');
  return { subject: `[dsh-ai-team] 人工确认: ${input.subject}`, text };
}
