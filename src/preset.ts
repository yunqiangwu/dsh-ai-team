/**
 * 尽力而为地预置（provisioning）`autopilot-team` 这个 agent preset。
 *
 * 该 preset 随本包发布在 `preset/autopilot-team/` 下（是 `standard` agent
 * 组合的副本，带 autopilot-team 人格），因此全新安装即可在 agent-preset
 * 名单中看到该模式，无需手动创建文件。插件加载时我们会把模板复制到
 * **user** preset 根目录。
 *
 * 硬性规则：
 * - 绝不覆盖：已存在的 `autopilot-team` 目录被视为用户自己编写的版本，
 *   保持原样不动（随包发布的模板只用来填补空缺）。
 * - 尽力而为：任何失败（没有 agent-presets 名单、home 目录不可写等）
 *   都会被吞掉并返回 `undefined`；绝不能因此中断插件加载。
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本包随包发布并自动预置的 preset id。 */
export const AUTOPILOT_TEAM_PRESET_ID = 'autopilot-team';

/** 随包发布的模板目录，基于本模块的包根目录解析。 */
export const TEMPLATE_DIR = fileURLToPath(new URL('../preset/autopilot-team/', import.meta.url));

/**
 * 确保 user preset 根目录下存在 `autopilot-team` preset，缺失时从随包模板复制。
 * @param userRoot - 要预置进去的 user preset 根目录；省略时默认使用 DSH home
 * 的 user 根目录（`~/.dsh/.agent-presets`）。
 * @returns 预置好的 preset 目录，跳过或预置失败时返回 `undefined`。
 */
export async function ensureAutopilotTeamPreset(userRoot?: string): Promise<string | undefined> {
  const root = userRoot ?? join(homedir(), '.dsh', '.agent-presets');
  const target = join(root, AUTOPILOT_TEAM_PRESET_ID);
  // 已存在（用户自己编写 / 此前已预置）→ 保持原样不动。
  try {
    await readFile(join(target, 'agent.cordis.yml'));
    return target;
  } catch {
    // 缺失 → 下面从随包模板进行预置。
  }
  try {
    await mkdir(target, { recursive: true });
    await copyFile(join(TEMPLATE_DIR, 'agent.cordis.yml'), join(target, 'agent.cordis.yml'));
    await copyFile(join(TEMPLATE_DIR, 'preset.yml'), join(target, 'preset.yml'));
    return target;
  } catch {
    // 尽力而为：预置失败时绝不中断插件加载。
    return undefined;
  }
}
