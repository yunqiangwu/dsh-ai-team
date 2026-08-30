/**
 * 面板样式，每个 document 只注入一次。使用 dsh-ai-team__ 前缀的纯 CSS
 * 以避免命名冲突；配色通过 currentColor 与中性 alpha 叠加层跟随宿主主题，
 * 并为状态提供语义化强调色。
 */
const CSS = `
.dsh-ai-team { position: relative; border: 1px solid rgba(127,127,127,.25); border-radius: 12px; margin: 8px 0; overflow: hidden; font-size: 12px; }
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
.dsh-ai-team__body { padding: 8px 16px 16px; display: flex; flex-direction: column; gap: 12px; max-height: min(62vh, 720px); min-height: 96px; overflow-y: auto; resize: vertical; }
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
/* ── 周期区（CYC-5）：多周期团队一眼看到周期列表与每周期任务分组；活跃周期高亮 ── */
.dsh-ai-team__cycles { display: flex; flex-direction: column; gap: 8px; }
.dsh-ai-team__cycle { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid rgba(127,127,127,.2); border-radius: 8px; }
.dsh-ai-team__cycle--active { border-color: rgba(59,130,246,.55); background: rgba(59,130,246,.06); }
.dsh-ai-team__cycle-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-ai-team__cycle-name { font-weight: 700; font-size: 12px; }
.dsh-ai-team__cycle-progress { margin-left: auto; opacity: .7; font-size: 11px; }
.dsh-ai-team__cycle-goal { margin: 2px 0 0; font-size: 11px; opacity: .65; }
.dsh-ai-team__cycle-tasks { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.dsh-ai-team__kanban { columns: 200px; column-gap: 10px; }
.dsh-ai-team__column { break-inside: avoid; page-break-inside: avoid; margin-bottom: 10px; border: 1px solid rgba(127,127,127,.2); border-radius: 8px; padding: 6px; }
.dsh-ai-team__column-title { display: flex; justify-content: space-between; margin: 0 0 6px; font-size: 11px; opacity: .75; }
.dsh-ai-team__card { position: relative; display: flex; flex-direction: column; gap: 2px; padding: 5px 6px; border-radius: 6px; background: rgba(127,127,127,.12); margin-bottom: 6px; }
.dsh-ai-team__card-title { font-weight: 600; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-ai-team__card-meta { display: flex; gap: 6px; flex-wrap: wrap; opacity: .7; font-size: 10px; }
.dsh-ai-team__card-tip { position: fixed; z-index: 80; min-width: 220px; max-width: 340px; max-height: 240px; overflow: auto; background: #1f2329; color: #eef1f6; border: 1px solid rgba(127,127,127,.35); border-radius: 8px; padding: 8px 10px; box-shadow: 0 8px 24px rgba(0,0,0,.45); }
.dsh-ai-team__card-tip-title { display: block; font-size: 12px; font-weight: 700; }
.dsh-ai-team__card-tip-desc { margin-top: 4px; font-size: 11px; white-space: pre-wrap; word-break: break-word; opacity: .9; }
.dsh-ai-team__card-tip-branch { display: block; margin-top: 6px; font-size: 10px; opacity: .6; }
.dsh-ai-team__badge { padding: 0 6px; border-radius: 999px; font-size: 10px; border: 1px solid rgba(127,127,127,.35); }
.dsh-ai-team__badge--pass { color: #22c55e; border-color: #22c55e; }
.dsh-ai-team__badge--fail { color: #ef4444; border-color: #ef4444; }
.dsh-ai-team__badge--pending { color: #eab308; border-color: #eab308; }
.dsh-ai-team__feed { display: flex; flex-direction: column; gap: 4px; max-height: 140px; overflow-y: auto; }
/* 升级流里内联了分诊表单，140px 会把输入框和提交按钮一起裁掉。 */
.dsh-ai-team__feed--with-form { max-height: none; overflow-y: visible; }
.dsh-ai-team__feed-item { padding: 6px 8px; border-left: 3px solid #ef4444; background: rgba(239,68,68,.08); border-radius: 4px; }
.dsh-ai-team__feed-item--resolved { opacity: .5; border-left-color: #9ca3af; background: rgba(127,127,127,.08); }
.dsh-ai-team__feed-reason { font-weight: 600; margin-right: 6px; }
.dsh-ai-team__feed-notify { display: inline-flex; gap: 6px; align-items: center; margin-left: 8px; }
.dsh-ai-team__feed-check { color: #22c55e; }
.dsh-ai-team__deploy { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; border-bottom: 1px dashed rgba(127,127,127,.2); }
.dsh-ai-team__empty { opacity: .5; font-style: italic; }
/* ── 等你决策（面板内作答）：琥珀色是"轮到你了"，红色留给"有东西坏了" ── */
.dsh-ai-team__awaiting-list { display: flex; flex-direction: column; gap: 10px; }
.dsh-ai-team__awaiting { border: 1px solid rgba(234,179,8,.45); border-left: 3px solid #eab308; background: rgba(234,179,8,.08); border-radius: 8px; padding: 8px 10px; }
.dsh-ai-team__awaiting-head { display: flex; align-items: baseline; gap: 6px; }
.dsh-ai-team__awaiting-hint { margin: 2px 0 6px; font-size: 11px; opacity: .65; }
.dsh-ai-team__badge--awaiting { color: #b45309; border-color: #eab308; background: rgba(234,179,8,.12); font-weight: 600; }
.dsh-ai-team__form { display: flex; flex-direction: column; gap: 8px; }
.dsh-ai-team__field { display: flex; flex-direction: column; gap: 3px; }
.dsh-ai-team__field-label { font-size: 12px; font-weight: 600; }
.dsh-ai-team__field-optional { font-style: normal; font-size: 10px; opacity: .55; font-weight: 400; margin-left: 4px; }
.dsh-ai-team__choices { display: flex; flex-direction: column; gap: 2px; }
.dsh-ai-team__choice { display: flex; align-items: baseline; gap: 6px; font-size: 12px; font-weight: 400; }
.dsh-ai-team__form-row { display: flex; justify-content: flex-end; gap: 8px; }
.dsh-ai-team__form-row button { font: inherit; font-size: 12px; cursor: pointer; border: 1px solid transparent; border-radius: 8px; padding: 5px 14px; background: rgba(234,179,8,.9); color: #1f2329; font-weight: 600; }
.dsh-ai-team__form-row button:disabled { opacity: .45; cursor: default; }
.dsh-ai-team__form-error { margin: 0; font-size: 11px; color: #ef4444; }
.dsh-ai-team__form-ok { margin: 0; font-size: 11px; color: #22c55e; }
/* ── 插件设置卡片（settings.plugin.item / autopilot namespace） ── */
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
/* ── Grafana 风格统计卡（短标签 + 数字，点击弹详情浮窗） ── */
.dsh-ai-team__stats { width: 100%; display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; align-items: stretch; }
.dsh-ai-team__stat { display: flex; align-items: baseline; gap: 8px; padding: 8px 10px; border: 1px solid rgba(127,127,127,.2); border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dsh-ai-team__stat:hover { background: rgba(127,127,127,.1); border-color: rgba(59,130,246,.4); }
.dsh-ai-team__stat-value { font-size: 20px; font-weight: 700; line-height: 1; }
.dsh-ai-team__stat-label { font-size: 11px; opacity: .7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 点击统计卡弹出的详情浮窗 */
.dsh-ai-team__overlay { position: absolute; inset: 0; z-index: 60; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; padding: 12px; }
.dsh-ai-team__overlay-panel { width: min(560px, 96%); max-height: 70%; overflow: auto; background: #1f2329; color: #eef1f6; border: 1px solid rgba(127,127,127,.4); border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,.5); }
.dsh-ai-team__overlay-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid rgba(127,127,127,.25); font-size: 13px; font-weight: 600; }
.dsh-ai-team__overlay-close { font: inherit; border: none; background: transparent; color: inherit; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
.dsh-ai-team__overlay-close:hover { background: rgba(127,127,127,.2); }
.dsh-ai-team__overlay-body { padding: 12px 14px; }
/* ── 等你决策：可最小化的浮动弹窗（默认收起，右下角小胶囊；点开浮窗作答） ── */
.dsh-ai-team__floating { position: absolute; right: 8px; bottom: 8px; z-index: 40; max-width: 420px; border: 1px solid rgba(234,179,8,.5); border-radius: 10px; background: rgba(20,20,20,.92); color: #eef1f6; box-shadow: 0 10px 28px rgba(0,0,0,.5); }
.dsh-ai-team__floating-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px; border: none; background: transparent; color: inherit; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.dsh-ai-team__floating-head:hover { background: rgba(234,179,8,.12); }
.dsh-ai-team__floating-head .dsh-ai-team__badge--awaiting { margin-left: auto; }
.dsh-ai-team__floating-body { padding: 10px 12px 12px; border-top: 1px solid rgba(234,179,8,.35); max-height: 320px; overflow: auto; }
`;

let injected = false;

/** 只注入一次样式表；每次客户端插件加载时调用都是安全的。 */
export function ensurePanelStyles(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.dataset['dshAutopilot'] = '';
  style.textContent = CSS;
  document.head.appendChild(style);
}
