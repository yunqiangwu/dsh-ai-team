/**
 * 团队协作面板 (team-collaboration panel): renders the `aiTeam` projection —
 * member roster with workspace status, shared-repository branches, and the
 * task kanban — into the conversation input dock. The projection seat is
 * reactive: every `ai-team/update` session event re-renders the panel live.
 */
import { useState } from 'react'
import type {
  AiTeamProjection,
  MemberView,
  TaskStatus,
  TaskView,
  TeamView,
} from '../view.js'
import { TASK_STATUSES } from '../view.js'
import type { SlotProps, Translator } from './contract.js'

function MemberChip({ member, t }: { member: MemberView; t: Translator }) {
  return (
    <span
      className="dsh-ai-team__member"
      title={`${member.workspacePath}\n${member.branch}`}
    >
      <span className={`dsh-ai-team__dot dsh-ai-team__dot--${member.status}`} />
      <span>{member.name}</span>
      <span className={`dsh-ai-team__role dsh-ai-team__role--${member.role}`}>
        {t(`role.${member.role}`)}
      </span>
    </span>
  )
}

function TaskCard({ task, t }: { task: TaskView; t: Translator }) {
  return (
    <div className="dsh-ai-team__card" title={task.description}>
      <span className="dsh-ai-team__card-title">{task.title}</span>
      <span className="dsh-ai-team__card-meta">
        <span>{task.assigneeName}</span>
        {task.reviewRound > 0 ? (
          <span className="dsh-ai-team__round">
            {t('task.round', { round: task.reviewRound })}
          </span>
        ) : null}
      </span>
      <span className="dsh-ai-team__card-meta">
        <span className="dsh-ai-team__card-branch">{task.branch}</span>
      </span>
    </div>
  )
}

function TeamBody({ team, t }: { team: TeamView; t: Translator }) {
  return (
    <div className="dsh-ai-team__body">
      <section>
        <h4 className="dsh-ai-team__section-title">{t('section.members')}</h4>
        <div className="dsh-ai-team__members">
          {team.members.map((member) => (
            <MemberChip key={member.id} member={member} t={t} />
          ))}
        </div>
      </section>
      <section>
        <h4 className="dsh-ai-team__section-title">{t('section.branches')}</h4>
        <div className="dsh-ai-team__branches">
          {team.branches.map((branch) => (
            <span
              key={branch}
              className={
                branch === team.baseBranch
                  ? 'dsh-ai-team__branch dsh-ai-team__branch--base'
                  : 'dsh-ai-team__branch'
              }
            >
              {branch}
            </span>
          ))}
        </div>
      </section>
      <section>
        <h4 className="dsh-ai-team__section-title">{t('section.tasks')}</h4>
        <div className="dsh-ai-team__kanban">
          {TASK_STATUSES.map((status: TaskStatus) => {
            const tasks = team.tasks.filter((task) => task.status === status)
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
            )
          })}
        </div>
      </section>
    </div>
  )
}

/**
 * The panel itself. Renders nothing until a team exists, so an ordinary
 * conversation stays clean (same contract as the official todo dock).
 */
export function TeamPanel({ useProjection, t }: SlotProps) {
  const [open, setOpen] = useState(true)
  const projection = useProjection<AiTeamProjection | null>('aiTeam')
  const teams = projection?.teams ?? []
  if (teams.length === 0) return null

  const team =
    teams.find((candidate) => candidate.id === projection?.activeTeamId) ?? teams[0]!
  const busy = team.members.filter((member) => member.status !== 'idle').length
  const openTasks = team.tasks.filter((task) => task.status !== 'done').length

  return (
    <div className={open ? 'dsh-ai-team dsh-ai-team--open' : 'dsh-ai-team'}>
      <button
        type="button"
        className="dsh-ai-team__header"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="dsh-ai-team__title">{t('panel.title', { team: team.name })}</span>
        <span className="dsh-ai-team__summary">
          {t('panel.summary', {
            members: team.members.length,
            busy,
            branches: team.branches.length,
            tasks: openTasks,
          })}
        </span>
        <span className="dsh-ai-team__chevron">›</span>
      </button>
      {open ? <TeamBody team={team} t={t} /> : null}
    </div>
  )
}
