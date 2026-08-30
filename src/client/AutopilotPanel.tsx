/**
 * Autopilot 面板：把 `autopilot` projection 渲染到会话输入框下方的 dock 中，
 * 内容包括循环状态指示灯、成员名单、带质量门徽章的任务看板、升级事件流
 * 和部署历史。projection 席位是响应式的：每次 `autopilot/update` 会话事件
 * 都会实时重绘面板。
 *
 * 面板也是**作答入口**（M2 / INT-3）：待答问卷与未 resolve 的升级各自带一张内联
 * 表单，提交走同源相对路径 `<TICKET_ROUTE_PREFIX>/<id>/answer`，凭据是宿主那套
 * 同源围栏 —— 所以投影里那条 `ticketUrl` 不需要（也不允许）带访问凭据。
 */
import { useState, useRef, useEffect, type ReactNode } from 'react';
import type { SlotProps, Translator } from './contract.js';
import type { AutopilotProjection, CycleView, DeployView, EscalationView, LearningView, MemberView, QuestionnaireView, TaskView, TeamView } from '../view.js';
import { DISPATCHABLE_PHASES, TASK_STATUSES, TICKET_ROUTE_PREFIX } from '../view.js';
import { escalationFields, fieldsOfQuestions, normalizeOption, type TicketField } from '../formmodel.js';

function LoopLamp({ state, t }: { state: AutopilotProjection['loopState']; t: Translator }) {
  return (
    <span className={`dsh-ai-team__lamp dsh-ai-team__lamp--${state}`}>
      <span className="dsh-ai-team__lamp-dot" />
      <span>{t(`loop.${state}`)}</span>
    </span>
  );
}

/**
 * 升级注意力信号（P1-2）：头部琥珀计数已含未解决升级（见 AutopilotPanel 的
 * actionCount），这里补「可选浏览器提醒」——点铃铛授权后，新出现的未解决升级
 * 弹系统通知。授权必须由用户手势触发，所以铃铛是 header 按钮的兄弟节点
 * （不能嵌进 header 那个 button 里，嵌套交互元素既非法又不可键盘达）。
 */
function EscalationAlerts({ escalations, t }: { escalations: EscalationView[]; t: Translator }) {
  const [enabled, setEnabled] = useState(false);
  const seen = useRef<Set<string>>(new Set());
  const unresolved = escalations.filter((escalation) => escalation.resolvedAt === null);
  // 依赖 id 串而非 unresolved 数组：投影每拍都是新数组，按引用依赖会每拍重跑。
  const unresolvedIds = unresolved.map((escalation) => escalation.id).join(',');

  useEffect(() => {
    if (!enabled) return;
    for (const escalation of unresolved) {
      if (seen.current.has(escalation.id)) continue;
      seen.current.add(escalation.id);
      try {
        const notification = new Notification(t('notify.escalationTitle'), { body: escalation.message });
        notification.addEventListener('click', () => window.focus());
      } catch {
        // 某些宿主/浏览器环境不支持构造 Notification，静默降级为只靠头部计数。
      }
    }
  }, [unresolvedIds, enabled, t]);

  const permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  const active = enabled && permission === 'granted';

  const toggle = async () => {
    if (permission === 'default') {
      const result = await Notification.requestPermission();
      if (result === 'granted') {
        // 刚开启时把已有升级全部标记为「已见」，避免一开就轰炸一串通知。
        unresolved.forEach((escalation) => seen.current.add(escalation.id));
        setEnabled(true);
      }
      return;
    }
    if (permission === 'granted') {
      if (!enabled) unresolved.forEach((escalation) => seen.current.add(escalation.id));
      setEnabled((value) => !value);
    }
  };

  return (
    <button
      type="button"
      className={`dsh-ai-team__alert${active ? ' dsh-ai-team__alert--on' : ''}`}
      title={active ? t('notify.on') : permission === 'denied' ? t('notify.denied') : t('notify.off')}
      onClick={() => void toggle()}
      aria-pressed={active}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
    </button>
  );
}

function MemberChip({ member, t }: { member: MemberView; t: Translator }) {
  return (
    <span className="dsh-ai-team__member" title={`${member.workspacePath}\n${member.branch}`}>
      <span className={`dsh-ai-team__dot dsh-ai-team__dot--${member.status}`} />
      <span>{member.name}</span>
      <span className={`dsh-ai-team__role`}>{t(`role.${member.role}`)}</span>
    </span>
  );
}

function GateBadge({ task, t }: { task: TaskView; t: Translator }) {
  if (task.gates === null) return null;
  const passed = task.gates.results.filter((result) => result.passed).length;
  const total = task.gates.results.length;
  return (
    <span
      className={`dsh-ai-team__badge ${task.gates.allPassed ? 'dsh-ai-team__badge--pass' : 'dsh-ai-team__badge--fail'}`}
      title={`${t('gates.tooltip')}\n${task.gates.results.map((result) => `${result.passed ? '✓' : '✗'} ${result.command}`).join('\n')}`}
    >
      {t('gates.badge', { passed, total })}
    </span>
  );
}

