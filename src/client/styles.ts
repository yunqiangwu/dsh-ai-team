/**
 * Panel styles, injected once per document. Plain CSS with a dsh-ai-team__
 * prefix to avoid collisions; colors follow the host theme via currentColor
 * and neutral alpha overlays, with semantic accents for status.
 */
const CSS = `
.dsh-ai-team { border: 1px solid rgba(127,127,127,.25); border-radius: 12px; margin: 8px 0; overflow: hidden; font-size: 12px; }
.dsh-ai-team__header { display: flex; align-items: center; gap: 12px; width: 100%; padding: 13px 16px; background: rgba(127,127,127,.06); border: none; cursor: pointer; color: inherit; font: inherit; font-size: 13px; text-align: left; }
.dsh-ai-team__header:hover { background: rgba(127,127,127,.12); }
.dsh-ai-team__header:active { background: rgba(127,127,127,.16); }
.dsh-ai-team__header:focus-visible { outline: 2px solid rgba(59,130,246,.55); outline-offset: 2px; }
.dsh-ai-team__title { font-weight: 600; white-space: nowrap; }
.dsh-ai-team__summary { opacity: .7; flex: 1; min-width: 0; }
.dsh-ai-team__chevron { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; font-size: 16px; line-height: 1; border-radius: 50%; border: 1px solid rgba(127,127,127,.35); transition: transform .15s ease, background .15s ease; }
.dsh-ai-team__header:hover .dsh-ai-team__chevron { background: rgba(127,127,127,.15); }
.dsh-ai-team--open .dsh-ai-team__chevron { transform: rotate(90deg); }
.dsh-ai-team--open .dsh-ai-team__header { border-bottom: 1px solid rgba(127,127,127,.12); }
.dsh-ai-team__body { padding: 8px 16px 16px; display: flex; flex-direction: column; gap: 12px; }
.dsh-ai-team__section-title { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .55; }
.dsh-ai-team__lamp { display: inline-flex; align-items: center; gap: 7px; padding: 4px 11px; border-radius: 999px; border: 1px solid rgba(127,127,127,.35); font-weight: 600; white-space: nowrap; flex: none; }
.dsh-ai-team__lamp-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.dsh-ai-team__lamp--running .dsh-ai-team__lamp-dot { background: #22c55e; }
.dsh-ai-team__lamp--paused .dsh-ai-team__lamp-dot { background: #eab308; }
.dsh-ai-team__lamp--escalated .dsh-ai-team__lamp-dot { background: #ef4444; }
.dsh-ai-team__lamp--completed .dsh-ai-team__lamp-dot { background: #3b82f6; }
.dsh-ai-team__lamp--stopped .dsh-ai-team__lamp-dot { background: #9ca3af; }
.dsh-ai-team__members { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-ai-team__member { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid rgba(127,127,127,.3); border-radius: 999px; }
.dsh-ai-team__dot { width: 7px; height: 7px; border-radius: 50%; }
.dsh-ai-team__dot--idle { background: #9ca3af; }
.dsh-ai-team__dot--working { background: #22c55e; }
.dsh-ai-team__dot--reviewing { background: #3b82f6; }
.dsh-ai-team__role { opacity: .55; font-size: 10px; }
.dsh-ai-team__kanban { display: grid; grid-template-columns: repeat(6, minmax(120px, 1fr)); gap: 8px; overflow-x: auto; }
.dsh-ai-team__column { border: 1px solid rgba(127,127,127,.2); border-radius: 8px; padding: 6px; min-height: 48px; }
.dsh-ai-team__column-title { display: flex; justify-content: space-between; margin: 0 0 6px; font-size: 11px; opacity: .75; }
.dsh-ai-team__card { display: flex; flex-direction: column; gap: 2px; padding: 6px; border-radius: 6px; background: rgba(127,127,127,.12); margin-bottom: 6px; }
.dsh-ai-team__card-title { font-weight: 600; }
.dsh-ai-team__card-meta { display: flex; gap: 6px; flex-wrap: wrap; opacity: .7; font-size: 11px; }
.dsh-ai-team__badge { padding: 0 6px; border-radius: 999px; font-size: 10px; border: 1px solid rgba(127,127,127,.35); }
.dsh-ai-team__badge--pass { color: #22c55e; border-color: #22c55e; }
.dsh-ai-team__badge--fail { color: #ef4444; border-color: #ef4444; }
.dsh-ai-team__badge--pending { color: #eab308; border-color: #eab308; }
.dsh-ai-team__feed { display: flex; flex-direction: column; gap: 4px; max-height: 140px; overflow-y: auto; }
.dsh-ai-team__feed-item { padding: 6px 8px; border-left: 3px solid #ef4444; background: rgba(239,68,68,.08); border-radius: 4px; }
.dsh-ai-team__feed-item--resolved { opacity: .5; border-left-color: #9ca3af; background: rgba(127,127,127,.08); }
.dsh-ai-team__feed-reason { font-weight: 600; margin-right: 6px; }
.dsh-ai-team__feed-notify { display: inline-flex; gap: 6px; align-items: center; margin-left: 8px; }
.dsh-ai-team__feed-check { color: #22c55e; }
.dsh-ai-team__deploy { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; border-bottom: 1px dashed rgba(127,127,127,.2); }
.dsh-ai-team__empty { opacity: .5; font-style: italic; }
/* ── Plugin settings card (settings.plugin.item / autopilot namespace) ── */
.dsh-ai-team__config { display: flex; flex-direction: column; gap: 12px; }
.dsh-ai-team__config-intro { margin: 0 0 2px; font-size: 12px; opacity: .6; }
.dsh-ai-team__config-field { display: flex; flex-direction: column; gap: 4px; }
.dsh-ai-team__config-label { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
.dsh-ai-team__config-overridden { font-style: normal; font-size: 11px; color: #eab308; font-weight: 500; }
.dsh-ai-team__config-input { font: inherit; padding: 6px 10px; border: 1px solid rgba(127,127,127,.35); border-radius: 8px; background: transparent; color: inherit; }
.dsh-ai-team__config-area { resize: vertical; }
.dsh-ai-team__config-hint { font-size: 11px; opacity: .5; }
.dsh-ai-team__config-reset { align-self: flex-start; font: inherit; font-size: 11px; cursor: pointer; border: none; background: none; color: #3b82f6; padding: 0; }
.dsh-ai-team__config-reset:disabled { opacity: .4; cursor: default; }
.dsh-ai-team__config-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.dsh-ai-team__config-actions button { font: inherit; font-size: 12px; cursor: pointer; border: 1px solid rgba(127,127,127,.35); border-radius: 8px; padding: 5px 14px; background: transparent; color: inherit; }
.dsh-ai-team__config-actions button:disabled { opacity: .4; cursor: default; }
.dsh-ai-team__config-actions button[type='button']:last-child { background: rgba(59,130,246,.9); border-color: transparent; color: #fff; }
`;

let injected = false;

/** Inject the stylesheet once; safe to call on every client plugin load. */
export function ensurePanelStyles(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.dataset['dshAutopilot'] = '';
  style.textContent = CSS;
  document.head.appendChild(style);
}
