/**
 * Autopilot 面板：把 `autopilot` projection 渲染到会话输入框下方的 dock 中，
 * 内容包括循环状态指示灯、成员名单、带质量门徽章的任务看板、升级事件流
 * 和部署历史。projection 席位是响应式的：每次 `autopilot/update` 会话事件
 * 都会实时重绘面板。
 */
import { useState } from 'react';
import type { SlotProps, Translator } from './contract.js';
import type { AutopilotProjection, DeployView, EscalationView, LearningView, MemberView, QuestionnaireView, TaskView, TeamView } from '../view.js';
import { DISPATCHABLE_PHASES, TASK_STATUSES } from '../view.js';

function LoopLamp({ state, t }: { state: AutopilotProjection['loopState']; t: Translator }) {
  return (
    <span className={`dsh-ai-team__lamp dsh-ai-team__lamp--${state}`}>
      <span className="dsh-ai-team__lamp-dot" />
      <span>{t(`loop.${state}`)}</span>
    </span>
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
      title={task.gates.results.map((result) => `${result.passed ? '✓' : '✗'} ${result.command}`).join('\n')}
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
  return (
    <div className="dsh-ai-team__card" title={task.description}>
      <span className="dsh-ai-team__card-title">{task.title}</span>
      <span className="dsh-ai-team__card-meta">
        <span>{task.assigneeName}</span>
        <GateBadge task={task} t={t} />
        <CiBadge task={task} t={t} />
        {task.reviewRound > 0 ? <span>{t('task.round', { round: task.reviewRound })}</span> : null}
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
    </div>
  );
}

function EscalationFeed({ escalations, t }: { escalations: EscalationView[]; t: Translator }) {
  if (escalations.length === 0) return <span className="dsh-ai-team__empty">{t('escalations.empty')}</span>;
  const recent = escalations.toReversed().slice(0, 20);
  return (
    <div className="dsh-ai-team__feed">
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
                {notify.ticketUrl !== null ? (
                  <a href={notify.ticketUrl} target="_blank" rel="noreferrer">
                    {t('notify.ticket')}
                  </a>
                ) : null}
                {notify.submittedAt !== null ? (
                  <span className="dsh-ai-team__feed-check">{t('notify.submitted')}</span>
                ) : null}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 问卷流水（只读）。M1 的作答入口是浏览器里的工单页，不是这张面板 ——
 * 面板只负责让人一眼看出「现在轮到谁了」，尤其要区分异步问卷答完之后
 * 那段时间：那时球在组长脚下，而插件唤不醒它。
 */
function QuestionnaireFeed({ items, t }: { items: QuestionnaireView[]; t: Translator }) {
  if (items.length === 0) return <span className="dsh-ai-team__empty">{t('questionnaires.empty')}</span>;
  const recent = items.toReversed().slice(0, 10);
  return (
    <div className="dsh-ai-team__feed">
      {recent.map((item) => {
        const waiting = item.status === 'open';
        const badge = waiting ? 'pending' : item.status === 'answered' ? 'pass' : 'fail';
        // 异步问卷答完之后没人接着跑，是最容易看漏的一段：单独给一句话。
        const label =
          item.status === 'answered' && item.mode === 'async'
            ? t('questionnaire.awaitingLeader')
            : t(`questionnaire.${item.status}`);
        return (
          <div
            key={item.id}
            className={waiting ? 'dsh-ai-team__feed-item' : 'dsh-ai-team__feed-item dsh-ai-team__feed-item--resolved'}
            title={`${item.questions.map((question) => question.label).join('\n')}\n${t(`questionnaire.mode.${item.mode}`)}`}
          >
            <span className="dsh-ai-team__feed-reason">{t(`questionnaire.kind.${item.kind}`)}</span>
            <span>{item.title}</span>
            <span className={`dsh-ai-team__badge dsh-ai-team__badge--${badge}`}>{label}</span>
            {item.ticketUrl !== null ? (
              <a href={item.ticketUrl} target="_blank" rel="noreferrer">
                {t('notify.ticket')}
              </a>
            ) : null}
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

/** 团队累计运行指标：一行计数 + 非零升级原因直方图（无人值守试点的观测面）。 */
function MetricsList({ team, t }: { team: TeamView; t: Translator }) {
  const metrics = team.metrics;
  const reasons = Object.entries(metrics.escalations)
    .filter(([, count]) => count > 0)
    .toSorted(([, a], [, b]) => b - a);
  return (
    <div className="dsh-ai-team__metrics">
      <div className="dsh-ai-team__card-meta">
        <span>{t('metrics.dispatched', { dispatched: metrics.dispatched, completed: metrics.completed })}</span>
        <span>{t('metrics.reviewRounds', { reviewRounds: metrics.reviewRounds })}</span>
        <span>{t('metrics.gates', { gateRuns: metrics.gateRuns, gateFailures: metrics.gateFailures })}</span>
        <span>{t('metrics.deploys', { deploys: metrics.deploys, rollbacks: metrics.rollbacks })}</span>
      </div>
      {reasons.length > 0 ? (
        <div className="dsh-ai-team__card-meta">
          {reasons.map(([reason, count]) => (
            <span key={reason}>
              {t(`reason.${reason}`)} ×{count}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TeamBody({ team, blocked, questionnaires, t }: { team: TeamView; blocked: string[]; questionnaires: QuestionnaireView[]; t: Translator }) {
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
        </div>
      </section>
      <section>
        <h4 className="dsh-ai-team__section-title">{t('section.questionnaires')}</h4>
        <QuestionnaireFeed items={questionnaires} t={t} />
      </section>
      <section>
        <h4 className="dsh-ai-team__section-title">{t('section.blocked')}</h4>
        <BlockedList ids={blocked} team={team} t={t} />
      </section>
      <section>
        <h4 className="dsh-ai-team__section-title">{t('section.learnings')}</h4>
        <LearningList learnings={team.learnings} t={t} />
      </section>
      <section>
        <h4 className="dsh-ai-team__section-title">{t('section.metrics')}</h4>
        <MetricsList team={team} t={t} />
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
  const openTasks = team.tasks.filter((task) => task.status !== 'done').length;
  const dispatchable = DISPATCHABLE_PHASES.includes(team.phase);
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
        <span className="dsh-ai-team__title">{t('panel.title', { team: team.name })}</span>
        <span className="dsh-ai-team__summary">
          {t('panel.summary', {
            members: team.members.length,
            busy,
            tasks: openTasks,
            escalations: projection.escalations.filter((escalation) => escalation.resolvedAt === null).length,
          })}
        </span>
        <span className="dsh-ai-team__chevron">›</span>
      </button>
      {open ? (
        <div className="dsh-ai-team__body">
          <TeamBody
            team={team}
            blocked={projection.blocked}
            questionnaires={projection.questionnaires.filter((item) => item.teamId === team.id)}
            t={t}
          />
          <section>
            <h4 className="dsh-ai-team__section-title">{t('section.escalations')}</h4>
            <EscalationFeed escalations={projection.escalations} t={t} />
          </section>
          <section>
            <h4 className="dsh-ai-team__section-title">{t('section.deploys')}</h4>
            <DeployHistory deploys={projection.deploys} t={t} />
          </section>
        </div>
      ) : null}
    </div>
  );
}