function CiBadge({ task, t }: { task: TaskView; t: Translator }) {
  if (task.ciStatus === null || task.ciStatus === 'unknown') return null;
  const kind =
    task.ciStatus === 'success' ? 'pass' : task.ciStatus === 'failure' ? 'fail' : 'pending';
  return <span className={`dsh-ai-team__badge dsh-ai-team__badge--${kind}`}>{t(`ci.${task.ciStatus}`)}</span>;
}

function TaskCard({ task, awaiting, t }: { task: TaskView; awaiting: QuestionnaireView | undefined; t: Translator }) {
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const ref = useRef<HTMLDivElement>(null);

  const showTip = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect !== undefined) {
      setPos({
        top: Math.min(rect.bottom + 6, window.innerHeight - 240),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 340)),
      });
    }
    setHover(true);
  };

  return (
    <div ref={ref} className="dsh-ai-team__card" onMouseEnter={showTip} onMouseLeave={() => setHover(false)}>
      <span className="dsh-ai-team__card-title">{task.title}</span>
      <span className="dsh-ai-team__card-meta">
        <span>{task.assigneeName}</span>
        <GateBadge task={task} t={t} />
        <CiBadge task={task} t={t} />
        {task.reviewRound > 0 ? <span title={t('task.roundHint')}>{t('task.round', { round: task.reviewRound })}</span> : null}
        {/* 等人回答 ≠ 卡住：任务状态一字未改，但看板上必须说得出它在等谁。 */}
        {awaiting !== undefined ? (
          <span className="dsh-ai-team__badge dsh-ai-team__badge--pending" title={awaiting.title}>
            {t('questionnaire.onTask')}
          </span>
        ) : null}
      </span>
      <span className="dsh-ai-team__card-meta">
        <span>{task.branch}</span>
        {task.prUrl !== null ? (
          <a href={task.prUrl} target="_blank" rel="noreferrer">
            PR
          </a>
        ) : null}
      </span>
      {hover ? (
        <div className="dsh-ai-team__card-tip" style={{ top: pos.top, left: pos.left }}>
          <span className="dsh-ai-team__card-tip-title">{task.title}</span>
          <div className="dsh-ai-team__card-tip-desc">{task.description}</div>
          <span className="dsh-ai-team__card-tip-branch">{task.branch}</span>
        </div>
      ) : null}
    </div>
  );
}

// ── 面板内作答（M2 / INT-3）───────────────────────────────────────────────────

type AnswerValues = Record<string, string | string[]>;

interface SubmitResult {
  ok: boolean;
  message?: string;
  missing?: string[];
  /** 诊断线索（HTTP 状态、网络异常），只进 title，不当成人话文案。 */
  detail?: string;
}

/**
 * 把答卷发去同源工单路由。**从不抛**：网络层失败与服务端 4xx 汇成同一个形状，
 * 调用处只管「保留已填内容 + 说清缺什么」（INT-3 场景一）。
 */
