/**
 * 共享 shell runner 的行为锁定测试。
 *
 * 这组用例先针对现有的 `runGateCommand` 写，目的是在把 gates / deploy /
 * bootstrap 三份近乎复制的 runShell 合并成一个模块**之前**，把当前语义钉死：
 * 超时折算成 exitCode 1（而不是抛错）、只有 abort 才 reject、CI=true 注入、
 * 日志尾保留最后 4000 字符。合并之后这些断言必须一条不改地继续通过 ——
 * 那就是"纯搬家、没改行为"的证据。
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGateCommand } from '../src/gates.js';
import type { RunGatesOptions } from '../src/gates.js';
import { SecretRedactor } from '../src/secrets.js';

/** 本用例自己允许的指令集：只测 runner 语义，不测项目真实白名单。 */
const allowlist = ['sh', 'git', 'echo', 'cat', 'sleep'];

async function gateOptions(overrides: Partial<RunGatesOptions> = {}): Promise<RunGatesOptions> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-ai-team-exec-'));
  return {
    cwd,
    commands: [],
    allowlist,
    timeoutMs: 5_000,
    redactor: new SecretRedactor(),
    taskId: 't',
    branch: 'b',
    ...overrides,
  };
}

describe('exec: shell runner semantics', () => {
  it('a plain command resolves with its exit code and captured tail', async () => {
    const result = await runGateCommand('echo hello-out', await gateOptions());
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.logTail.trim()).toBe('hello-out');
  });

  it('non-zero exit is data, not an exception', async () => {
    const result = await runGateCommand('sh -c "exit 3"', await gateOptions());
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(3);
  });

  it('captures stderr as well as stdout', async () => {
    const result = await runGateCommand('cat ./definitely-missing-file', await gateOptions());
    expect(result.passed).toBe(false);
    expect(result.logTail).toMatch(/No such file/);
  });

  it('a timeout is folded into a failed gate (exitCode 1), it does not hang or throw', async () => {
    const started = Date.now();
    const result = await runGateCommand('sleep 30', await gateOptions({ timeoutMs: 80 }));
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    // 确实是被杀掉的，不是等 sleep 自己跑完
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('an aborted signal rejects so the daemon loop can unwind', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runGateCommand('echo hi', await gateOptions({ signal: controller.signal })),
    ).rejects.toThrow(/aborted/);
  });

  it('aborting mid-run rejects instead of waiting for the command to finish', async () => {
    const controller = new AbortController();
    const pending = runGateCommand('sleep 30', await gateOptions({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 60);
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it('gate commands see CI=true in the environment', async () => {
    const result = await runGateCommand('echo "ci=$CI"', await gateOptions());
    expect(result.logTail.trim()).toBe('ci=true');
  });

  it('secrets are redacted out of the captured tail', async () => {
    const redactor = new SecretRedactor();
    redactor.register('hunter2-token-value');
    const result = await runGateCommand('echo "key=hunter2-token-value"', await gateOptions({ redactor }));
    expect(result.logTail).not.toContain('hunter2-token-value');
    expect(result.logTail).toContain('***');
  });

  it('output longer than the tail budget keeps the LAST 4000 characters', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-ai-team-exec-tail-'));
    const big = join(cwd, 'big.txt');
    await writeFile(big, 'a'.repeat(40_000), 'utf8');
    const result = await runGateCommand(`cat ${big}`, await gateOptions({ cwd, timeoutMs: 20_000 }));
    expect(result.logTail.length).toBe(4_000);
    expect(result.logTail).toBe('a'.repeat(4_000));
  });

  it('commands outside the allowlist never reach the shell', async () => {
    await expect(runGateCommand('rm -rf /tmp/nope', await gateOptions())).rejects.toThrow(/allowlist/);
    // 链式命令的每个片段都要单独过检
    await expect(runGateCommand('echo ok && rm -rf /tmp/nope', await gateOptions())).rejects.toThrow(/allowlist/);
  });
});
