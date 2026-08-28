/**
 * Browser half of dsh-ai-team: registers the zh/en dictionaries, injects the
 * panel stylesheet, and mounts the team-collaboration panel into the
 * conversation input dock (the same slot todo / plan / goal use). Served to
 * the browser as /plugins/dsh-ai-team/client.js once the plugin entry is
 * enabled in the profile's cordis patch tree.
 */
import type { ClientContext } from './contract.js'
import { ensurePanelStyles } from './styles.js'
import { TeamPanel } from './TeamPanel.js'

/** Required services: sessions (projection seat), slots, locale. */
export const inject = ['sessions', 'slots', 'locale']

const zh = {
  'panel.title': '团队：{team}',
  'panel.summary': '{members} 名成员（{busy} 忙碌） · {branches} 个分支 · {tasks} 个进行中任务',
  'section.members': '成员与工作空间',
  'section.branches': '分支',
  'section.tasks': '任务看板',
  'role.leader': '组长',
  'role.developer': '开发',
  'role.reviewer': '审查',
  'status.pending': '待办',
  'status.in_progress': '进行中',
  'status.in_review': '审查中',
  'status.changes_requested': '待修改',
  'status.done': '已完成',
  'task.round': '第 {round} 轮返工',
}

const en = {
  'panel.title': 'Team: {team}',
  'panel.summary': '{members} members ({busy} busy) · {branches} branches · {tasks} open tasks',
  'section.members': 'Members & workspaces',
  'section.branches': 'Branches',
  'section.tasks': 'Task board',
  'role.leader': 'leader',
  'role.developer': 'dev',
  'role.reviewer': 'reviewer',
  'status.pending': 'Pending',
  'status.in_progress': 'In progress',
  'status.in_review': 'In review',
  'status.changes_requested': 'Changes requested',
  'status.done': 'Done',
  'task.round': 'round {round}',
}

/** Client plugin body. */
export function apply(ctx: ClientContext): void {
  ensurePanelStyles()
  ctx.effect(() => ctx.locale.register('aiTeam', { zh, en }), 'ai-team: dictionaries')
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'ai-team',
        order: 40,
        locale: 'aiTeam',
      },
      TeamPanel,
    ),
  )
}
