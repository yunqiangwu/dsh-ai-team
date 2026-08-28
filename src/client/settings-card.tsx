/**
 * Autopilot settings card — one `settings.plugin.item` card keyed on the
 * `autopilot` namespace. This is the "Plugin configuration" tab card that
 * appears for any plugin that (a) registers a Host settings namespace and
 * (b) registers a browser card under that namespace. The tab pairs the two
 * ledgers without interpreting the namespace, so this card owns every part of
 * its own chrome and form model; it binds the namespace scope and renders only
 * the KEY fields the user chose to expose for editing (the rest stay
 * composition-managed / YAML).
 */
import { useCallback, useSyncExternalStore, useState } from 'react';
import type { SettingsScope, Translator } from './contract.js';

/** Dot-path expression over the resolved config. */
interface KeyField {
  path: string;
  label: string;
  hint?: string;
  kind: 'text' | 'boolean' | 'number' | 'list';
}

/** The key fields surfaced for editing (mirrors the Config shape subset). */
export const AUTOPILOT_KEY_FIELDS: KeyField[] = [
  { path: 'remote.url', label: 'config.remoteUrl', hint: 'remoteUrlHint', kind: 'text' },
  { path: 'baseBranch', label: 'config.baseBranch', kind: 'text' },
  { path: 'bootstrap.enabled', label: 'config.bootstrapEnabled', kind: 'boolean' },
  { path: 'gates.commands', label: 'config.gatesCommands', hint: 'gatesCommandsHint', kind: 'list' },
  { path: 'daemon.heartbeatSeconds', label: 'config.heartbeatSeconds', kind: 'number' },
  { path: 'daemon.maxReviewRounds', label: 'config.maxReviewRounds', kind: 'number' },
  { path: 'daemon.stuckMinutes', label: 'config.stuckMinutes', kind: 'number' },
];

/** Walk a dot path across a plain object; undefined on any missing hop. */
function at(source: unknown, path: string): unknown {
  let node: unknown = source;
  for (const hop of path.split('.')) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[hop];
  }
  return node;
}

/** A field is overridden by its PRESENCE in the raw user layer, not its value. */
function isOverridden(user: unknown, path: string): boolean {
  if (path === '') return false;
  let node: unknown = user;
  const hops = path.split('.');
  for (let i = 0; i < hops.length - 1; i += 1) {
    if (node === null || node === undefined || typeof node !== 'object') return false;
    const hop = hops[i];
    if (hop === undefined) return false;
    const next = (node as Record<string, unknown>)[hop];
    if (next === undefined) return false;
    node = next;
  }
  const leaf = hops[hops.length - 1];
  if (leaf === undefined) return false;
  return node !== null && node !== undefined && typeof node === 'object'
    ? Object.prototype.hasOwnProperty.call(node, leaf)
    : false;
}

/** Render the current resolved value of a field into editable text. */
function toText(kind: KeyField['kind'], value: unknown): string {
  if (kind === 'boolean') return value === true ? 'true' : 'false';
  if (kind === 'list') return Array.isArray(value) ? value.join('\n') : '';
  if (value === undefined || value === null) return '';
  return String(value);
}

/** Parse draft text back into a typed value for `scope.set`. */
function fromText(kind: KeyField['kind'], text: string): unknown {
  if (kind === 'boolean') return text === 'true';
  if (kind === 'number') {
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }
  if (kind === 'list') return text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return text;
}

/**
 * The card itself. Props arrive from the slot's `inject()`: a locale-bound `t`
 * and the namespace scope. Draft writes are staged locally and committed on
 * Save (each through the scope, which fences every write with the revision it
 * read); Discard drops the drafts.
 */
export function AutopilotSettingsCard({
  t,
  scope,
}: {
  t: Translator;
  scope: SettingsScope<Record<string, unknown>>;
}) {
  // `scope` is a SettingsScope instance whose `subscribe` relies on `this`
  // (it reads `this.store` inside). Passing the bare method reference to
  // `useSyncExternalStore` drops `this` on the first callback, so wrap it in an
  // arrow that invokes it as a method — React calls the subscribe callback as a
  // free function, not as `scope.subscribe(...)`.
  const subscribeScope = useCallback((listener: () => void) => scope.subscribe(listener), [scope]);
  const snapshot = useSyncExternalStore(subscribeScope, () => scope.getSnapshot());
  const { status, value, user, writable } = snapshot;
  const [drafts, setDrafts] = useState<Record<string, string | null>>({});

  if (status !== 'ready') return null;

  const staged = Object.keys(drafts).length > 0;

  function setDraft(field: string, text: string | null) {
    setDrafts((previous) => ({ ...previous, [field]: text }));
  }

  async function save() {
    const entries = Object.entries(drafts);
    await Promise.all(
      entries.map(([path, draft]) => {
        const field = AUTOPILOT_KEY_FIELDS.find((candidate) => candidate.path === path);
        if (field === undefined) return Promise.resolve();
        if (draft === null) return scope.unset(path);
        return scope.set(path, fromText(field.kind, draft));
      }),
    );
    setDrafts({});
  }

  function discard() {
    setDrafts({});
  }

  return (
    <div className="dsh-ai-team__config">
      <p className="dsh-ai-team__config-intro">{t('config.intro')}</p>
      {AUTOPILOT_KEY_FIELDS.map((field) => {
        const current = toText(field.kind, at(value, field.path));
        const shown = staged && field.path in drafts ? (drafts[field.path] ?? '') : current;
        const overridden = isOverridden(user, field.path);
        return (
          <label key={field.path} className="dsh-ai-team__config-field" data-field={field.path}>
            <span className="dsh-ai-team__config-label">
              {t(field.label)}
              {overridden ? <em className="dsh-ai-team__config-overridden">{t('config.overridden')}</em> : null}
            </span>
            {field.kind === 'boolean' ? (
              <input
                type="checkbox"
                checked={shown === 'true'}
                disabled={!writable}
                onChange={(event) => setDraft(field.path, event.target.checked ? 'true' : 'false')}
              />
            ) : field.kind === 'list' ? (
              <textarea
                className="dsh-ai-team__config-input dsh-ai-team__config-area"
                value={shown}
                disabled={!writable}
                rows={Math.max(2, shown.split('\n').length)}
                onChange={(event) => setDraft(field.path, event.target.value)}
              />
            ) : (
              <input
                className="dsh-ai-team__config-input"
                type={field.kind === 'number' ? 'number' : 'text'}
                value={shown}
                disabled={!writable}
                onChange={(event) => setDraft(field.path, event.target.value)}
              />
            )}
            {field.hint !== undefined ? <span className="dsh-ai-team__config-hint">{t(field.hint)}</span> : null}
            {staged && field.path in drafts ? (
              <button
                type="button"
                className="dsh-ai-team__config-reset"
                onClick={() => setDraft(field.path, current)}
              >
                {t('config.revert')}
              </button>
            ) : overridden ? (
              <button
                type="button"
                className="dsh-ai-team__config-reset"
                disabled={!writable}
                onClick={() => setDrafts((previous) => ({ ...previous, [field.path]: null }))}
              >
                {t('config.reset')}
              </button>
            ) : null}
          </label>
        );
      })}
      <div className="dsh-ai-team__config-actions">
        <button type="button" disabled={!staged} onClick={discard}>
          {t('config.discard')}
        </button>
        <button type="button" disabled={!staged || !writable} onClick={save}>
          {t('config.save')}
        </button>
      </div>
    </div>
  );
}

