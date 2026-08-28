/**
 * Bootstrap provisioning tests: `.env` scaffolding, required-env fail-loud,
 * and allowlist-checked system-package provisioning. Integration tests keep
 * `bootstrap.enabled: false`, so these exercise the helpers directly.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapEnvironment, checkRequiredEnv, scaffoldEnvFile, BootstrapError } from '../src/bootstrap.js';
import { SecretRedactor } from '../src/secrets.js';

const ENV_KEY = 'DSH_TEST_BOOTSTRAP_KEY';

describe('bootstrap: env provisioning', () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it('checkRequiredEnv lists only unset variables', () => {
    process.env[ENV_KEY] = 'present';
    expect(checkRequiredEnv([ENV_KEY, 'DSH_TEST_NO_SUCH_KEY_123'])).toEqual(['DSH_TEST_NO_SUCH_KEY_123']);
    delete process.env[ENV_KEY];
    expect(checkRequiredEnv([ENV_KEY])).toEqual([ENV_KEY]);
  });

  it('scaffoldEnvFile copies the example once and never overwrites', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-env-'));
    try {
      const example = join(dir, '.env.example');
      const envFile = join(dir, '.env');
      await writeFile(example, 'AUTH_SECRET=placeholder\n', 'utf8');
      expect(await scaffoldEnvFile(envFile, example)).toBe('created');
      expect(await readFile(envFile, 'utf8')).toContain('AUTH_SECRET');
      // An existing .env is left untouched.
      await writeFile(envFile, 'AUTH_SECRET=real\n', 'utf8');
      expect(await scaffoldEnvFile(envFile, example)).toBe('exists');
      expect(await readFile(envFile, 'utf8')).toContain('real');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('scaffoldEnvFile no-ops when there is no example', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-noex-'));
    try {
      expect(await scaffoldEnvFile(join(dir, '.env'), join(dir, '.env.example'))).toBe('no-example');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('bootstrap: sequence', () => {
  it('reports a clean toolchain and passes a no-op verify when nothing to do', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-ok-'));
    try {
      const report = await bootstrapEnvironment({
        toolchain: ['git'],
        setupCommand: '',
        verifyCommand: '',
        repoPath: dir,
        allowlist: ['git'],
        redactor: new SecretRedactor(),
      });
      expect(report.toolchain[0]?.tool).toBe('git');
      expect(report.toolchain[0]?.available).toBe(true);
      expect(report.verifyPassed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails loud when required env vars are missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-envkey-'));
    try {
      await expect(
        bootstrapEnvironment({
          toolchain: ['git'],
          setupCommand: '',
          verifyCommand: '',
          repoPath: dir,
          allowlist: ['git'],
          redactor: new SecretRedactor(),
          requiredEnvKeys: ['DSH_TEST_NO_SUCH_ENV_XYZ'],
        }),
      ).rejects.toThrow(BootstrapError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a non-allowlisted package-manager command for system packages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-pm-'));
    try {
      await expect(
        bootstrapEnvironment({
          toolchain: ['git'],
          setupCommand: '',
          verifyCommand: '',
          repoPath: dir,
          allowlist: ['git', 'pnpm'],
          redactor: new SecretRedactor(),
          systemPackages: ['python3', 'make', 'g++'],
          packageManagerCommand: 'sudo apt-get install -y',
        }),
      ).rejects.toThrow(/packageManagerCommand|command allowlist/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails loud when systemPackages are requested without a package-manager command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-pm-empty-'));
    try {
      await expect(
        bootstrapEnvironment({
          toolchain: ['git'],
          setupCommand: '',
          verifyCommand: '',
          repoPath: dir,
          allowlist: ['git'],
          redactor: new SecretRedactor(),
          systemPackages: ['python3'],
        }),
      ).rejects.toThrow(/packageManagerCommand/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
