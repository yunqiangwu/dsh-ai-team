/**
 * Deterministic e2e: 人工确认后派生的后续开发闭环。
 *
 * 复刻真实场景：leader 就「是否支持 GFM 表格」向人 `ask_human` → 开放问卷（等你决策）
 * → 人作答（确认支持 + 语义化输出）→ 技能把确认结果派生为 MD2HTML-4 契约
 * → 派发给开发 → 开发补丁 → 门禁 → 评审 → 合并，全部 done + 零升级。
 *
 * 不依赖 LLM、不联网、零 token；作者是脚本而非模型。被测对象是「人工确认 → 派生实现 → 闭环」。
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AutopilotService } from '../../src/service.js';
import { gitTest, makeFixture, testOptions, writeContract, commitInWorktree } from '../helpers.js';

const TABLE_IMPL = `export function renderTable(rows: string[][]): string {
  const head = rows[0];
  if (head === undefined) return '';
  const thead = '<thead><tr>' + head.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead>';
  const body = '<tbody>' + rows.slice(1).map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody>';
  return '<table>' + thead + body + '</table>';
}
`;

describe('e2e: ask_human decision → derived follow-up task → full loop', () => {
  it('human confirms (ask_human → answer), then MD2HTML-4 is built and merged', async () => {
    const fixture = await makeFixture('e2e-gfm');
    const service = await AutopilotService.create(
      testOptions(fixture, { gates: { commands: ['git --version'], requireCiGreen: false, timeoutMinutes: 1 } }),
    );
    try {
      const team = await service.createTeam({ name: 'gfm-team' });
      await writeContract(join(team.repoPath, '.tasks', 'Q-1.md'), { id: 'Q-1', title: 'needs a decision', touches: ['app/'] });
      gitTest(['add', '-A'], team.repoPath);
      gitTest(['commit', '-m', 'tasks: seed Q-1'], team.repoPath);
      await service.addMember({ teamId: team.id, role: 'developer' });
      const reviewer = await service.addMember({ teamId: team.id, role: 'reviewer' });
      await service.tickOnce();
      const decisionTask = service.teamView(team.id).tasks.find((x) => x.contractId === 'Q-1')!;
      expect(decisionTask.status).toBe('in_progress');

      // leader 向人 ask_human → 开放问卷（等你决策）
      const asked = await service.askHuman({
        teamId: team.id,
        title: '是否支持 GFM 表格',
        questions: [{ name: 'support', label: '支持表格？', type: 'select', options: [
          { value: 'yes', label: '支持', recommended: true },
          { value: 'no', label: '不支持' },
        ], defaultValue: 'yes' }],
        kind: 'intake',
        taskId: decisionTask.id,
      });
      expect(asked.status).toBe('open');
      expect(service.projection().questionnaires.filter((q) => q.status === 'open')).toHaveLength(1);
      expect(service.escalations.all).toHaveLength(0);

      // 人作答（确认支持）→ answered
      await service.answerQuestionnaire({ questionnaireId: asked.questionnaire.id, answers: { support: 'yes' } });
      expect(service.projection().questionnaires.find((q) => q.id === asked.questionnaire.id)?.status).toBe('answered');

      // 完成决策任务 Q-1（门禁+评审+合并），释放 developer
      await service.updateTask({ taskId: decisionTask.id, status: 'in_review' });
      await service.runGatesForTask({ taskId: decisionTask.id });
      await service.review({ taskId: decisionTask.id, reviewerId: reviewer.id, verdict: 'approve' });

      // 确认结果派生为 MD2HTML-4 契约 → 派发 → 开发 → 门禁 → 评审 → 合并
      await writeContract(join(team.repoPath, '.tasks', 'MD2HTML-4.md'), { id: 'MD2HTML-4', title: 'Implement GFM tables', touches: ['src', 'tests'] });
      gitTest(['add', '-A'], team.repoPath);
      gitTest(['commit', '-m', 'tasks: add MD2HTML-4'], team.repoPath);
      const dev = service.teamView(team.id).members.find((m) => m.role === 'developer')!;
      const follow = await service.assignTask({ teamId: team.id, title: 'implement GFM tables', assigneeId: dev.id, contractId: 'MD2HTML-4' });
      commitInWorktree(dev.workspacePath, 'src/tables.ts', TABLE_IMPL, 'feat(tables): GFM tables');
      commitInWorktree(dev.workspacePath, 'tests/tables.test.ts', 'import { test } from "node:test";\n', 'test(tables): coverage');
      await service.updateTask({ taskId: follow.id, status: 'in_review' });
      const gates = await service.runGatesForTask({ taskId: follow.id });
      expect(gates.allPassed).toBe(true);
      const verdict = await service.review({ taskId: follow.id, reviewerId: reviewer.id, verdict: 'approve' });
      expect(verdict.merged).toBe(true);

      const view = service.teamView(team.id);
      expect(view.tasks.find((t) => t.contractId === 'MD2HTML-4')?.status).toBe('done');
      expect(service.escalations.all).toHaveLength(0);
      expect(gitTest(['show', 'main:src/tables.ts'], team.repoPath)).toContain('renderTable');
    } finally {
      await service.dispose();
    }
  }, 60_000);
});
