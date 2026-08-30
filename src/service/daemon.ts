/**
 * 守护循环的纯判定层：tick 家族里「阈值比较」的部分，从 AutopilotService 搬出
 * 来单独单测（tests/test-service-modules.ts）。升级副作用（report 收集、
 * escalateTask、通知）仍留在 service.ts —— 与 `service/contracts.ts`「纯函数
 * 不碰盘、出口策略归调用方」是同一条分工约定。
 */
import type { CycleRecord, TaskRecord } from './state.js';

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

/** 周期验收通过后的推进分流（docs/design-cycles.md §6.3）。 */
export type CycleAdvanceAction =
  /** 直通：下一期已 planned → 机械推进（唯一全程无人值守的路径）。 */
  | { kind: 'direct'; next: CycleRecord }
  /** 等规划：checkpoint 未设且下一期未预排 → 当前置 done，落问卷请人规划，绝不静默空转。 */
  | { kind: 'wait-plan' }
  /** 检查点：该周期 checkpoint=true（组长声明边界要请用户确认）→ 停在 in_review 等点头。 */
  | { kind: 'checkpoint'; next: CycleRecord | null };

/**
 * 「周期完成但下一期未排/未批」既不误伤卡死检测、也不无限静默（§6.4）的纯判据：
 * 给定周期列表与刚验收通过的周期（`current`，status 为 in_review），按该周期的
 * `checkpoint` 字段决定走哪条路。状态迁移与落问卷的副作用留在 service.ts，
 * 这里是唯一的分流判据 —— 「边界是否请示」是组长每期的 AI 决策（checkpoint 字段），
 * 不是用户的全局开关（v1 的 `autoAdvance` 配置已移除）。
 */
export function cycleAdvancePlan(
  cycles: readonly CycleRecord[],
  current: CycleRecord,
): CycleAdvanceAction {
  const next = cycles.find((cycle) => cycle.status === 'planned');
  if (current.checkpoint === true) return { kind: 'checkpoint', next: next ?? null };
  if (next !== undefined) return { kind: 'direct', next };
  return { kind: 'wait-plan' };
}
