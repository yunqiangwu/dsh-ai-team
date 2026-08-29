/**
 * 任务描述的组装（纯函数）。
 *
 * 这是 `TaskRecord.description` 的唯一生产者，service.ts 的两条派发路径
 * （leader 经 `task_assign` 手工派发、守护循环收养契约后派发）都调它，
 * 所以「注入什么、按什么顺序、超预算时牺牲谁」只需要在这一处想清楚。
 *
 * 预算优先级是 **所有权 > 教训 > 正文**，这个顺序是刻意的：
 *  - 所有权 / 硬规则来自画像，是不可协商的约束，agent 读到的最后一段必须是它；
 *  - 教训只是提示，且被裁掉的部分仍会由 `learning_list` 工具兜住；
 *  - 契约正文最长也最可以让位 —— 接手者本来就要去读 `.tasks/<id>.md` 全文。
 *
 * 反过来说，实现绝不能是「先拼完整段再从尾部 clip」：那会把最该保留的末段
 * 最先裁掉（本模块修的就是这个）。
 */
import { renderLearningsSection, selectLearnings } from '../learnings.js';
import { enrichDescriptionWithOwnership } from '../profile.js';
import { clip } from './state.js';
import type { LearningOptions, LearningRecord } from '../learnings.js';
import type { ProjectProfile } from '../profile.js';

/** 契约正文写入任务描述时的最大长度，避免超长契约撑爆提示词。 */
export const CONTRACT_BODY_LIMIT = 2000;

/**
 * 任务描述的总长度上限：注入 learnings 与 ownership 小节之后仍需有界 ——
 * description 会随 autopilot/update 事件整体推给前端，并进每一次工具返回。
 */
export const DESCRIPTION_TOTAL_LIMIT = 6000;

export interface DescriptionInput {
  /** 契约正文或 leader 手写的描述。 */
  raw: string;
  touches: readonly string[];
  /** 该团队已沉淀的教训（内存真相源，与 state.json 同源）。 */
  learnings: readonly LearningRecord[];
  profile: ProjectProfile;
  /** 生效的知识回路配置；`undefined` 或未启用时完全不注入。 */
  learningOptions: LearningOptions | undefined;
}

/**
 * 拼出最终注入给 agent 的任务描述：正文 → 《已知教训》→ 《域所有权 / 硬规则》，
 * 总长恒不超过 DESCRIPTION_TOTAL_LIMIT。
 */
export function buildDescription(input: DescriptionInput): string {
  // 以空正文调用两个渲染器，取到的就是它们各自那段「尾巴」，不必复制其格式。
  const ownershipTail = enrichDescriptionWithOwnership('', input.touches, input.profile.ownership);
  const learningsTail =
    input.learningOptions === undefined || input.learningOptions.enabled !== true
      ? ''
      : (() => {
          const { items, dropped } = selectLearnings(
            input.learnings,
            input.touches,
            input.learningOptions,
          );
          return renderLearningsSection(items, dropped, '');
        })();

  // 所有权段永不裁；教训段拿剩下的额度；正文拿最后剩下的额度。
  const learnings = clip(learningsTail, DESCRIPTION_TOTAL_LIMIT - ownershipTail.length);
  const body = clip(
    input.raw,
    Math.min(CONTRACT_BODY_LIMIT, DESCRIPTION_TOTAL_LIMIT - ownershipTail.length - learnings.length),
  );
  return `${body}${learnings}${ownershipTail}`;
}
