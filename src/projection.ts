/**
 * `autopilot` 会话投影单元的注册。
 *
 * schema 本身在 `schema.ts`（视图类型也由它反推，见该文件说明）；本文件只负责
 * 把它接到投影缝上，并持有 `stateVersion`。
 *
 * 折叠策略是**全量快照 + last-write-wins**：每条 `autopilot/update` 事件携带完整
 * 的 {@link AutopilotProjection}，直接替换旧值，不做增量合并。因此向后兼容的责任
 * 落在 schema 的默认值上（例如 v3 新增的 `teams[].learnings` 用 `.default([])`），
 * 让旧 session 重放出来的事件负载仍然 parse 得过。
 */
import type { Context } from '@deepseek-ai/cordis';
// oxlint-disable-next-line unicorn/require-module-specifiers
import type {} from '@deepseek-ai/dsh-session-projection';
import './events.js';
import { autopilotProjectionSchema } from './schema.js';
import type { AutopilotProjection } from './schema.js';

/** 当投影缝可用时注册投影单元。 */
export function registerAutopilotProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: 'autopilot',
      stateSchema: autopilotProjectionSchema.nullable(),
      init: (): AutopilotProjection | null => null,
      apply: (state, event) => (event.type === 'autopilot/update' ? event.data.state : state),
      wire: {
        viewSchema: autopilotProjectionSchema.nullable(),
        view: (state): AutopilotProjection | null => state,
      },
      // v3：teamView 新增 `learnings`；任务状态新增 `needs-clarification`；
      // 升级原因新增 `change-too-large`。
      // v4：deploy status 新增 `rollback-failed`（回滚命令自身失败）。
      // v5：teamView 新增 `metrics`（团队累计运行指标）；升级原因新增 `budget-exceeded`。
      // v6：teamView 新增 `phase`（文档先行的团队阶段，缺省 developing 以兼容旧负载）；
      // 升级原因新增 `blocked-dependency`（前置永不可能满足，区别于"还没完成"）。
      // 变更形状时需递增。
      stateVersion: 6,
    });
  });
}
