/**
 * Best-effort provisioning of the `autopilot-team` agent preset.
 *
 * The preset ships with this package under `preset/autopilot-team/` (a copy of
 * the `standard` agent composition with an autopilot-team persona), so a fresh
 * install exposes the mode in the agent-preset roster without manual file
 * creation. On plugin load we copy the template into a **user** preset root.
 *
 * Hard rules:
 * - Never overwrite: an already-present `autopilot-team` directory is treated
 *   as the user's own authored copy and left untouched (the shipped template
 *   only fills a gap).
 * - Best-effort: any failure (no agent-presets roster, unwritable home, etc.)
 *   is swallowed and returns `undefined`; it must never break plugin load.
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The preset id this package ships and auto-provisions. */
export const AUTOPILOT_TEAM_PRESET_ID = 'autopilot-team';

/** Shipped template directory, resolved against this module's package root. */
export const TEMPLATE_DIR = fileURLToPath(new URL('../preset/autopilot-team/', import.meta.url));

/**
 * Ensure the `autopilot-team` preset exists under a user preset root, copying
 * the shipped template when missing.
 * @param userRoot - the user preset root to provision into; when omitted,
 * defaults to the DSH home user root (`~/.dsh/.agent-presets`).
 * @returns the provisioned preset directory, or `undefined` when skipped or
 * provisioning failed.
 */
export async function ensureAutopilotTeamPreset(userRoot?: string): Promise<string | undefined> {
  const root = userRoot ?? join(homedir(), '.dsh', '.agent-presets');
  const target = join(root, AUTOPILOT_TEAM_PRESET_ID);
  // Already present (user-authored / previously provisioned) → leave it alone.
  try {
    await readFile(join(target, 'agent.cordis.yml'));
    return target;
  } catch {
    // Missing → provision from the shipped template below.
  }
  try {
    await mkdir(target, { recursive: true });
    await copyFile(join(TEMPLATE_DIR, 'agent.cordis.yml'), join(target, 'agent.cordis.yml'));
    await copyFile(join(TEMPLATE_DIR, 'preset.yml'), join(target, 'preset.yml'));
    return target;
  } catch {
    // Best-effort: never break plugin load on a provisioning failure.
    return undefined;
  }
}
