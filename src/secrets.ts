/**
 * Secrets handling — the single place where environment-variable indirection
 * and log redaction live.
 *
 * Hard rules (spec §4.5):
 *  1. Config only ever carries env var NAMES (`xxxEnv`); values are read from
 *     process.env at runtime and never written to disk.
 *  2. Any log surfaced to the model, the session log, or a webhook must pass
 *     through the redactor: every known secret value is replaced with `***`.
 */

/** Read a secret from an env var reference. Throws (fail loud) when unset. */
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

/** Read an optional env var reference; undefined when unset. */
export function resolveOptionalEnvRef(envName: string | undefined): string | undefined {
  if (envName === undefined || envName === '') return undefined;
  const value = process.env[envName];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Redactor holds the set of known secret values and scrubs text. Register
 * every env-referenced secret at resolve time; then pass all user-visible
 * output through redact().
 */
export class SecretRedactor {
  private values: string[] = [];

  /** Register a secret value for redaction (empty/short values ignored). */
  register(value: string | undefined): void {
    if (value === undefined || value.length < 4) return;
    if (!this.values.includes(value)) this.values.push(value);
  }

  /** Register every non-empty value of the named env vars. */
  registerEnvNames(envNames: readonly (string | undefined)[]): void {
    for (const name of envNames) {
      if (name === undefined) continue;
      this.register(process.env[name]);
    }
  }

  /** Replace every registered secret value in `text` with `***`. */
  redact(text: string): string {
    let out = text;
    for (const value of this.values) {
      // split/join: literal replacement, no regex escaping pitfalls.
      out = out.split(value).join('***');
    }
    return out;
  }

  /** Number of registered secret values (for tests / diagnostics). */
  get size(): number {
    return this.values.length;
  }
}

/** Convenience one-shot redaction for a known set of values. */
export function redactSecrets(text: string, values: readonly string[]): string {
  const redactor = new SecretRedactor();
  for (const value of values) redactor.register(value);
  return redactor.redact(text);
}
