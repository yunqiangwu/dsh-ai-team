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
  /** 等规划：autoAdvance 且下一期未预排 → 当前置 done，落问卷请人规划，绝不静默空转。 */
  | { kind: 'wait-plan' }
  /** 人工检查点：autoAdvance=false → 周期停在 in_review，落问卷等人点头后才推进。 */
  | { kind: 'checkpoint'; next: CycleRecord | null };

/**
 * 「周期完成但下一期未排/未批」既不误伤卡死检测、也不无限静默（§6.4）的纯判据：
 * 给定周期列表与 `autoAdvance` 配置，决定当前刚验收通过的周期该走哪条路。
 * 状态迁移与落问卷的副作用留在 service.ts，这里是唯一的分流判据。
 */
export function cycleAdvancePlan(
  cycles: readonly CycleRecord[],
  autoAdvance: boolean,
): CycleAdvanceAction {
  const next = cycles.find((cycle) => cycle.status === 'planned');
  if (autoAdvance) {
    if (next !== undefined) return { kind: 'direct', next };
    return { kind: 'wait-plan' };
  }
  return { kind: 'checkpoint', next: next ?? null };
}
