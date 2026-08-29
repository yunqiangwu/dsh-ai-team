/**
 * 守护循环的纯判定层：tick 家族里「阈值比较」的部分，从 AutopilotService 搬出
 * 来单独单测（tests/test-service-modules.ts）。升级副作用（report 收集、
 * escalateTask、通知）仍留在 service.ts —— 与 `service/contracts.ts`「纯函数
 * 不碰盘、出口策略归调用方」是同一条分工约定。
 */
import type { TaskRecord } from './state.js';

/** 返工轮次打满：changes_requested 且轮次达到上限。 */
export function reviewRoundsExceeded(task: TaskRecord, maxReviewRounds: number): boolean {
  return task.status === 'changes_requested' && task.reviewRound >= maxReviewRounds;
}

/** 空闲卡死：lastActivityAt 距今超过 stuckMinutes（问卷豁免的判定在调用方）。 */
export function taskStuck(task: TaskRecord, stuckMinutes: number, now: number): boolean {
  return now - task.lastActivityAt > stuckMinutes * 60_000;
}

/**
 * 活跃空转：派发后超过墙钟预算（小时，0 = 关闭）仍未完成。
 * 与 taskStuck 互补 —— 那里发现「空闲」，这里挡「活跃空转」。
 */
export function budgetExceeded(task: TaskRecord, maxTaskHours: number, now: number): boolean {
  if (!(maxTaskHours > 0) || task.status !== 'in_progress') return false;
  return task.dispatchedAt !== undefined && now - task.dispatchedAt > maxTaskHours * 3_600_000;
}
