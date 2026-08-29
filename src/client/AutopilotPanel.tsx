/**
 * Autopilot 面板：把 `autopilot` projection 渲染到会话输入框下方的 dock 中，
 * 内容包括循环状态指示灯、成员名单、带质量门徽章的任务看板、升级事件流
 * 和部署历史。projection 席位是响应式的：每次 `autopilot/update` 会话事件
 * 都会实时重绘面板。
 */
import { useState } from 'react';
import type { SlotProps, Translator } from './contract.js';
import type { AutopilotProjection, DeployView, EscalationView, MemberView, TaskView, TeamView } from '../view.js';
import { TASK_STATUSES } from '../view.js';

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

function TaskCard({ task, t }: { task: TaskView; t: Translator }) {
  return (
    <div className="dsh-ai-team__card" title={task.description}>
      <span className="dsh-ai-team__card-title">{task.title}</span>
      <span className="dsh-ai-team__card-meta">
        <span>{task.assigneeName}</span>
        <GateBadge task={task} t={t} />
        <CiBadge task={task} t={t} />
        {task.reviewRound > 0 ? <span>{t('task.round', { round: task.reviewRound })}</span> : null}
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

function TeamBody({ team, t }: { team: TeamView; t: Translator }) {
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
                  <TaskCard key={task.id} task={task} t={t} />
                ))}
              </div>
            );
          })}
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
  const openTasks = team.tasks.filter((task) => task.status !== 'done').length;
  return (
    <div className={open ? 'dsh-ai-team dsh-ai-team--open' : 'dsh-ai-team'}>
      <button
        type="button"
        className="dsh-ai-team__header"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <LoopLamp state={projection.loopState} t={t} />
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
          <TeamBody team={team} t={t} />
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
