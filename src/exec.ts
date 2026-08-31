/**
 * 共享的 `/bin/sh` 命令执行器。
 *
 * gates / bootstrap / deploy 原先各带一份近乎复制的 `runShell`，真实差异只有三点：
 * 叠在 `process.env` 上的条目、有没有超时、日志尾是否就地脱敏。三份复制各自演化过
 * （只有 gates 加了超时；deploy 与 bootstrap 的命令挂死会永久卡住守护循环），
 * 而 execFile 选项、exitCode 折算、4000 字符日志尾、可中止这几段完全相同 ——
 * 这类东西最不该有三份真相。差异收进参数，实现只留一份。
 *
 * 语义刻意与合并前逐字对齐：超时折算成 `exitCode 1`（门失败是数据不是异常），
 * 只有 abort 才 reject；省略 `timeoutMs` 即不限时，保持 bootstrap / deploy 现状。
 * 由 `tests/unit/exec.ts` 那组锁定用例兜住。
 */
import { execFile } from 'node:child_process';

/** 进日志的尾部字符数上限：门输出、部署输出与引导输出共用同一个预算。 */
export const LOG_TAIL_CHARS = 4000;

/** 子进程输出缓冲上限：构建日志可能很长，宁可截尾也不要 EIO。 */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** 保留日志尾部：结论与报错总在末尾，被丢掉的头部只是噪声。 */
export function tailLog(text: string): string {
  return text.length <= LOG_TAIL_CHARS ? text : text.slice(text.length - LOG_TAIL_CHARS);
}

export interface RunShellInput {
  command: string;
  cwd: string;
  /** 叠在 `process.env` 之上的条目（`CI` / 补强的 `PATH` / 部署密钥）。 */
  extraEnv?: Record<string, string> | undefined;
  /** 超时毫秒数；省略即不限时。超时会杀掉进程并折算成 `exitCode 1`。 */
  timeoutMs?: number | undefined;
  /** 中止支持：守护循环的每一步都必须可取消。 */
  signal?: AbortSignal | undefined;
  /** 出错信息里的来源标签（`gate` / `deploy` / `bootstrap`），让升级文本指得清链路。 */
  label: string;
}

export interface RunShellResult {
  exitCode: number;
  /** **未脱敏**的日志尾：何时过 SecretRedactor 由调用方决定。 */
  logTail: string;
}

/** execFile 的错误折算成退出码：被信号杀掉时 code 为 null，按惯例记 1。 */
function toExitCode(error: Error & { code?: number | string } | null): number {
  if (error === null) return 0;
  return typeof error.code === 'number' ? error.code : 1;
}

/**
 * 跑一条 shell 命令并捕获 stdout+stderr 尾部。非零退出码**绝不抛错** ——
 * 对调用方来说那是数据（门没过、部署没成）；只有 abort 才抛，因为那是控制流。
 */
export async function runShell(input: RunShellInput): Promise<RunShellResult> {
  const { command, cwd, label } = input;
  return new Promise<RunShellResult>((resolvePromise, reject) => {
    const child = execFile(
      '/bin/sh',
      ['-c', command],
      { cwd, maxBuffer: MAX_BUFFER_BYTES, env: { ...process.env, ...input.extraEnv } },
      (error, stdout, stderr) => {
        cleanup();
        resolvePromise({
          exitCode: toExitCode(error as (Error & { code?: number | string }) | null),
          logTail: tailLog(`${stdout}${stderr}`),
        });
      },
    );
    const timer =
      input.timeoutMs === undefined ? null : setTimeout(() => child.kill('SIGKILL'), input.timeoutMs);
    const cleanup = (): void => {
      if (timer !== null) clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      child.kill('SIGKILL');
      cleanup();
      reject(new Error(`${label} command aborted: ${command}`));
    };
    if (input.signal?.aborted === true) {
      onAbort();
      return;
    }
    input.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
