/**
 * Autopilot 设置卡片 —— 一张以 `autopilot` namespace 为 key 的
 * `settings.plugin.item` 卡片。这就是“插件配置”标签页里的卡片：任何插件只要
 * (a) 注册了 Host 侧的 settings namespace，且 (b) 在该 namespace 下注册了浏览器端
 * 卡片，就会出现这张卡。标签页只负责把两份账配对，并不解释 namespace 的内容，
 * 因此本卡片自己拥有全部外观与表单模型：它绑定 namespace scope，并且只渲染用户
 * 选择暴露出来供编辑的那些 KEY 字段（其余字段仍由组合层 / YAML 管理）。
 */
import { useCallback, useSyncExternalStore, useState } from 'react';
import type { SettingsScope, Translator } from './contract.js';

/** 作用于已解析配置之上的点路径表达式。 */
interface KeyField {
  path: string;
  label: string;
  hint?: string;
  kind: 'text' | 'boolean' | 'number' | 'list';
}

/** 暴露出来供编辑的关键字段（镜像 Config 结构的一个子集）。 */
export const AUTOPILOT_KEY_FIELDS: KeyField[] = [
  { path: 'remote.url', label: 'config.remoteUrl', hint: 'remoteUrlHint', kind: 'text' },
  { path: 'baseBranch', label: 'config.baseBranch', kind: 'text' },
  { path: 'bootstrap.enabled', label: 'config.bootstrapEnabled', kind: 'boolean' },
  { path: 'gates.commands', label: 'config.gatesCommands', hint: 'gatesCommandsHint', kind: 'list' },
  { path: 'gates.requireCiGreen', label: 'config.requireCiGreen', kind: 'boolean' },
  { path: 'gates.timeoutMinutes', label: 'config.gateTimeoutMinutes', kind: 'number' },
  { path: 'daemon.maxReviewRounds', label: 'config.maxReviewRounds', kind: 'number' },
  { path: 'daemon.stuckMinutes', label: 'config.stuckMinutes', kind: 'number' },
  { path: 'daemon.pollIntervalSeconds', label: 'config.pollIntervalSeconds', kind: 'number' },
  { path: 'daemon.maxDiffLines', label: 'config.maxDiffLines', hint: 'maxDiffLinesHint', kind: 'number' },
  { path: 'daemon.maxTaskHours', label: 'config.maxTaskHours', kind: 'number' },
  { path: 'questionnaire.timeoutMinutes', label: 'config.questionnaireTimeoutMinutes', kind: 'number' },
  { path: 'replan.maxPerHour', label: 'config.maxReplanPerHour', kind: 'number' },
  { path: 'security.pushRequiresGates', label: 'config.pushRequiresGates', kind: 'boolean' },
  { path: 'deploy.enabled', label: 'config.deployEnabled', kind: 'boolean' },
  { path: 'learnings.enabled', label: 'config.learningsEnabled', hint: 'learningsEnabledHint', kind: 'boolean' },
];

/** 沿点路径遍历普通对象；任一跳缺失则返回 undefined。 */
function at(source: unknown, path: string): unknown {
  let node: unknown = source;
  for (const hop of path.split('.')) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[hop];
  }
  return node;
}

/** 字段是否被覆盖，取决于它在原始 user 层中的“存在性”，而非取值。 */
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

/** 把字段当前解析出的值渲染成可编辑文本。 */
function toText(kind: KeyField['kind'], value: unknown): string {
  if (kind === 'boolean') return value === true ? 'true' : 'false';
  if (kind === 'list') return Array.isArray(value) ? value.join('\n') : '';
  if (value === undefined || value === null) return '';
  return String(value);
}

/** 把草稿文本解析回带类型的值，供 `scope.set` 使用。 */
function fromText(kind: KeyField['kind'], text: string): unknown {
  if (kind === 'boolean') return text === 'true';
  if (kind === 'number') {
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }
  if (kind === 'list') return text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return text;
}

/** 数字字段草稿是否非法：非空且解析不出有限数（P2-3 即时校验，不静默保存）。 */
function invalidNumber(field: KeyField, text: string): boolean {
  return field.kind === 'number' && text !== '' && !Number.isFinite(Number(text));
}

/**
 * 卡片本体。props 来自 slot 的 `inject()`：一个绑定了 locale 的 `t`
 * 以及该 namespace 的 scope。草稿写入先在本地暂存，点保存时才提交
 * （每次都经由 scope，它会用读到的 revision 为每次写入加围栏）；
 * 放弃则直接丢弃草稿。
 */
export function AutopilotSettingsCard({
  t,
  scope,
}: {
  t: Translator;
  scope: SettingsScope<Record<string, unknown>>;
}) {
  // `scope` 是一个 SettingsScope 实例，其 `subscribe` 依赖 `this`
  // （内部会读 `this.store`）。若把裸方法引用传给 `useSyncExternalStore`，
  // 首次回调时就会丢掉 `this`，所以要用箭头函数包一层，以方法形式调用它 ——
  // React 是把 subscribe 回调当作自由函数来调用的，而不是 `scope.subscribe(...)`。
  const subscribeScope = useCallback((listener: () => void) => scope.subscribe(listener), [scope]);
  const snapshot = useSyncExternalStore(subscribeScope, () => scope.getSnapshot());
  const { status, value, user, writable } = snapshot;
  const [drafts, setDrafts] = useState<Record<string, string | null>>({});
  const [showFull, setShowFull] = useState(false);

  if (status !== 'ready') return null;

  const staged = Object.keys(drafts).length > 0;
  // 任一数字草稿非法就整体禁存：不静默保存一个字符串进数字字段（P2-3）。
  const hasInvalid = AUTOPILOT_KEY_FIELDS.some((field) => {
    const draft = drafts[field.path];
    return draft !== undefined && draft !== null && invalidNumber(field, draft);
  });

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
        const invalid = staged && field.path in drafts && drafts[field.path] !== null && invalidNumber(field, drafts[field.path] ?? '');
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
                className={`dsh-ai-team__config-input${invalid ? ' dsh-ai-team__config-input--invalid' : ''}`}
                type={field.kind === 'number' ? 'number' : 'text'}
                value={shown}
                disabled={!writable}
                aria-invalid={invalid}
                onChange={(event) => setDraft(field.path, event.target.value)}
              />
            )}
            {field.hint !== undefined ? <span className="dsh-ai-team__config-hint">{t(field.hint)}</span> : null}
            {invalid ? <span className="dsh-ai-team__config-error">{t('config.invalidNumber')}</span> : null}
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
      <div className="dsh-ai-team__config-full">
        <button type="button" className="dsh-ai-team__config-reset" onClick={() => setShowFull((v) => !v)}>
          {showFull ? t('config.hideFull') : t('config.viewFull')}
        </button>
        {showFull ? <pre className="dsh-ai-team__config-json">{JSON.stringify(value, null, 2)}</pre> : null}
      </div>
      <div className="dsh-ai-team__config-actions">
        <button type="button" disabled={!staged} onClick={discard}>
          {t('config.discard')}
        </button>
        <button type="button" disabled={!staged || !writable || hasInvalid} onClick={save}>
          {t('config.save')}
        </button>
      </div>
    </div>
  );
}

