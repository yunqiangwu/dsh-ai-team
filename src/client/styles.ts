/**
 * Panel stylesheet, injected as a single tagged <style> element (the same
 * contract the DSH monorepo's clientBundle preset emits for global CSS).
 * Kept as a plain string so the standalone build needs no CSS pipeline.
 * Colors track the host theme through the --dsw-* design tokens.
 */

export const PANEL_CSS = `
.dsh-ai-team {
  border: 1px solid var(--dsw-alias-line-l2, rgba(127, 127, 127, 0.25));
  border-radius: 10px;
  background: var(--dsw-alias-fill-l1, rgba(127, 127, 127, 0.06));
  margin: 4px 0;
  overflow: hidden;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-ai-team__header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.dsh-ai-team__header:hover { background: var(--dsw-alias-fill-l2, rgba(127, 127, 127, 0.12)); }
.dsh-ai-team__title { font-weight: 600; }
.dsh-ai-team__summary {
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.9));
  font-family: var(--dsw-font-mono, monospace);
}
.dsh-ai-team__chevron { margin-left: auto; transition: transform 120ms ease; }
.dsh-ai-team--open .dsh-ai-team__chevron { transform: rotate(90deg); }
.dsh-ai-team__body { padding: 8px 10px 10px; display: grid; gap: 10px; }
.dsh-ai-team__section-title {
  margin: 0 0 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.9));
}
.dsh-ai-team__members { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-ai-team__member {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-fill-l2, rgba(127, 127, 127, 0.12));
}
.dsh-ai-team__dot { width: 7px; height: 7px; border-radius: 50%; }
.dsh-ai-team__dot--idle { background: var(--dsw-alias-label-quaternary, #9e9e9e); }
.dsh-ai-team__dot--working { background: var(--dsw-alias-activity-blue, #3b82f6); }
.dsh-ai-team__dot--reviewing { background: var(--dsw-alias-activity-orange, #f59e0b); }
.dsh-ai-team__role {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 4px;
  font-weight: 600;
}
.dsh-ai-team__role--leader { background: rgba(168, 85, 247, 0.18); color: #a855f7; }
.dsh-ai-team__role--developer { background: rgba(59, 130, 246, 0.18); color: #3b82f6; }
.dsh-ai-team__role--reviewer { background: rgba(245, 158, 11, 0.18); color: #f59e0b; }
.dsh-ai-team__branches { display: flex; flex-wrap: wrap; gap: 4px; }
.dsh-ai-team__branch {
  font-family: var(--dsw-font-mono, monospace);
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--dsw-alias-fill-l2, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-secondary, inherit);
}
.dsh-ai-team__branch--base {
  background: rgba(34, 197, 94, 0.16);
  color: #22c55e;
  font-weight: 600;
}
.dsh-ai-team__kanban {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
}
.dsh-ai-team__column {
  border-radius: 8px;
  background: var(--dsw-alias-fill-l2, rgba(127, 127, 127, 0.08));
  padding: 6px;
  min-height: 42px;
}
.dsh-ai-team__column-title {
  margin: 0 0 5px;
  font-size: 11px;
  font-weight: 600;
  display: flex;
  justify-content: space-between;
  color: var(--dsw-alias-label-secondary, inherit);
}
.dsh-ai-team__card {
  border-radius: 6px;
  background: var(--dsw-alias-bg-elevated, var(--dsw-alias-fill-l1, rgba(127, 127, 127, 0.12)));
  border: 1px solid var(--dsw-alias-line-l2, rgba(127, 127, 127, 0.18));
  padding: 5px 7px;
  margin-bottom: 5px;
  display: grid;
  gap: 2px;
}
.dsh-ai-team__card-title { font-weight: 600; word-break: break-word; }
.dsh-ai-team__card-meta {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.9));
  font-size: 11px;
}
.dsh-ai-team__card-branch {
  font-family: var(--dsw-font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-ai-team__round {
  color: var(--dsw-alias-activity-orange, #f59e0b);
  font-weight: 600;
}
.dsh-ai-team__empty {
  padding: 8px 10px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.9));
}
`

/** Inject the panel stylesheet once per document; idempotent. */
export function ensurePanelStyles(): void {
  if (typeof document === 'undefined') return
  const tagId = 'dsh-ai-team/panel.css'
  if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-ai-team'
  tag.dataset.pluginCss = tagId
  tag.textContent = PANEL_CSS
  document.head.appendChild(tag)
}
