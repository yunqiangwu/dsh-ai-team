/**
 * 密钥处理 —— 环境变量间接寻址与日志脱敏的唯一实现位置。
 *
 * 硬性规则（spec §4.5）：
 *  1. 配置里只保存 env var NAMES（`xxxEnv`）；值在运行时从 process.env 读取，
 *     绝不落盘。
 *  2. 任何暴露给模型、会话日志或 webhook 的日志都必须经过脱敏器：所有已知
 *     密钥值都会被替换为 `***`。
 */

/** 从 env var 引用读取密钥。未设置时抛错（快速失败）。 */
export function resolveEnvRef(envName: string, purpose: string): string {
  const value = process.env[envName];
  if (value === undefined || value === '') {
    throw new Error(
      `missing credential: environment variable "${envName}" (needed for ${purpose}) is not set. ` +
        `Set it in the daemon host environment — never in config files or task files.`,
    );
  }
  return value;
}

/** 读取可选的 env var 引用；未设置时返回 undefined。 */
export function resolveOptionalEnvRef(envName: string | undefined): string | undefined {
  if (envName === undefined || envName === '') return undefined;
  const value = process.env[envName];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * 脱敏器持有已知密钥值的集合并清洗文本。在解析时注册每一个 env 引用的密钥，
 * 随后将所有面向用户的输出交给 redact() 处理。
 */
export class SecretRedactor {
  private values: string[] = [];

  /** 注册一个需要脱敏的密钥值（忽略空值/过短的值）。 */
  register(value: string | undefined): void {
    if (value === undefined || value.length < 4) return;
    if (!this.values.includes(value)) this.values.push(value);
  }

  /** 注册指定 env vars 的所有非空值。 */
  registerEnvNames(envNames: readonly (string | undefined)[]): void {
    for (const name of envNames) {
      if (name === undefined) continue;
      this.register(process.env[name]);
    }
  }

  /** 将 `text` 中每个已注册的密钥值替换为 `***`。 */
  redact(text: string): string {
    let out = text;
    for (const value of this.values) {
      // split/join：字面量替换，避免正则转义的坑。
      out = out.split(value).join('***');
    }
    return out;
  }

  /** 已注册密钥值的数量（供测试 / 诊断使用）。 */
  get size(): number {
    return this.values.length;
  }
}

/** 针对一组已知值的便捷一次性脱敏。 */
export function redactSecrets(text: string, values: readonly string[]): string {
  const redactor = new SecretRedactor();
  for (const value of values) redactor.register(value);
  return redactor.redact(text);
}
