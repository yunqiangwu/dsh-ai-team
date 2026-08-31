/**
 * service/options.ts 运行时配置的纯函数 + AutopilotService 热应用与持久化。
 */
import { describe, expect, it } from 'vitest';
import { mergeRuntimeConfig, runtimeConfigViewOf } from '../../../src/service/options.js';
import type { AutopilotOptions } from '../../../src/service/options.js';
import { AutopilotService } from '../../../src/service.js';
import { makeFixture, testOptions } from '../../helpers.js';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

async function makeBaseOptions(): Promise<AutopilotOptions> {
  const fixture = await makeFixture('runtime-config');
  return testOptions(fixture);
}

describe('runtime config: mergeRuntimeConfig / runtimeConfigViewOf', () => {
  it('merges group objects per key without dropping the rest of the group', async () => {
    const options = await makeBaseOptions();
    const merged = mergeRuntimeConfig(options, { remote: { url: '/tmp/r.git' }, baseBranch: 'develop' });
    expect(merged.remote.url).toBe('/tmp/r.git');
    expect(merged.remote.sshKeyEnv).toBe(options.remote.sshKeyEnv); // 未覆盖的键保留
    expect(merged.remote.platform).toBe(options.remote.platform);
    expect(merged.baseBranch).toBe('develop');
    // runtimeConfigViewOf 投影的是生效配置的可覆盖子集
    expect(runtimeConfigViewOf(merged).remote.url).toBe('/tmp/r.git');
  });

  it('replaces arrays wholesale (gates.commands)', async () => {
    const options = await makeBaseOptions();
    const merged = mergeRuntimeConfig(options, { gates: { commands: ['pnpm run typecheck'] } });
    expect(merged.gates.commands).toEqual(['pnpm run typecheck']);
    expect(merged.gates.requireCiGreen).toBe(options.gates.requireCiGreen);
  });

  it('undefined overlay entries are skipped', async () => {
    const options = await makeBaseOptions();
    const merged = mergeRuntimeConfig(options, { remote: { url: undefined } });
    expect(merged.remote.url).toBe(options.remote.url);
  });
});

describe('runtime config: service.setRuntimeConfig hot-applies and persists', () => {
  it('applies an override immediately and persists it to state', async () => {
    const fixture = await makeFixture('runtime-config-service');
    const service = await AutopilotService.create(testOptions(fixture));
    const view = service.setRuntimeConfig({ remote: { url: '/tmp/other.git' }, baseBranch: 'develop' });
    expect(view.remote.url).toBe('/tmp/other.git');
    expect(view.baseBranch).toBe('develop');
    await service.dispose();
    const persisted = JSON.parse(await readFile(join(fixture.stateDir, 'state.json'), 'utf8')) as {
      runtimeConfig?: { remote?: { url?: string }; baseBranch?: string };
    };
    expect(persisted.runtimeConfig?.remote?.url).toBe('/tmp/other.git');
    expect(persisted.runtimeConfig?.baseBranch).toBe('develop');
  });

  it('a partial override does not clobber non-overridden keys', async () => {
    const fixture = await makeFixture('runtime-config-merge');
    const service = await AutopilotService.create(testOptions(fixture));
    const before = service.runtimeConfigView();
    const after = service.setRuntimeConfig({ remote: { url: '/tmp/third.git' } });
    expect(after.remote.url).toBe('/tmp/third.git');
    expect(after.remote.sshKeyEnv).toBe(before.remote.sshKeyEnv);
    await service.dispose();
  });
});