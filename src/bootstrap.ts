/**
 * Bare-machine bootstrap (spec §4.2 autopilot_init):
 *
 *   detect toolchain → rootless-install what's missing → run the repo's
 *   setupCommand → run verifyCommand as an environment self-check.
 *
 * Everything runs through the command allowlist; every output is redacted.
 * Installers are fixed, audited commands (Bun official script → ~/.bun),
 * never model-generated shell.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isAllowed, commandHead } from './gates.js';
import type { SecretRedactor } from './secrets.js';

export interface ToolchainProbe {
  tool: string;
  available: boolean;
  version: string | null;
}

export interface BootstrapReport {
  toolchain: ToolchainProbe[];
  installed: string[];
  setupRan: boolean;
  setupLogTail: string | null;
  verifyRan: boolean;
  verifyPassed: boolean;
  verifyLogTail: string | null;
}

export class BootstrapError extends Error {
  constructor(
    message: string,
    public readonly report: BootstrapReport,
  ) {
    super(message);
    this.name = 'BootstrapError';
  }
}

const VERSION_FLAGS: Record<string, string[]> = {
  git: ['--version'],
  bun: ['--version'],
  pnpm: ['--version'],
  node: ['--version'],
  docker: ['--version'],
};

/** Probe a single tool: resolve its binary and version. */
export async function probeTool(tool: string, extraPaths: string[] = []): Promise<ToolchainProbe> {
  const flag = VERSION_FLAGS[tool] ?? ['--version'];
  const candidates = [tool, ...extraPaths.map((dir) => join(dir, tool))];
  for (const candidate of candidates) {
    try {
      const { stdout: versionOut } = await new Promise<{ stdout: string }>((resolvePromise, reject) => {
        execFile(candidate, flag, { timeout: 10_000 }, (error, stdoutText) => {
          if (error !== null) reject(error);
          else resolvePromise({ stdout: stdoutText });
        });
      });
      return { tool, available: true, version: versionOut.trim().split('\n')[0] ?? null };
    } catch {
      // try next candidate path
    }
  }
  return { tool, available: false, version: null };
}

const BUN_HOME = join(homedir(), '.bun', 'bin');

/**
 * Rootless install of a missing tool. Currently supported: bun (official
 * install script into ~/.bun). Anything else must be provisioned by a human
 * (reported back so autopilot_init escalates with a precise message).
 */
export async function installTool(
  tool: string,
  redactor: SecretRedactor,
  signal?: AbortSignal,
): Promise<{ ok: boolean; logTail: string }> {
  if (tool === 'bun') {
    const command = 'curl -fsSL https://bun.sh/install | bash';
    const result = await runShell(command, homedir(), redactor, signal);
    return { ok: result.exitCode === 0, logTail: result.logTail };
  }
  if (tool === 'pnpm') {
    // pnpm via corepack (bundled with node) or standalone script.
    const result = await runShell('corepack enable pnpm || curl -fsSL https://get.pnpm.io/install.sh | sh -', homedir(), redactor, signal);
    return { ok: result.exitCode === 0, logTail: result.logTail };
  }
  return {
    ok: false,
    logTail: `no rootless installer known for "${tool}"; a human must install it (e.g. git via the OS package manager)`,
  };
}

async function runShell(
  command: string,
  cwd: string,
  redactor: SecretRedactor,
  signal?: AbortSignal,
): Promise<{ exitCode: number; logTail: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      '/bin/sh',
      ['-c', command],
      { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: `${BUN_HOME}:${process.env.PATH ?? ''}` } },
      (error, stdout, stderr) => {
        cleanup();
        const exitCode =
          error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1;
        resolvePromise({ exitCode, logTail: redactor.redact(`${stdout}${stderr}`.slice(-4000)) });
      },
    );
    const onAbort = () => {
      child.kill('SIGKILL');
      cleanup();
      reject(new Error(`bootstrap command aborted: ${command}`));
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface BootstrapOptions {
  toolchain: readonly string[];
  setupCommand: string;
  verifyCommand: string;
  /** Repository checkout the setup/verify commands run in. */
  repoPath: string;
  allowlist: readonly string[];
  redactor: SecretRedactor;
  signal?: AbortSignal;
}

/**
 * Full bootstrap sequence. Throws BootstrapError (carrying the report) when
 * the toolchain cannot be satisfied or setup/verify fail — the caller
 * escalates with the report attached.
 */
export async function bootstrapEnvironment(options: BootstrapOptions): Promise<BootstrapReport> {
  const report: BootstrapReport = {
    toolchain: [],
    installed: [],
    setupRan: false,
    setupLogTail: null,
    verifyRan: false,
    verifyPassed: false,
    verifyLogTail: null,
  };

  // 1. Probe, then rootless-install what is missing.
  for (const tool of options.toolchain) {
    let probe = await probeTool(tool, [BUN_HOME]);
    if (!probe.available) {
      const install = await installTool(tool, options.redactor, options.signal);
      probe = await probeTool(tool, [BUN_HOME]);
      if (install.ok && probe.available) {
        report.installed.push(tool);
      }
    }
    report.toolchain.push(probe);
  }
  const missing = report.toolchain.filter((probe) => !probe.available).map((probe) => probe.tool);
  if (missing.length > 0) {
    throw new BootstrapError(
      `toolchain incomplete: ${missing.join(', ')} could not be installed rootlessly; a human must provision them`,
      report,
    );
  }

  // 2. setup / verify commands must pass the allowlist like any member command.
  for (const command of [options.setupCommand, options.verifyCommand]) {
    if (commandHead(command) !== '' && !isAllowed(command, options.allowlist)) {
      throw new BootstrapError(
        `bootstrap command "${command}" is not on the command allowlist [${options.allowlist.join(', ')}]`,
        report,
      );
    }
  }

  // 3. Repo setup (install + migrate + seed).
  if (options.setupCommand.trim() !== '') {
    report.setupRan = true;
    const setup = await runShell(options.setupCommand, options.repoPath, options.redactor, options.signal);
    report.setupLogTail = setup.logTail;
    if (setup.exitCode !== 0) {
      throw new BootstrapError(`setupCommand "${options.setupCommand}" failed (exit ${setup.exitCode})`, report);
    }
  }

  // 4. Environment self-verification.
  if (options.verifyCommand.trim() !== '') {
    report.verifyRan = true;
    const verify = await runShell(options.verifyCommand, options.repoPath, options.redactor, options.signal);
    report.verifyLogTail = verify.logTail;
    report.verifyPassed = verify.exitCode === 0;
    if (!report.verifyPassed) {
      throw new BootstrapError(`verifyCommand "${options.verifyCommand}" failed (exit ${verify.exitCode})`, report);
    }
  } else {
    report.verifyPassed = true;
  }

  return report;
}

export { BUN_HOME };
