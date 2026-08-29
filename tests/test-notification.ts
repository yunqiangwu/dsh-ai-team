/**
 * Human-notification loop tests.
 *
 * - Mailer against a real in-process mock SMTP server (node:net) verifying the
 *   full AUTH LOGIN + DATA handshake a real relay expects.
 * - TicketServer over a real ephemeral port: GET renders, POST parses
 *   urlencoded answers and hands them to the store.
 * - Service integration: with notification enabled, an escalation records a
 *   notification state and (with autoResume) a submitted ticket clears it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { Mailer, TicketServer, type TicketStore } from '../src/notification.js';
import { SecretRedactor } from '../src/secrets.js';
import { AutopilotService } from '../src/service.js';
import { makeFixture, testOptions } from './helpers.js';

// ── mock SMTP ────────────────────────────────────────────────────────────────

interface SmtpMock {
  server: net.Server;
  port: number;
  /** Every line the client sent, for assertions. */
  lines: string[];
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  close(): Promise<void>;
}

function startMockSmtp(): Promise<SmtpMock> {
  const lines: string[] = [];
  const server = net.createServer((socket) => {
    // Greeting.
    socket.write('220 mock ESMTP\r\n');
    let buffer = '';
    let dataMode = false;
    let authStep = 0; // 0 = none, 1 = await username, 2 = await password
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        lines.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          socket.write('250-mock\r\n250 OK\r\n');
        } else if (upper.startsWith('STARTTLS')) {
          socket.write('454 TLS not available\r\n');
        } else if (upper.startsWith('AUTH LOGIN')) {
          authStep = 1;
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (authStep === 1 && isBase64ish(line)) {
          authStep = 2;
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (authStep === 2 && isBase64ish(line)) {
          authStep = 0;
          socket.write('235 OK\r\n');
        } else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) {
          socket.write('250 OK\r\n');
        } else if (upper.startsWith('DATA')) {
          dataMode = true;
          socket.write('354 end with .\r\n');
        } else if (dataMode && line === '.') {
          dataMode = false;
          socket.write('250 OK\r\n');
        } else if (upper.startsWith('QUIT')) {
          socket.write('221 bye\r\n');
          socket.end();
        }
      }
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolvePromise({
        server,
        port: address.port,
        lines,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function isBase64ish(line: string): boolean {
  // A UTF-8 string base64-encoded (excludes SMTP cross-section keywords).
  return /^[A-Za-z0-9+/=]+$/u.test(line) && line.length > 0 && !/[ :]/u.test(line);
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('notification: mailer', () => {
  let mock: { port: number; lines: string[]; close(): Promise<void> } | null = null;

  beforeAll(async () => {
    mock = await startMockSmtp();
  });

  afterAll(async () => {
    await mock?.close();
  });

  it('sends via AUTH LOGIN full handshake (plain → no TLS path)', async () => {
    process.env.TEST_SMTP_USER = 'mailer@example.com';
    process.env.TEST_SMTP_PASS = 'secret-code';
    const redactor = new SecretRedactor();
    const mailer = Mailer.create({
      host: '127.0.0.1',
      port: mock!.port,
      secure: false,
      startTls: false,
      userEnv: 'TEST_SMTP_USER',
      passEnv: 'TEST_SMTP_PASS',
      redactor,
    });
    const result = await mailer.send({
      to: 'ops@example.com',
      subject: '[dsh-ai-team] need human',
      text: 'Please confirm. Link: http://x/ticket/1',
    });
    expect(result.ok).toBe(true);
    expect(result.messageId).toMatch(/^dsh-ai-team-/u);
    const joined = mock!.lines.join('\n');
    expect(joined).toContain('AUTH LOGIN');
    expect(joined).toContain('MAIL FROM:<mailer@example.com>');
    expect(joined).toContain('RCPT TO:<ops@example.com>');
    expect(joined).toContain('DATA');
    expect(joined).toContain('Please confirm');
    // Credentials must never appear in the transcript.
    expect(joined).not.toContain('secret-code');
  }, 15_000);

  it('dot-stuffs only leading dots and leaves interior periods intact', async () => {
    process.env.TEST_SMTP_USER = 'mailer@example.com';
    process.env.TEST_SMTP_PASS = 'secret-code';
    const mailer = Mailer.create({
      host: '127.0.0.1',
      port: mock!.port,
      secure: false,
      startTls: false,
      userEnv: 'TEST_SMTP_USER',
      passEnv: 'TEST_SMTP_PASS',
      redactor: new SecretRedactor(),
    });
    await mailer.send({
      to: 'ops@example.com',
      subject: 'dot stuffing',
      text: 'release v1.2 is ready\r\n.hidden dotfile line',
    });
    const joined = mock!.lines.join('\n');
    expect(joined).toContain('release v1.2 is ready');
    expect(joined).not.toContain('v1..2');
    expect(joined).toContain('..hidden dotfile line');
  }, 15_000);

  it('fails loudly when SMTP credentials are missing', async () => {
    delete process.env.TEST_SMTP_USER;
    delete process.env.TEST_SMTP_PASS;
    const mailer = Mailer.create({
      host: '127.0.0.1',
      port: mock!.port,
      secure: false,
      userEnv: 'TEST_SMTP_USER',
      passEnv: 'TEST_SMTP_PASS',
      redactor: new SecretRedactor(),
    });
    await expect(
      mailer.send({ to: 'ops@example.com', subject: 'x', text: 'y' }),
    ).rejects.toThrow();
  }, 15_000);
});

describe('notification: ticket server', () => {
  it('renders a form and accepts a urlencoded submission', async () => {
    const store: TicketStore = {
      renderTicket: async (id) => {
        if (id === 'nope') return null;
        return {
          title: `Confirm ${id}`,
          fields: [
            { name: 'decision', label: 'Decision', type: 'textarea', required: true },
            { name: 'note', label: 'Note', type: 'text' },
          ],
        };
      },
      handleSubmit: async (id, answers) => {
        expect(id).toBe('esc_abc');
        expect(answers.decision).toBe('use new key');
        return { ok: true };
      },
    };
    const server = new TicketServer({ host: '127.0.0.1', port: 0, store });
    await server.start();
    const bound = server.address;
    expect(bound).not.toBeNull();
    const base = `http://${bound!.host}:${bound!.port}`;

    const render = await fetch(`${base}/ticket/esc_abc`);
    expect(render.status).toBe(200);
    const html = await render.text();
    expect(html).toContain('Confirm esc_abc');
    expect(html).toContain('textarea');

    const submit = await fetch(`${base}/ticket/esc_abc`, {
      method: 'POST',
      body: 'decision=use+new+key&note=hi',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(submit.status).toBe(200);
    expect(await submit.text()).toContain('感谢');

    const missing = await fetch(`${base}/ticket/nope`);
    expect(missing.status).toBe(404);

    await server.close();
  }, 15_000);
});

describe('notification: service integration', () => {
  it('records notification state on escalation (mail disabled path)', async () => {
    const fixture = await makeFixture('notify');
    const service = await AutopilotService.create(
      testOptions(fixture, {
        notification: {
          enabled: true,
          smtp: { host: '127.0.0.1', port: 0, secure: false, userEnv: 'X', passEnv: 'Y' },
          mailTo: 'ops@example.com',
          ticket: { host: '127.0.0.1', port: 0, publicBaseUrl: 'http://localhost:3000' },
          autoResume: false,
        },
      }),
    );
    try {
      const team = await service.createTeam({ name: 'notify-team' });
      await service.addMember({ teamId: team.id, role: 'developer' });
      const record = await service.escalateTask({
        taskId: null,
        reason: 'manual',
        message: 'please confirm',
        suggestion: 'approve',
      });
      expect(record.notification).not.toBeNull();
      // No real SMTP relay configured → the notification is recorded as failed,
      // but never throws.
      expect(record.notification!.status).toBe('failed');
      expect(record.notification!.ticketUrl).toBe('http://localhost:3000/ticket/' + record.id);
    } finally {
      await service.dispose();
    }
  }, 20_000);

  it('autoResume: submitted ticket re-opens the task and resumes the loop', async () => {
    const fixture = await makeFixture('notify-auto');
    const service = await AutopilotService.create(
      testOptions(fixture, {
        notification: {
          enabled: true,
          smtp: { host: '127.0.0.1', port: 0, secure: false, userEnv: 'X', passEnv: 'Y' },
          mailTo: 'ops@example.com',
          ticket: { host: '127.0.0.1', port: 0, publicBaseUrl: 'http://localhost:3000' },
          autoResume: true,
        },
      }),
    );
    try {
      const team = await service.createTeam({ name: 'notify-team' });
      await service.addMember({ teamId: team.id, role: 'developer' });
      const record = await service.escalateTask({
        taskId: null,
        reason: 'manual',
        message: 'please confirm',
        suggestion: 'approve',
      });
      expect(record.notification).not.toBeNull();
      expect(record.notification!.status).toBe('failed');

      // Drive the exact path a filled ticket takes.
      const submitted = await service.submitTicketAnswer(record.id, {
        decision: 'proceed',
        note: 'use prod key',
      });
      expect(submitted.ok).toBe(true);
      expect(record.notification!.submitted).not.toBeNull();
      expect(record.notification!.submittedAt).not.toBeNull();
      expect(record.notification!.autoResumed).toBe(true);
      // autoResume resolves the escalation inline.
      expect(record.resolvedAt).not.toBeNull();
    } finally {
      await service.dispose();
    }
  }, 20_000);
});
