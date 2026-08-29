/**
 * dsh-ai-team 会话日志词汇表的唯一家：`autopilot/update` 全量状态快照事件，
 * 外加 `autopilot` 投影 key，通过与官方插件完全一致的声明合并完成。纯类型 ——
 * 无运行时 import —— 因此 host 与 client 两侧都能引入。
 *
 * 整值规则：每条 `autopilot/update` 都携带完整的替代 AutopilotProjection，
 * 因此投影折叠是 last-write-wins。
 */
import type { AutopilotProjection } from './view.js';
// Pull the augmented modules into the program so the declaration merges
// below resolve (erased at compile time; type-only).
// oxlint-disable-next-line unicorn/require-module-specifiers
import type {} from '@deepseek-ai/dsh-session/types';
// oxlint-disable-next-line unicorn/require-module-specifiers
import type {} from '@deepseek-ai/dsh-session-projection/types';

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** autopilot 的全量状态快照；重放时最新写者获胜。 */
    'autopilot/update': {
      state: AutopilotProjection;
    };
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * autopilot 面板渲染的循环状态、团队、任务看板、门结果、升级流与部署历史，
     * 或在首次更新前为 null。
     */
    autopilot: AutopilotProjection | null;
  }
  interface SessionProjectionStateMap {
    /** autopilot 单元的 host 折叠状态：同一份整值快照。 */
    autopilot: AutopilotProjection | null;
  }
}

