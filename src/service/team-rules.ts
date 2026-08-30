/**
 * 团队 / 派发域的业务不变量（Phase 4 收窄落点）。
 *
 * 这些是「创建团队 / 加成员 / 派任务」的纯校验规则，从 AutopilotService 的方法体里
 * 下沉出来以便直接单测；跨子系统的编排（git 克隆 / worktree、契约装载、看板落盘、
 * 状态变更钩子）仍留在 service —— 它们不是自包含域，硬迁会引入构造依赖爆炸。
 */
export type AnyMember = { role: string };
export type AnyTask = { id: string };

/** 一个团队必须且只能有一位 leader（createTeam 的核心不变量）。 */
export function exactlyOneLeader(members: readonly AnyMember[]): boolean {
  return members.filter((member) => member.role === 'leader').length === 1;
}

/** 团队已有 leader：不允许再往里加第二位（addMember 复用）。 */
export function hasLeader(members: readonly AnyMember[]): boolean {
  return members.some((member) => member.role === 'leader');
}

/** 成员数量已达上限（addMember 的 maxMembers 门）。 */
export function atMemberLimit(members: readonly unknown[], max: number): boolean {
  return members.length >= max;
}

/** 任务数量已达上限（assignTask 的 maxTasks 门）。 */
export function atTaskLimit(tasks: readonly unknown[], max: number): boolean {
  return tasks.length >= max;
}

/** 该角色是否允许承担写代码的任务（reviewer / operator 不能）。 */
export function canWriteCode(role: string): boolean {
  return role !== 'reviewer' && role !== 'operator';
}