/**
 * 面板样式，每个 document 只注入一次。使用 dsh-ai-team__ 前缀的纯 CSS
 * 以避免命名冲突；配色通过 currentColor 与中性 alpha 叠加层跟随宿主主题，
 * 并为状态提供语义化强调色。
 *
 * v1.7.1 紧凑重构（2026-08-31）：
 *   - body 内边距从 16px → 12px，间距从 12px → 8px
 *   - StatsStrip 从 4×2 网格卡 → 一行 chip 条（≈28px 高，省 ≈100px）
 *   - 成员 section 独立标题 + 内边距去掉，合并到看板 header 行
 *   - 任务卡 padding 5/6 → 3/4，meta 10pt → 9pt
 *   - LoopGuide / PhaseGuide / AsyncResumeBanner 默认折叠到右上角徽章
 *   - 配色/状态色/覆层/键盘可达全部沿用现有调色板
 */
const CSS = `
.dsh-ai-team { position: relative; border: 1px solid rgba(127,127,127,.25); border-radius: 10px; margin: 8px 0; overflow: hidden; font-size: 12px; }
.dsh-ai-team__header { display: flex; align-items: center; gap: 12px; width: 100%; padding: 8px 14px; background: rgba(127,127,127,.06); border: none; cursor: pointer; color: inherit; font: inherit; font-size: 13px; text-align: left; }
.dsh-ai-team__header:hover { background: rgba(127,127,127,.12); }
.dsh-ai-team__header:active { background: rgba(127,127,127,.16); }
.dsh-ai-team__header:focus-visible { outline: 2px solid rgba(59,130,246,.55); outline-offset: 2px; }
.dsh-ai-team__title { font-weight: 600; white-space: nowrap; }
.dsh-ai-team__summary { opacity: .7; flex: 1; min-width: 0; }
.dsh-ai-team__chevron { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; font-size: 16px; line-height: 1; border-radius: 50%; border: 1px solid rgba(127,127,127,.35); transition: transform .15s ease, background .15s ease; }
.dsh-ai-team__header:hover .dsh-ai-team__chevron { background: rgba(127,127,127,.15); }
.dsh-ai-team--open .dsh-ai-team__chevron { transform: rotate(90deg); }
.dsh-ai-team--open .dsh-ai-team__header { border-bottom: 1px solid rgba(127,127,127,.12); }
/* ── 紧凑重构: body padding 4/10/6, gap 0 — 消除 body flex 子项间的均匀间距，
   只给需要分隔的 section 自己加 margin-top ── */
.dsh-ai-team__body { padding: 4px 10px 6px; display: flex; flex-direction: column; gap: 0; max-height: min(42vh, 480px); min-height: 96px; overflow-y: auto; resize: vertical; }
.dsh-ai-team__section-title { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .55; }
.dsh-ai-team__lamp { display: inline-flex; align-items: center; gap: 7px; padding: 4px 11px; border-radius: 999px; border: 1px solid rgba(127,127,127,.35); font-weight: 600; white-space: nowrap; flex: none; }
.dsh-ai-team__lamp-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.dsh-ai-team__lamp--running .dsh-ai-team__lamp-dot { background: #22c55e; }
.dsh-ai-team__lamp--paused .dsh-ai-team__lamp-dot { background: #eab308; }
.dsh-ai-team__lamp--escalated .dsh-ai-team__lamp-dot { background: #ef4444; }
.dsh-ai-team__lamp--completed .dsh-ai-team__lamp-dot { background: #3b82f6; }
.dsh-ai-team__lamp--stopped .dsh-ai-team__lamp-dot { background: #9ca3af; }
/* ── 紧凑重构: members section 独立标题+内边距去掉，合并到 header 行 ── */
.dsh-ai-team__members { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-ai-team__member { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid rgba(127,127,127,.3); border-radius: 999px; }
.dsh-ai-team__dot { width: 7px; height: 7px; border-radius: 50%; }
.dsh-ai-team__dot--idle { background: #9ca3af; }
.dsh-ai-team__dot--working { background: #22c55e; }
.dsh-ai-team__dot--reviewing { background: #3b82f6; }
.dsh-ai-team__role { opacity: .55; font-size: 10px; }
/* ── 周期区（CYC-5）：多周期团队一眼看到周期列表与每周期任务分组；活跃周期高亮 ── */
.dsh-ai-team__cycles { display: flex; flex-direction: column; gap: 8px; }
.dsh-ai-team__cycle { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border: 1px solid rgba(127,127,127,.2); border-radius: 8px; }
.dsh-ai-team__cycle--active { border-color: rgba(59,130,246,.55); background: rgba(59,130,246,.06); }
.dsh-ai-team__cycle-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-ai-team__cycle-name { font-weight: 700; font-size: 12px; }
.dsh-ai-team__cycle-progress { margin-left: auto; opacity: .7; font-size: 11px; }
.dsh-ai-team__cycle-goal { margin: 2px 0 0; font-size: 11px; opacity: .65; }
.dsh-ai-team__cycle-tasks { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
/* ── 紧凑重构: kanban 多列瀑布流, 每列限高+列内滚动 ── */
.dsh-ai-team__kanban { columns: 200px; column-gap: 6px; }
.dsh-ai-team__column { break-inside: avoid; page-break-inside: avoid; margin-bottom: 4px; border: 1px solid rgba(127,127,127,.2); border-radius: 6px; padding: 3px; max-height: 320px; overflow-y: auto; }
.dsh-ai-team__column-title { display: flex; justify-content: space-between; margin: 0 0 3px; font-size: 11px; opacity: .75; position: sticky; top: 0; background: inherit; z-index: 1; }
/* ── 紧凑重构: card padding 5/6→3/4, meta 10pt→9pt, margin-bottom 6→4 ── */
.dsh-ai-team__card { position: relative; display: flex; flex-direction: column; gap: 1px; padding: 2px 4px; border-radius: 5px; background: rgba(127,127,127,.12); margin-bottom: 3px; }
.dsh-ai-team__card-title { font-weight: 600; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-ai-team__card-meta { display: flex; gap: 4px; flex-wrap: wrap; opacity: .7; font-size: 9px; }
.dsh-ai-team__card-tip { position: fixed; z-index: 80; min-width: 220px; max-width: 340px; max-height: 240px; overflow: auto; background: #1f2329; color: #eef1f6; border: 1px solid rgba(127,127,127,.35); border-radius: 8px; padding: 8px 10px; box-shadow: 0 8px 24px rgba(0,0,0,.45); }
.dsh-ai-team__card-tip-title { display: block; font-size: 12px; font-weight: 700; }
.dsh-ai-team__card-tip-desc { margin-top: 4px; font-size: 11px; white-space: pre-wrap; word-break: break-word; opacity: .9; }
.dsh-ai-team__card-tip-branch { display: block; margin-top: 6px; font-size: 10px; opacity: .6; }
/* ── 看板 header: 标题 + 筛选 + 成员 + 活跃周期 同行 ── */
/* margin-top 4px 是 body 里唯一的 section 分隔 —— body gap=0, StatsStrip 和 TeamBody 贴 */
.dsh-ai-team__board-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.dsh-ai-team__board-head-title { font-weight: 600; font-size: 12px; white-space: nowrap; }
.dsh-ai-team__board-head-filters { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex: 1; min-width: 0; }
.dsh-ai-team__board-head-filters .dsh-ai-team__config-input { font-size: 11px; padding: 3px 7px; }
.dsh-ai-team__board-head-filters button { font: inherit; font-size: 11px; padding: 3px 8px; cursor: pointer; border: 1px solid rgba(127,127,127,.35); border-radius: 6px; background: transparent; color: inherit; white-space: nowrap; }
.dsh-ai-team__board-head-filters button:hover { background: rgba(127,127,127,.15); }
.dsh-ai-team__board-head-members { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-ai-team__board-head-active { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; border: 1px solid rgba(59,130,246,.45); background: rgba(59,130,246,.08); font-size: 10px; font-weight: 600; white-space: nowrap; }
/* 旧 filters class 保留但不再主导 —— 看板 header 已接管全部过滤控件 */
.dsh-ai-team__filters { display: none; }
.dsh-ai-team__filter-search { flex: 1; min-width: 140px; }
/* 任务卡点击展开的详情（P2-1）：就地展开，不依赖 hover */
.dsh-ai-team__card--expanded { border-color: rgba(59,130,246,.5); }
.dsh-ai-team__card-detail { margin-top: 3px; padding-top: 3px; border-top: 1px dashed rgba(127,127,127,.25); font-size: 11px; }
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
.dsh-ai-team__activity-time { margin-left: auto; opacity: .55; font-size: 10px; white-space: nowrap; }
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
/* 升级分诊的「按建议执行」：次级描边按钮，与主提交区分（P1-3） */
.dsh-ai-team__form-row .dsh-ai-team__form-quick { background: transparent; border-color: rgba(234,179,8,.6); color: #eab308; }
.dsh-ai-team__form-error { margin: 0; font-size: 11px; color: #ef4444; }
.dsh-ai-team__form-ok { margin: 0; font-size: 11px; color: #22c55e; }
/* ── 插件设置卡片（settings.plugin.item / autopilot namespace） ── */
.dsh-ai-team__config { display: flex; flex-direction: column; gap: 12px; }
.dsh-ai-team__config-intro { margin: 0 0 2px; font-size: 12px; opacity: .6; }
.dsh-ai-team__config-field { display: flex; flex-direction: column; gap: 4px; }
.dsh-ai-team__config-label { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
.dsh-ai-team__config-overridden { font-style: normal; font-size: 11px; color: #eab308; font-weight: 500; }
.dsh-ai-team__config-input { font: inherit; padding: 6px 10px; border: 1px solid rgba(127,127,127,.35); border-radius: 8px; background: transparent; color: inherit; }
.dsh-ai-team__config-input--invalid { border-color: #ef4444; }
.dsh-ai-team__config-error { font-size: 11px; color: #ef4444; }
.dsh-ai-team__config-full { display: flex; flex-direction: column; gap: 6px; }
.dsh-ai-team__config-json { margin: 0; padding: 8px 10px; max-height: 240px; overflow: auto; border: 1px solid rgba(127,127,127,.25); border-radius: 8px; background: rgba(127,127,127,.08); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.dsh-ai-team__config-area { resize: vertical; }
.dsh-ai-team__config-hint { font-size: 11px; opacity: .5; }
.dsh-ai-team__config-reset { align-self: flex-start; font: inherit; font-size: 11px; cursor: pointer; border: none; background: none; color: #3b82f6; padding: 0; }
.dsh-ai-team__config-reset:disabled { opacity: .4; cursor: default; }
.dsh-ai-team__config-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.dsh-ai-team__config-actions button { font: inherit; font-size: 12px; cursor: pointer; border: 1px solid rgba(127,127,127,.35); border-radius: 8px; padding: 5px 14px; background: transparent; color: inherit; }
.dsh-ai-team__config-actions button:disabled { opacity: .4; cursor: default; }
.dsh-ai-team__config-actions button[type='button']:last-child { background: rgba(59,130,246,.9); border-color: transparent; color: #fff; }
/* ── 紧凑重构: StatsStrip 从 4×2 网格卡 → 一行 chip 条 ── */
.dsh-ai-team__stats { width: 100%; display: flex; align-items: center; gap: 4px; padding: 0; overflow-x: auto; }
/* 完成态 chip 前置：绿色描边 + 加粗，一眼看出这轮收工了 */
.dsh-ai-team__stat--completed { border-color: #22c55e; color: #22c55e; font-weight: 700; padding: 2px 10px; background: rgba(34,197,94,.1); }
.dsh-ai-team__stat--completed:hover { background: rgba(34,197,94,.2); border-color: #22c55e; }
.dsh-ai-team__stat { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border: 1px solid rgba(127,127,127,.25); border-radius: 999px; background: transparent; color: inherit; font: inherit; font-size: 11px; line-height: 1.4; cursor: pointer; white-space: nowrap; flex: none; }
.dsh-ai-team__stat:hover { background: rgba(127,127,127,.1); border-color: rgba(59,130,246,.4); }
.dsh-ai-team__stat-value { font-weight: 700; font-size: 12px; }
.dsh-ai-team__stat-label { opacity: .65; }
/* 点击统计卡弹出的详情浮窗 */
.dsh-ai-team__overlay { position: absolute; inset: 0; z-index: 60; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; padding: 12px; }
.dsh-ai-team__overlay-panel { width: min(560px, 96%); max-height: 70%; overflow: auto; background: #1f2329; color: #eef1f6; border: 1px solid rgba(127,127,127,.4); border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,.5); }
.dsh-ai-team__overlay-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid rgba(127,127,127,.25); font-size: 13px; font-weight: 600; }
.dsh-ai-team__overlay-close { font: inherit; border: none; background: transparent; color: inherit; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
.dsh-ai-team__overlay-close:hover { background: rgba(127,127,127,.2); }
.dsh-ai-team__overlay-body { padding: 12px 14px; }
/* ── 紧凑重构: guide 默认折叠到右上角徽章，展开才显示完整信息 ── */
/* 从右到左: chevron(header内嵌, right≈16px gap) → alert → guide-fab(async/loop) */
.dsh-ai-team__guide-fab { position: absolute; top: 10px; right: 58px; z-index: 25; display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid rgba(234,179,8,.5); border-radius: 999px; background: rgba(234,179,8,.1); color: #b45309; font-size: 10px; font-weight: 600; cursor: pointer; }
.dsh-ai-team__guide-fab:hover { background: rgba(234,179,8,.2); }
.dsh-ai-team__guide-fab--loop { right: 92px; }
.dsh-ai-team__guide-fab--async { right: 126px; }
/* 完整 guide 块（展开态）：沿用原 alert-style ── */
.dsh-ai-team__guide { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 3px 8px; border: 1px solid rgba(234,179,8,.45); border-left: 3px solid #eab308; background: rgba(234,179,8,.08); border-radius: 8px; }
.dsh-ai-team__guide-label { font-weight: 600; font-size: 11px; color: #eab308; }
.dsh-ai-team__guide-hint { font-size: 11px; opacity: .9; }
/* ── 完成态总结（P2-5）：loop completed 时把交付摘要摆出来 ── */
.dsh-ai-team__summary-card { display: flex; flex-direction: column; gap: 2px; padding: 3px 8px; border: 1px solid rgba(34,197,94,.45); border-left: 3px solid #22c55e; background: rgba(34,197,94,.08); border-radius: 8px; }
.dsh-ai-team__summary-head { display: flex; align-items: center; gap: 8px; }
.dsh-ai-team__summary-title { font-weight: 600; font-size: 12px; }
.dsh-ai-team__summary-meta { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 11px; opacity: .85; }
/* ── async 摩擦横幅（P3-1）：紧凑折叠版，展开后仍保留原样式 ── */
.dsh-ai-team__async-banner { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 3px 8px; border: 1px solid rgba(234,179,8,.45); border-left: 3px solid #eab308; background: rgba(234,179,8,.08); border-radius: 8px; }
.dsh-ai-team__async-text { font-weight: 600; font-size: 11px; }
.dsh-ai-team__async-hint { font-size: 11px; opacity: .8; }
.dsh-ai-team__async-dismiss { font: inherit; font-size: 11px; cursor: pointer; border: 1px solid rgba(234,179,8,.5); border-radius: 6px; padding: 2px 10px; background: transparent; color: #eab308; margin-left: auto; }
/* ── 多团队切换（P3-2）：面板顶部右对齐的团队选择器 ── */
.dsh-ai-team__team-switch { display: flex; justify-content: flex-end; }
.dsh-ai-team__team-switch select { max-width: 240px; font-size: 11px; padding: 4px 8px; }
/* ── 等你决策：可最小化的浮动弹窗（默认收起，右下角小胶囊；点开浮窗作答） ── */
.dsh-ai-team__floating { position: absolute; right: 8px; bottom: 8px; z-index: 40; max-width: 420px; border: 1px solid rgba(234,179,8,.5); border-radius: 10px; background: rgba(20,20,20,.92); color: #eef1f6; box-shadow: 0 10px 28px rgba(0,0,0,.5); }
.dsh-ai-team__floating-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px; border: none; background: transparent; color: inherit; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.dsh-ai-team__floating-head:hover { background: rgba(234,179,8,.12); }
.dsh-ai-team__floating-head .dsh-ai-team__badge--awaiting { margin-left: auto; }
.dsh-ai-team__floating-body { padding: 10px 12px 12px; border-top: 1px solid rgba(234,179,8,.35); max-height: 320px; overflow: auto; }
/* ── 待办中心：四类行动项聚合，问卷/升级内联作答 ── */
.dsh-ai-team__actions { display: flex; flex-direction: column; gap: 8px; }
.dsh-ai-team__actions-section { display: flex; flex-direction: column; gap: 4px; }
.dsh-ai-team__actions-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 12px; font-weight: 600; }
/* ── 升级注意力信号（P1-2）：右上角铃铛，授权后新升级弹系统通知 ── */
/* 从右到左: chevron(内嵌header) → alert(铃铛) → guide-fab */
.dsh-ai-team__alert { position: absolute; top: 10px; right: 42px; z-index: 30; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: 1px solid rgba(127,127,127,.35); border-radius: 50%; background: transparent; color: inherit; cursor: pointer; }
.dsh-ai-team__alert:hover { background: rgba(127,127,127,.15); }
.dsh-ai-team__alert--on { color: #eab308; border-color: #eab308; }
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
