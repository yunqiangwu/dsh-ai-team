/**
 * 部署与回滚循环（spec §4.2 deploy_run）。
 *
 *   deploy.command → 指数退避的健康检查 → 连续 3 次探测失败则执行
 *   rollbackCommand 并把失败的 DeployView 抛给上层（由 service 升级）。
 *
 * 只有白名单内的命令才会执行；部署命令需要的密钥来自 secretsEnv 里列出的
 * 环境变量名 —— 值会登记进脱敏器，因此绝不泄漏到日志。
 */
import { runShell, tailLog } from './exec.js';
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
  /** 测试可注入。 */
  fetchFn?: typeof fetch;
  /** 退避基数（毫秒），测试会缩短它。 */
  backoffMs?: number;
  /** 回滚前的健康检查次数（默认 3）。 */
  maxHealthAttempts?: number;
}

let deploySeq = 0;

/**
 * 跑部署 / 回滚命令。与合并前一致：**不设超时**（部署链路自己控制时长），
 * 返回的日志尾就地不脱敏 —— 调用方统一过 SecretRedactor。
 */
async function runDeployShell(
  command: string,
  cwd: string,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ exitCode: number; logTail: string }> {
  return runShell({
    command,
    cwd,
    extraEnv: env,
    label: 'deploy',
    ...(signal !== undefined ? { signal } : {}),
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
 * 执行一次部署。返回的 DeployView 携带终态；本函数只在白名单违规与中止时抛错。
 */
export async function runDeploy(options: DeployOptions): Promise<DeployView> {
  if (!isAllowed(options.command, options.allowlist)) {
    throw new Error(
      `deploy command "${options.command}" is not on the command allowlist [${options.allowlist.join(', ')}]`,
    );
  }
  // 白名单部署密钥：值只存在于子进程环境里，并登记进脱敏器，日志绝不泄漏。
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
    // 团队归属由调用侧（service.deployRun）落；这里不知道团队是谁。
    teamId: null,
    branch: options.branch,
    command: options.command,
    status: 'running',
    healthCheckUrl: options.healthCheckUrl ?? null,
    logTail: '',
    startedAt: Date.now(),
    finishedAt: null,
  };

  const deploy = await runDeployShell(options.command, options.cwd, secretEnv, options.signal);
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
        const rollback = await runDeployShell(options.rollbackCommand, options.cwd, secretEnv, options.signal);
        view.logTail = tailLog(
          `${view.logTail}\n[rollback] exit=${rollback.exitCode}\n${options.redactor.redact(rollback.logTail)}`,
        );
        // 回滚自己失败必须区别于回滚成功：人都看到"已回滚"了，就不会再去救一个
        // 既没升上去也没退回来的线上环境。
        view.status = rollback.exitCode === 0 ? 'rolled-back' : 'rollback-failed';
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
