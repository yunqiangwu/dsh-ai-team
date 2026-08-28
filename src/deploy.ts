/**
 * Deploy & rollback loop (spec §4.2 deploy_run).
 *
 *   deploy.command → health-check with exponential backoff → on 3 failed
 *   probes run rollbackCommand and surface a failed DeployView (the service
 *   escalates it).
 *
 * Only allowlisted commands run; secrets needed by the deploy command come
 * from the secretsEnv whitelist of env var names — values are registered
 * with the redactor so they can never leak through logs.
 */
import { execFile } from 'node:child_process';
import type { DeployView } from './view.js';
import { isAllowed } from './gates.js';
import { resolveOptionalEnvRef, SecretRedactor } from './secrets.js';

export interface DeployOptions {
  command: string;
  healthCheckUrl?: string | undefined;
  rollbackCommand?: string | undefined;
  secretsEnv: readonly string[];
  allowlist: readonly string[];
  redactor: SecretRedactor;
  cwd: string;
  branch: string;
  signal?: AbortSignal;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  /** Backoff base in ms (tests shrink it). */
  backoffMs?: number;
  /** Health-check attempts before rollback (default 3). */
  maxHealthAttempts?: number;
}

let deploySeq = 0;

async function runShell(
  command: string,
  cwd: string,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ exitCode: number; logTail: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      '/bin/sh',
      ['-c', command],
      { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        cleanup();
        const exitCode =
          error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1;
        resolvePromise({ exitCode, logTail: `${stdout}${stderr}`.slice(-4000) });
      },
    );
    const onAbort = () => {
      child.kill('SIGKILL');
      cleanup();
      reject(new Error(`deploy command aborted: ${command}`));
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function probeHealth(
  url: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetchFn(url, { signal: signal ?? AbortSignal.timeout(10_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('deploy aborted during backoff'));
    };
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Execute one deploy. The returned DeployView carries the terminal status;
 * this function throws only for allowlist violations and aborts.
 */
export async function runDeploy(options: DeployOptions): Promise<DeployView> {
  if (!isAllowed(options.command, options.allowlist)) {
    throw new Error(
      `deploy command "${options.command}" is not on the command allowlist [${options.allowlist.join(', ')}]`,
    );
  }
  // Whitelisted deploy secrets: values stay in the child env only, and are
  // registered with the redactor so logs can never leak them.
  const secretEnv: Record<string, string> = {};
  for (const name of options.secretsEnv) {
    const value = resolveOptionalEnvRef(name);
    if (value !== undefined) {
      secretEnv[name] = value;
      options.redactor.register(value);
    }
  }

  const view: DeployView = {
    id: `deploy_${Date.now().toString(36)}_${(deploySeq += 1)}`,
    branch: options.branch,
    command: options.command,
    status: 'running',
    healthCheckUrl: options.healthCheckUrl ?? null,
    logTail: '',
    startedAt: Date.now(),
    finishedAt: null,
  };

  const deploy = await runShell(options.command, options.cwd, secretEnv, options.signal);
  view.logTail = options.redactor.redact(deploy.logTail);
  if (deploy.exitCode !== 0) {
    view.status = 'failed';
    view.finishedAt = Date.now();
    return view;
  }

  if (options.healthCheckUrl !== undefined && options.healthCheckUrl !== '') {
    const fetchFn = options.fetchFn ?? fetch;
    const maxAttempts = options.maxHealthAttempts ?? 3;
    const base = options.backoffMs ?? 2000;
    let healthy = false;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (await probeHealth(options.healthCheckUrl, fetchFn, options.signal)) {
        healthy = true;
        break;
      }
      if (attempt < maxAttempts - 1) await sleep(base * 2 ** attempt, options.signal);
    }
    if (!healthy) {
      if (options.rollbackCommand !== undefined && options.rollbackCommand !== '') {
        if (!isAllowed(options.rollbackCommand, options.allowlist)) {
          throw new Error(
            `rollback command "${options.rollbackCommand}" is not on the command allowlist [${options.allowlist.join(', ')}]`,
          );
        }
        const rollback = await runShell(options.rollbackCommand, options.cwd, secretEnv, options.signal);
        view.logTail = `${view.logTail}\n[rollback]\n${options.redactor.redact(rollback.logTail)}`.slice(-4000);
        view.status = 'rolled-back';
      } else {
        view.status = 'failed';
      }
      view.finishedAt = Date.now();
      return view;
    }
  }

  view.status = 'healthy';
  view.finishedAt = Date.now();
  return view;
}
