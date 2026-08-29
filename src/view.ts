/**
 * 视图类型门面：host 侧与 client 侧共用的唯一词汇表。
 *
 * 两条铁律：
 *  1. **不得 import 任何 node 内置模块** —— 客户端 bundle 会内联本文件；
 *  2. 对 `schema.ts` 只能做**纯类型** re-export（`export type { ... } from`）。
 *     值层面的引用会把整个 zod 打进前端产物。
 *
 * 运行时枚举一律来自 `vocab.ts`（零依赖），类型一律派生自 `schema.ts` 的 zod
 * schema。分层是单向的，所以这里不需要 `z.infer`，也不该出现第二份字段清单：
 *
 *   vocab.ts（值，浏览器安全）← schema.ts（zod + z.infer）← view.ts（门面）
 *
 * 数据流：host 工具 / 守护循环变更 AutopilotService 状态 → 插件追加一条携带
 * {@link AutopilotProjection} 快照的 `autopilot/update` 会话事件 → `autopilot`
 * 会话投影把它折叠（last-write-wins）→ 浏览器面板用
 * useProjection('autopilot') 读取它。
 */
import type { AutopilotProjection } from './schema.js';

// 枚举清单与其字面量联合类型：运行时值 + 类型，一并转出给所有下游。
export * from './vocab.js';

// 视图形状：唯一真相在 schema.ts，这里只转发名字。
export type {
  Answer,
  DeployView,
  EscalationNotification,
  EscalationView,
  GateResult,
  GateSummary,
  HeartbeatView,
  LearningView,
  MemberView,
  Question,
  QuestionBinding,
  QuestionnaireView,
  QuestionOption,
  ReviewView,
  TaskView,
  TeamView,
  AutopilotProjection,
} from './schema.js';

export const EMPTY_PROJECTION: AutopilotProjection = {
  loopState: 'stopped',
  teams: [],
  activeTeamId: null,
  escalations: [],
  questionnaires: [],
  deploys: [],
  heartbeat: null,
  blocked: [],
};
