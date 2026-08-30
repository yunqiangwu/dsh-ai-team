/**
 * Deterministic e2e: 文档先行审批 → 进入开发闭环。
 *
 * 复刻真实场景：doc_write 写草稿 → ask_human(kind: approval) 生成审批问卷（预留一次性 code）
 * → 人批（answer decision=approve → doc_approve(code)）→ 阶段进 scaffolding → 切入 developing
 * → 契约 → 派发 → 开发 → 门禁 → 评审 → 合并。被测对象是「文档审批」人工节点 + 后续开发闭环。
 *
 * 不依赖 LLM、不联网、零 token。
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AutopilotService } from '../src/service.js';
import { gitTest, makeFixture, testOptions, writeContract, commitInWorktree } from './helpers.js';

const PRD = '# PRD\n\nmd2html 二期：支持 GFM 表格。\n';

describe('e2e: document-first approval -> scaffolding -> develop', () => {
  it('doc_write -> approval -> doc_approve -> developing -> merge', async () => {
    const fixture = await makeFixture('e2e-doc');
    const service = await AutopilotService.create(
      testOptions(fixture, { gates: { commands: ['git --version'], requireCiGreen: false, timeoutMinutes: 1 } }),
    );
    try {
      const team = await service.createTeam({ name: 'doc-team' });
      await service.docWrite({ teamId: team.id, path: 'docs/drafts/prd.md', body: PRD });

      // 审批问卷（kind: approval）→ 预留一次性 code
      const asked = await service.askHuman({ teamId: team.id, title: '开工包批不批', kind: 'approval', questions: [] });
      const record = service.questionnaires.byId(asked.questionnaire.id)!;
      const code = record.approvalCode!;
      expect(code).toBeTruthy();

      // 人批准：先答 decision=approve，再用 code 升格
      await service.answerQuestionnaire({ questionnaireId: asked.questionnaire.id, answers: { decision: 'approve' } });
      const approved = await service.docApprove({ teamId: team.id, code });
      expect(approved).toBeTruthy();

      // 切入开发
      await service.setPhase({ teamId: team.id, phase: 'developing' });
      const dev = await service.addMember({ teamId: team.id, role: 'developer' });
      const reviewer = await service.addMember({ teamId: team.id, role: 'reviewer' });
      await writeContract(join(team.repoPath, '.tasks', 'DOC-1.md'), { id: 'DOC-1', title: 'implement gfm', touches: ['src'] });
      gitTest(['add', '-A'], team.repoPath);
      gitTest(['commit', '-m', 'tasks: add DOC-1'], team.repoPath);
      const task = await service.assignTask({ teamId: team.id, title: 'implement gfm', assigneeId: dev.id, contractId: 'DOC-1' });
      commitInWorktree(dev.workspacePath, 'src/gfm.ts', 'export const gfm = true;\n', 'feat: gfm');
      await service.updateTask({ taskId: task.id, status: 'in_review' });
      const gates = await service.runGatesForTask({ taskId: task.id });
      expect(gates.allPassed).toBe(true);
      const verdict = await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' });
      expect(verdict.merged).toBe(true);
      expect(service.teamView(team.id).tasks.find((t) => t.contractId === 'DOC-1')?.status).toBe('done');
      expect(service.escalations.all).toHaveLength(0);
    } finally {
      await service.dispose();
    }
  }, 60_000);
});
