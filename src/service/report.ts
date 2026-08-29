/**
 * 完成报告的渲染（纯函数）。
 *
 * 全部任务 done 时由守护循环写进 `<stateDir>/completion.md`。报告是给人看的收尾
 * 材料 —— 它不参与任何决策，所以整段渲染做成纯函数，改格式不需要碰状态机。
 *
 * 其中「待人工升格」清单是知识回路的收口：反复被印证的坑值得长期化，但写进
 * 项目文档是人的决定，插件只列候选、绝不代笔（AGENTS.md / docs/ 属 human-only 区）。
 */
import type { DeployView } from '../view.js';
import type { TeamRecord } from './state.js';

export interface CompletionReportInput {
  team: TeamRecord;
  /** 全局部署历史（跨团队），与面板看到的是同一份。 */
  deploys: readonly DeployView[];
  /** 升格门槛（`learnings.promoteAfterHits`）；知识回路未启用时传 undefined。 */
  promoteAfterHits: number | undefined;
  /** 报告时间戳；由调用方传入以便测试可复现。 */
  finishedAt: number;
}

/** 渲染 `<stateDir>/completion.md` 的完整内容。 */
export function renderCompletionReport(input: CompletionReportInput): string {
  const { team, deploys, promoteAfterHits, finishedAt } = input;
  const learnings = team.learnings ?? [];
  const pendingPromotion =
    promoteAfterHits === undefined
      ? []
      : learnings.filter((learning) => !learning.promoted && learning.hits >= promoteAfterHits);
  return [
    `# Autopilot completion report`,
    ``,
    `team: ${team.name} (${team.id})`,
    `finished at: ${new Date(finishedAt).toISOString()}`,
    ``,
    `## tasks`,
    ...team.tasks.map((task) => `- ${task.contractId ?? task.id} ${task.title} — ${task.status}`),
    ``,
    `## deploys`,
    ...(deploys.length === 0
      ? ['- (none)']
      : deploys.map((deploy) => `- ${deploy.id} ${deploy.status} at ${new Date(deploy.startedAt).toISOString()}`)),
    ``,
    `## learnings`,
    ...(learnings.length === 0
      ? ['- (none captured)']
      : learnings.map(
          (learning) =>
            `- ${learning.summary} (${learning.hits}x, ${learning.bucket}${learning.promoted ? ', promoted' : ''})`,
        )),
    ``,
    ...(pendingPromotion.length === 0
      ? []
      : [
          `## pending promotion to project docs (learning_promote)`,
          ``,
          ...pendingPromotion.map((learning) => `- ${learning.summary} — id ${learning.id} (${learning.hits}x)`),
          ``,
        ]),
  ].join('\n');
}