async function postAnswer(ticketId: string, answers: AnswerValues): Promise<SubmitResult> {
  try {
    const response = await fetch(`${TICKET_ROUTE_PREFIX}/${encodeURIComponent(ticketId)}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    const payload = (await response.json().catch(() => null)) as SubmitResult | null;
    // 被拒的请求（无凭据、未知 id）走的是纯文本 404，没有可解析的答复体。
    if (payload !== null && typeof payload.ok === 'boolean') return payload;
    return { ok: false, detail: `HTTP ${String(response.status)}` };
  } catch {
    return { ok: false, detail: 'network' };
  }
}

/**
 * 预勾选项即默认答案：人不改就是接受推荐方案。服务端工单页也预勾同样的东西
 * （`fieldsOfQuestions`），两张表单必须给出同一个默认值，否则同一组问题会因
 * 为答题的那张卡片不同而得出不同答案。
 */
function initialValues(fields: TicketField[]): AnswerValues {
  const out: AnswerValues = {};
  for (const field of fields) {
    const checked = (field.options ?? []).map(normalizeOption).filter((option) => option.checked === true);
    if (field.type === 'multiselect') out[field.name] = checked.map((option) => option.value);
    else out[field.name] = checked.length === 0 ? '' : checked[0]!.value;
  }
  return out;
}

function AnswerField({
  field,
  value,
  disabled,
  onChange,
  t,
}: {
  field: TicketField;
  value: string | string[] | undefined;
  disabled: boolean;
  onChange: (next: string | string[]) => void;
  t: Translator;
}) {
  const options = (field.options ?? []).map(normalizeOption);
  const placeholder = field.placeholder ?? '';

  if (field.type === 'multiselect' && options.length > 0) {
    const picked = Array.isArray(value) ? value : [];
    return (
      <div className="dsh-ai-team__field">
        <span className="dsh-ai-team__field-label">{field.label}</span>
        <span className="dsh-ai-team__choices">
          {options.map((option) => (
            <label key={option.value} className="dsh-ai-team__choice" title={option.impact}>
              <input
                type="checkbox"
                disabled={disabled}
                checked={picked.includes(option.value)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...picked, option.value]
                      : picked.filter((item) => item !== option.value),
                  )
                }
              />
              <span>{option.label}</span>
            </label>
          ))}
        </span>
      </div>
    );
  }
  if (options.length > 0) {
    const current = typeof value === 'string' ? value : '';
    // 没有预勾选项时补一个空的「请选择」：否则 required 形同虚设，闭着眼睛就交了第一项。
    const needsBlank = current === '' && !options.some((option) => option.value === '');
    return (
      <label className="dsh-ai-team__field">
        <span className="dsh-ai-team__field-label">{field.label}</span>
        <select
          className="dsh-ai-team__config-input"
          disabled={disabled}
          value={current}
          onChange={(event) => onChange(event.target.value)}
        >
          {needsBlank ? <option value="">{placeholder === '' ? t('questionnaire.choose') : placeholder}</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.impact === undefined || option.impact === '' ? option.label : `${option.label} — ${option.impact}`}
            </option>
          ))}
        </select>
      </label>
    );
  }
  const text = typeof value === 'string' ? value : '';
  return (
    <label className="dsh-ai-team__field">
      <span className="dsh-ai-team__field-label">
        {field.label}
        {field.required !== true ? <em className="dsh-ai-team__field-optional">{t('questionnaire.optional')}</em> : null}
      </span>
      {field.type === 'textarea' ? (
        <textarea
          className="dsh-ai-team__config-input dsh-ai-team__config-area"
          rows={3}
          disabled={disabled}
          value={text}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          className="dsh-ai-team__config-input"
          type={field.type === 'password' ? 'password' : 'text'}
          disabled={disabled}
          value={text}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

/**
 * 一张工单的作答表单。升级分诊与问卷共用它 —— 两者在服务端本来就汇成同一个入口
 * （`submitTicketAnswer`），界面上也没有理由长成两样。
 *
 * 重播种靠**父级 `key={ticketId}`**，不用 `useEffect`：投影每个 tick 都是新对象，
 * 按字段内容做依赖会把人正在打的字冲掉。
 */
function AnswerForm({ ticketId, fields, t }: { ticketId: string; fields: TicketField[]; t: Translator }) {
  const [values, setValues] = useState<AnswerValues>(() => initialValues(fields));
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  // 一个往返只允许一次提交：翻转靠服务端推回来的快照，不靠这里改状态。
  const busy = pending;

  async function submit() {
    setPending(true);
    setResult(null);
    setResult(await postAnswer(ticketId, values));
    setPending(false);
  }

  const missing = result?.missing ?? [];
  return (
    <div className="dsh-ai-team__form">
      {fields.map((field) => (
        <AnswerField
          key={field.name}
          field={field}
          value={values[field.name]}
          disabled={busy}
          onChange={(next) => setValues((previous) => ({ ...previous, [field.name]: next }))}
          t={t}
        />
      ))}
      {result !== null && !result.ok ? (
        <p className="dsh-ai-team__form-error" role="alert" title={result.detail}>
          {result.message ?? t('questionnaire.failed')}
          {missing.length > 0 ? <>{t('questionnaire.missing', { missing: missing.join('、') })}</> : null}
        </p>
      ) : null}
      {/* 成功不在这里就地改状态：卡片转成「已答复」靠的是那份回推的快照，
          乐观更新会在答复其实被拒时留下一张已经消失的卡片。 */}
      {result !== null && result.ok ? <p className="dsh-ai-team__form-ok">{t('questionnaire.submitted')}</p> : null}
      <div className="dsh-ai-team__form-row">
        <button type="button" disabled={busy || fields.length === 0} onClick={() => void submit()}>
          {pending ? t('questionnaire.submitting') : t('questionnaire.submit')}
        </button>
      </div>
    </div>
  );
}

function EscalationFeed({ escalations, t }: { escalations: EscalationView[]; t: Translator }) {
  if (escalations.length === 0) return <span className="dsh-ai-team__empty">{t('escalations.empty')}</span>;
  const recent = escalations.toReversed().slice(0, 20);
  return (
    <div className="dsh-ai-team__feed dsh-ai-team__feed--with-form">
      {recent.map((escalation) => {
        const notify = escalation.notification;
        const notifyStatus = notify === null ? 'disabled' : notify.status;
        return (
          <div
            key={escalation.id}
            className={
              escalation.resolvedAt === null
                ? 'dsh-ai-team__feed-item'
                : 'dsh-ai-team__feed-item dsh-ai-team__feed-item--resolved'
            }
            title={escalation.suggestion}
          >
            <span className="dsh-ai-team__feed-reason">{t(`reason.${escalation.reason}`)}</span>
            <span>{escalation.message}</span>
            {notify !== null ? (
              <span className="dsh-ai-team__feed-notify">
                <span className={`dsh-ai-team__badge dsh-ai-team__badge--${notifyStatus}`}>
                  {t(`notify.${notifyStatus}`)}
                </span>
                {notify.submittedAt !== null ? (
                  <span className="dsh-ai-team__feed-check">{t('notify.submitted')}</span>
                ) : null}
              </span>
            ) : null}
            {/* 投影里的 ticketUrl 刻意不带凭据，独立端口无 token 一律 404 ——
                所以这里不再放链接，直接把分诊表单内联进来（同源路由作答）。 */}
            {escalation.resolvedAt === null ? (
              <AnswerForm ticketId={escalation.id} fields={escalationFields(t)} t={t} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 「等你决策」区块：待答问卷就地作答。
 *
 * 它和升级流分成两块是 INT-3 场景三的全部内容 —— 一张待答问卷没有任何东西坏掉
 * （异步那张答完还得有人说一声「继续」），而红底告警会把人推向「去查故障」的动作。
 */
function AwaitingList({ items, t }: { items: QuestionnaireView[]; t: Translator }) {
  if (items.length === 0) return <span className="dsh-ai-team__empty">{t('awaiting.empty')}</span>;
  return (
    <div className="dsh-ai-team__awaiting-list">
      {items.toReversed().map((item) => (
        <div key={item.id} className="dsh-ai-team__awaiting">
          <div className="dsh-ai-team__awaiting-head">
            <span className="dsh-ai-team__badge">{t(`questionnaire.kind.${item.kind}`)}</span>
            <span className="dsh-ai-team__card-title">{item.title}</span>
          </div>
          {/* 模式要说得出：interactive 是「这一轮卡住了」，async 是「答完记得回会话里说继续」。 */}
          <p className="dsh-ai-team__awaiting-hint">{t(`questionnaire.mode.${item.mode}`)}</p>
          <AnswerForm ticketId={item.id} fields={fieldsOfQuestions(item.questions)} t={t} />
        </div>
      ))}
    </div>
  );
}

/**
 * 问卷历史（已答 / 已过期 / 已取消，只读）。待答的那些住在上面那个区块里，因为
 * 它们现在能直接作答 —— 混在一起等于把输入框塞进一条滚动流水里。
 *
 * 异步问卷答完之后没人接着跑的那段时间最容易看漏，所以它单独一句话。
 */
function QuestionnaireFeed({ items, t }: { items: QuestionnaireView[]; t: Translator }) {
  const history = items.filter((item) => item.status !== 'open').toReversed().slice(0, 10);
  if (history.length === 0) return <span className="dsh-ai-team__empty">{t('questionnaires.empty')}</span>;
  return (
    <div className="dsh-ai-team__feed">
      {history.map((item) => {
        const badge = item.status === 'answered' ? 'pass' : 'fail';
        const label =
          item.status === 'answered' && item.mode === 'async'
            ? t('questionnaire.awaitingLeader')
            : t(`questionnaire.${item.status}`);
        const answers = item.questions
          .map((question) => `${question.label} = ${item.answers[question.name]?.value ?? '-'}`)
          .join('\n');
        return (
          <div key={item.id} className="dsh-ai-team__feed-item dsh-ai-team__feed-item--resolved" title={answers}>
            <span className="dsh-ai-team__feed-reason">{t(`questionnaire.kind.${item.kind}`)}</span>
            <span>{item.title}</span>
            <span className={`dsh-ai-team__badge dsh-ai-team__badge--${badge}`}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 任务是否正等一个人回答。绑定时既可能写任务 id 也可能写契约 id，两种都认。 */
function openQuestionnaireFor(
  items: QuestionnaireView[],
  task: TaskView,
): QuestionnaireView | undefined {
  return items.find(
    (item) => item.status === 'open' && (item.taskId === task.id || (item.taskId !== null && item.taskId === task.contractId)),
  );
}

function DeployHistory({ deploys, t }: { deploys: DeployView[]; t: Translator }) {
  if (deploys.length === 0) return <span className="dsh-ai-team__empty">{t('deploys.empty')}</span>;
  const recent = deploys.toReversed().slice(0, 10);
  return (
    <div>
      {recent.map((deploy) => (
        <div key={deploy.id} className="dsh-ai-team__deploy" title={deploy.logTail}>
          <span
            className={`dsh-ai-team__badge ${
              deploy.status === 'healthy'
                ? 'dsh-ai-team__badge--pass'
                : deploy.status === 'running'
                  ? 'dsh-ai-team__badge--pending'
                  : 'dsh-ai-team__badge--fail'
            }`}
          >
            {t(`deploy.${deploy.status}`)}
          </span>
          <span>{deploy.branch}</span>
          <span>{new Date(deploy.startedAt).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

function LearningList({ learnings, t }: { learnings: LearningView[]; t: Translator }) {
  if (learnings.length === 0) return <span className="dsh-ai-team__empty">{t('learnings.empty')}</span>;
  // 命中次数优先：被反复印证的坑才是值得先看的。
  const ranked = learnings.toSorted((a, b) => b.hits - a.hits || b.lastHitAt - a.lastHitAt).slice(0, 10);
  return (
    <div>
      {ranked.map((learning) => (
        <div key={learning.id} className="dsh-ai-team__deploy" title={learning.summary}>
          <span
            className={`dsh-ai-team__badge ${learning.promoted ? 'dsh-ai-team__badge--pass' : 'dsh-ai-team__badge--pending'}`}
          >
            {learning.bucket}
          </span>
          <span>{learning.summary}</span>
          <span>{t('learnings.hits', { hits: learning.hits })}</span>
          {learning.promoted ? <span>{t('learnings.promoted')}</span> : null}
        </div>
      ))}
    </div>
  );
}

/**
 * 当前卡住的任务（等人工分诊 / 等组长澄清 / 卡死 / 门红）。
 *
 * `projection.blocked` 一直有值，却从没被渲染过：面板只在升级流里显示"已升级"，
 * 于是最常见的两种卡（依赖别人、阶段不派发）在界面上完全不可见。
 * 这里存的是任务 id 或 contractId，两个键都试一次；都对不上就原样显示 ——
 * 一条对不上号的记录也是信号，不该因为查不到标题就把它吞掉。
 */
function BlockedList({ ids, team, t }: { ids: string[]; team: TeamView; t: Translator }) {
  if (ids.length === 0) return <span className="dsh-ai-team__empty">{t('blocked.empty')}</span>;
  return (
    <div className="dsh-ai-team__members">
      {ids.map((id) => {
        const task = team.tasks.find((candidate) => candidate.id === id || candidate.contractId === id);
        return (
          <span key={id} className="dsh-ai-team__member" title={task?.description ?? id}>
            <span>{task?.title ?? id}</span>
            {task !== undefined ? <span className="dsh-ai-team__role">{t(`status.${task.status}`)}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

/**
 * 「待办中心」：把四类需要人的行动项（待答问卷 / 未解决升级 / 卡住任务 /
 * needs-human 任务）聚合到一个入口。问卷与升级内联作答，卡住与待人工只读。
 * 与头部琥珀计数共用同一套口径，避免「头部说 3 件、点开只有 1 件」的错位。
 */
function ActionCenter({
  questionnaires,
  escalations,
  blocked,
  team,
  t,
}: {
  questionnaires: QuestionnaireView[];
  escalations: EscalationView[];
  blocked: string[];
  team: TeamView;
  t: Translator;
}) {
  const openQ = questionnaires.filter((item) => item.status === 'open');
  const openEsc = escalations.filter((item) => item.resolvedAt === null);
  const needsHuman = team.tasks.filter((task) => task.status === 'needs-human');
  const sections: { key: string; title: string; count: number; node: ReactNode }[] = [];
  if (openQ.length > 0) {
    sections.push({ key: 'q', title: t('actions.questionnaires'), count: openQ.length, node: <AwaitingList items={openQ} t={t} /> });
  }
  if (openEsc.length > 0) {
    sections.push({ key: 'esc', title: t('actions.escalations'), count: openEsc.length, node: <EscalationFeed escalations={openEsc} t={t} /> });
  }
  if (blocked.length > 0) {
    sections.push({ key: 'blocked', title: t('actions.blocked'), count: blocked.length, node: <BlockedList ids={blocked} team={team} t={t} /> });
  }
  if (needsHuman.length > 0) {
    sections.push({
      key: 'human',
      title: t('actions.needsHuman'),
      count: needsHuman.length,
      node: (
        <div className="dsh-ai-team__members">
          {needsHuman.map((task) => (
            <span key={task.id} className="dsh-ai-team__member" title={task.description}>
              <span>{task.title}</span>
              <span className="dsh-ai-team__role">{t(`status.${task.status}`)}</span>
            </span>
          ))}
        </div>
      ),
    });
  }
  if (sections.length === 0) return <span className="dsh-ai-team__empty">{t('actions.empty')}</span>;
  return (
    <div className="dsh-ai-team__actions">
      {sections.map((section) => (
        <section key={section.key} className="dsh-ai-team__actions-section">
          <h5 className="dsh-ai-team__actions-title">
            <span>{section.title}</span>
            <span className="dsh-ai-team__badge dsh-ai-team__badge--awaiting">{section.count}</span>
          </h5>
          {section.node}
        </section>
      ))}
    </div>
  );
}

/**
 * Grafana 风格统计卡：短标签 + 数字。作为按钮，点击时在父组件打开对应详情浮窗。
 */
function StatTile({ label, value, hint, onClick }: { label: string; value: string; hint?: string; onClick: () => void }) {
  return (
    <button type="button" className="dsh-ai-team__stat" title={hint} onClick={onClick}>
      <span className="dsh-ai-team__stat-value">{value}</span>
      <span className="dsh-ai-team__stat-label">{label}</span>
    </button>
  );
}

type DetailKind = 'actions' | 'metrics' | 'blocked' | 'questionnaires' | 'learnings' | 'escalations' | 'deploys';

/**
 * 状态栏：一排统计卡按钮。点击某张卡，弹出浮窗展示该类的详细面板（卡住/问卷/教训/升级/部署）。
 * 数据全部来自已有的 projection，不改 schema / stateVersion。
 */
function StatsStrip({
  team,
  blocked,
  questionnaires,
  escalations,
  deploys,
  t,
}: {
  team: TeamView;
  blocked: string[];
  questionnaires: QuestionnaireView[];
  escalations: EscalationView[];
  deploys: DeployView[];
  t: Translator;
}) {
  const [open, setOpen] = useState<DetailKind | null>(null);
  const metrics = team.metrics;
  const openEsc = escalations.filter((escalation) => escalation.resolvedAt === null).length;
  const openQ = questionnaires.filter((item) => item.status === 'open').length;
  const needsHuman = team.tasks.filter((task) => task.status === 'needs-human').length;
  // 头部琥珀计数与这里共用同一份口径：问卷 + 升级 + 卡住 + 待人工。
  const actionCount = openQ + openEsc + blocked.length + needsHuman;

  const content = (() => {
    switch (open) {
      case 'actions': return <ActionCenter questionnaires={questionnaires} escalations={escalations} blocked={blocked} team={team} t={t} />;
      case 'blocked': return <BlockedList ids={blocked} team={team} t={t} />;
      case 'questionnaires': return <QuestionnaireFeed items={questionnaires} t={t} />;
      case 'learnings': return <LearningList learnings={team.learnings} t={t} />;
      case 'escalations': return <EscalationFeed escalations={escalations} t={t} />;
      case 'deploys': return <DeployHistory deploys={deploys} t={t} />;
      case 'metrics': return (
        <div className="dsh-ai-team__card-meta">
          <span>{t('metrics.dispatched', { dispatched: metrics.dispatched, completed: metrics.completed })}</span>
          <span>{t('metrics.reviewRounds', { reviewRounds: metrics.reviewRounds })}</span>
          <span>{t('metrics.gates', { gateRuns: metrics.gateRuns, gateFailures: metrics.gateFailures })}</span>
          <span>{t('metrics.deploys', { deploys: metrics.deploys, rollbacks: metrics.rollbacks })}</span>
        </div>
      );
      default: return null;
    }
  })();

  return (
    <>
      <div className="dsh-ai-team__stats">
        <StatTile label={t('actions.title')} value={String(actionCount)} hint={t('actions.hint')} onClick={() => setOpen('actions')} />
        <StatTile label={t('section.metrics')} value={`${metrics.completed}/${metrics.dispatched}`} hint={t('section.metrics.hint')} onClick={() => setOpen('metrics')} />
        <StatTile label={t('section.blocked')} value={String(blocked.length)} hint={t('section.blocked.hint')} onClick={() => setOpen('blocked')} />
        <StatTile label={t('section.questionnaires')} value={`${openQ}/${questionnaires.length}`} hint={t('section.questionnaires.hint')} onClick={() => setOpen('questionnaires')} />
        <StatTile label={t('section.learnings')} value={String(team.learnings.length)} hint={t('section.learnings.hint')} onClick={() => setOpen('learnings')} />
        <StatTile label={t('section.escalations')} value={String(openEsc)} hint={t('section.escalations.hint')} onClick={() => setOpen('escalations')} />
        <StatTile label={t('section.deploys')} value={String(deploys.length)} hint={t('section.deploys.hint')} onClick={() => setOpen('deploys')} />
      </div>
      {open !== null ? (
        <div className="dsh-ai-team__overlay" onClick={() => setOpen(null)}>
          <div className="dsh-ai-team__overlay-panel" onClick={(event) => event.stopPropagation()}>
            <header className="dsh-ai-team__overlay-head">
              <span>{t(`section.${open}`)}</span>
              <button type="button" className="dsh-ai-team__overlay-close" onClick={() => setOpen(null)}>✕</button>
            </header>
            <div className="dsh-ai-team__overlay-body">{content}</div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** 「等你决策」可最小化浮窗：默认收起成右下角小胶囊，点开浮窗作答。 */
function WaitingDecisions({ items, t }: { items: QuestionnaireView[]; t: Translator }) {
  const [min, setMin] = useState(true);
  if (items.length === 0) return null;
  return (
    <div className="dsh-ai-team__floating">
      <button type="button" className="dsh-ai-team__floating-head" onClick={() => setMin((value) => !value)}>
        <span>{t('section.awaiting')}</span>
        <span className="dsh-ai-team__badge dsh-ai-team__badge--awaiting">{t('awaiting.count', { count: items.length })}</span>
        <span>{min ? '▲' : '▼'}</span>
      </button>
      {!min ? (
        <div className="dsh-ai-team__floating-body">
          <AwaitingList items={items} t={t} />
        </div>
      ) : null}
    </div>
  );
}

/** 任务状态 → 徽标颜色：已完成/废弃绿、活跃/待办琥珀、异常红。 */
function taskBadgeKind(status: TaskView['status']): string {
  if (status === 'done' || status === 'cancelled') return 'pass';
  if (status === 'in_progress' || status === 'in_review' || status === 'pending') return 'pending';
  return 'fail';
}

/**
 * 周期区（CYC-5 / docs/design-cycles.md §2.1）：多周期团队一眼看到周期列表
 * （name / status / 进度）、当前活跃周期高亮、每周期内的任务分组。`cycle.taskIds`
 * 存的是契约 id，所以按 `task.contractId` 匹配团队任务。无周期记录的旧团队不渲染
 * 这一节 —— 看板仍走下面的扁平视图，不回归。
 */
function CycleSection({ team, t }: { team: TeamView; t: Translator }) {
  const cycles: readonly CycleView[] = team.cycles ?? [];
  if (cycles.length === 0) return null;
  return (
    <section>
      <h4 className="dsh-ai-team__section-title">{t('section.cycles')}</h4>
      <div className="dsh-ai-team__cycles">
        {cycles.map((cycle) => {
          const cycleTasks = team.tasks.filter(
            (task) => task.contractId !== null && cycle.taskIds.includes(task.contractId),
          );
          const finished = cycleTasks.filter(
            (task) => task.status === 'done' || task.status === 'cancelled',
          ).length;
          return (
            <div
              key={cycle.id}
              className={
                cycle.status === 'in_progress'
                  ? 'dsh-ai-team__cycle dsh-ai-team__cycle--active'
                  : 'dsh-ai-team__cycle'
              }
            >
              <div className="dsh-ai-team__cycle-head">
                <span className="dsh-ai-team__cycle-name">{cycle.name}</span>
                <span className="dsh-ai-team__badge">{t(`cycleStatus.${cycle.status}`)}</span>
                {cycle.status === 'in_progress' ? (
                  <span className="dsh-ai-team__badge dsh-ai-team__badge--awaiting">{t('cycles.active')}</span>
                ) : null}
                <span className="dsh-ai-team__cycle-progress">
                  {t('cycles.progress', { done: finished, total: cycle.taskIds.length })}
                </span>
              </div>
              {cycle.goal !== '' ? <p className="dsh-ai-team__cycle-goal">{cycle.goal}</p> : null}
              {cycleTasks.length > 0 ? (
                <div className="dsh-ai-team__cycle-tasks">
                  {cycleTasks.map((task) => (
                    <span
                      key={task.id}
                      className={`dsh-ai-team__badge dsh-ai-team__badge--${taskBadgeKind(task.status)}`}
                    >
                      {task.title}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TeamBody({ team, questionnaires, t }: { team: TeamView; questionnaires: QuestionnaireView[]; t: Translator }) {
  // 容器瀑布流：保留按状态分组（开发中 / 待处理 / 已完成 …），每组是一个容器，
  // 容器自身以紧凑瀑布流排布（见 styles .dsh-ai-team__kanban：多列、高度自适应、
  // 无每列内部滚动），让有内容的容器撑开、空容器不占大片空白。
  const openStandalone = questionnaires.filter(
    (item) => item.status === 'open' && item.taskId === null,
  );
  return (
    <>
      <section>
        <h4 className="dsh-ai-team__section-title">{t('section.members')}</h4>
        <div className="dsh-ai-team__members">
          {team.members.map((member) => (
            <MemberChip key={member.id} member={member} t={t} />
          ))}
        </div>
      </section>
      <CycleSection team={team} t={t} />
      <section>
        <h4 className="dsh-ai-team__section-title">{t('section.tasks')}</h4>
        <div className="dsh-ai-team__kanban">
          {TASK_STATUSES.map((status) => {
            const tasks = team.tasks.filter((task) => task.status === status);
            return (
              <div key={status} className="dsh-ai-team__column">
                <h5 className="dsh-ai-team__column-title">
                  <span>{t(`status.${status}`)}</span>
                  <span>{tasks.length}</span>
                </h5>
                {tasks.map((task) => (
                  <TaskCard key={task.id} task={task} awaiting={openQuestionnaireFor(questionnaires, task)} t={t} />
                ))}
              </div>
            );
          })}
          {/* 等你决策：开放式问卷（含未绑定任务的「无人值守决策」）也作为一个容器并入瀑布流。
              已绑定任务的问卷会在其任务卡上显示「等人回答」徽标，这里只补无绑定的那些。 */}
          <div className="dsh-ai-team__column dsh-ai-team__column--awaiting">
            <h5 className="dsh-ai-team__column-title">
              <span>{t('section.awaiting')}</span>
              <span>{openStandalone.length}</span>
            </h5>
            {openStandalone.map((item) => (
              <div key={item.id} className="dsh-ai-team__card" title={item.title}>
                <span className="dsh-ai-team__card-title">{item.title}</span>
                <span className="dsh-ai-team__card-meta">
                  <span className="dsh-ai-team__badge dsh-ai-team__badge--awaiting">
                    {t('questionnaire.onTask')}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

/**
 * 面板本体。在团队存在之前不渲染任何内容，
 * 以便普通会话保持清爽。
 */
export function AutopilotPanel({ useProjection, t }: SlotProps) {
  const [open, setOpen] = useState(true);
  const projection = useProjection('autopilot') as AutopilotProjection | undefined;
  const teams = projection?.teams ?? [];
  if (projection === undefined || teams.length === 0) return null;
  const team = teams.find((candidate) => candidate.id === projection.activeTeamId) ?? teams[0];
  if (team === undefined) return null;
  const busy = team.members.filter((member) => member.status !== 'idle').length;
  // 头部「进行中」必须与看板「进行中」列一致，而不是统计未完成数（后者含待办，
  // 会与实际在写的任务对不上）。in_progress 才是真正在跑的任务。
  const inProgress = team.tasks.filter((task) => task.status === 'in_progress').length;
  const dispatchable = DISPATCHABLE_PHASES.includes(team.phase);
  const questionnaires = projection.questionnaires.filter((item) => item.teamId === team.id);
  // 单团队视图只看当前团队的升级与部署（TECH-4）；teamId 为 null 的旧记录
  // 归属不明，宁可多显示，不能被过滤吞掉。
  const belongsToTeam = (item: { teamId: string | null }) => item.teamId === null || item.teamId === team.id;
  const escalations = projection.escalations.filter(belongsToTeam);
  const deploys = projection.deploys.filter(belongsToTeam);
  // 头部琥珀计数 = 待答问卷 + 未解决升级 + 卡住 + needs-human（与待办中心同口径）。
  const openQ = questionnaires.filter((item) => item.status === 'open').length;
  const openEsc = escalations.filter((escalation) => escalation.resolvedAt === null).length;
  const needsHuman = team.tasks.filter((task) => task.status === 'needs-human').length;
  const actionCount = openQ + openEsc + projection.blocked.length + needsHuman;
  return (
    <div className={open ? 'dsh-ai-team dsh-ai-team--open' : 'dsh-ai-team'}>
      <button
        type="button"
        className="dsh-ai-team__header"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <LoopLamp state={projection.loopState} t={t} />
        {/* 不派发阶段用「等待」色：人对着一个不动的看板猜原因，是无人值守最贵的浪费。 */}
        <span
          className={dispatchable ? 'dsh-ai-team__role' : 'dsh-ai-team__badge dsh-ai-team__badge--pending'}
          title={dispatchable ? undefined : t('phase.notDispatching')}
        >
          {t(`phase.${team.phase}`)}
        </span>
        {/* 折叠时只剩这一行，所以「轮到你」必须在收起状态也看得见。 */}
        {actionCount > 0 ? (
          <span className="dsh-ai-team__badge dsh-ai-team__badge--awaiting" title={t('actions.hint')}>
            {t('actions.count', { count: actionCount })}
          </span>
        ) : null}
        <span className="dsh-ai-team__title">{t('panel.title', { team: team.name })}</span>
        <span className="dsh-ai-team__summary">
          {t('panel.summary', {
            members: team.members.length,
            busy,
            tasks: inProgress,
            escalations: escalations.filter((escalation) => escalation.resolvedAt === null).length,
          })}
        </span>
        <span className="dsh-ai-team__chevron">›</span>
      </button>
      <EscalationAlerts escalations={escalations} t={t} />
      <WaitingDecisions items={questionnaires.filter((item) => item.status === 'open')} t={t} />
      {open ? (
        <div className="dsh-ai-team__body">
          <StatsStrip
            team={team}
            blocked={projection.blocked}
            questionnaires={questionnaires}
            escalations={escalations}
            deploys={deploys}
            t={t}
          />
          <TeamBody team={team} questionnaires={questionnaires} t={t} />
        </div>
      ) : null}
    </div>
  );
}
