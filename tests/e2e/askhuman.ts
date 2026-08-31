/**
 * Deterministic e2e: 需要**人工确认 / 提供信息**的任务流程。
 *
 * 覆盖：leader 向人 `ask_human` → 生成一张 open 问卷（面板「等你决策」，任务保持
 * in_progress、不升级不误判卡住）→ 人 `answer_questionnaire` 作答 → 问卷 answered、
 * 答案落地，任务可继续。
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AutopilotService } from '../../src/service.js';
import { gitTest, makeFixture, testOptions, writeContract } from '../helpers.js';

describe('e2e: ask_human (human provides info) flow', () => {
  it('a task triggers ask_human → questionnaire open (awaiting) → answered', async () => {
    const fixture = await makeFixture('e2e-ask');
    const service = await AutopilotService.create(testOptions(fixture));
    try {
      const team = await service.createTeam({ name: 'ask-team' });
      await writeContract(join(team.repoPath, '.tasks', 'Q-1.md'), { id: 'Q-1', title: 'needs a decision', touches: ['app/'] });
      gitTest(['add', '-A'], team.repoPath);
      gitTest(['commit', '-m', 'tasks: seed Q-1'], team.repoPath);
      await service.addMember({ teamId: team.id, role: 'developer' });
      await service.tickOnce(); // 派发 Q-1
      const task = service.teamView(team.id).tasks.find((candidate) => candidate.contractId === 'Q-1')!;
      expect(task.status).toBe('in_progress');

      const result = await service.askHuman({
        teamId: team.id,
        title: '缓存用哪套',
        questions: [{
          name: 'cache',
          label: '缓存放哪里？',
          type: 'select',
          options: [
            { value: 'redis', label: 'Redis', impact: '多一个运维组件', recommended: true },
            { value: 'inproc', label: '进程内', impact: '多实例会各存一份' },
          ],
          defaultValue: 'redis',
        }],
        kind: 'intake',
        taskId: task.id,
      });

      expect(result.status).toBe('open');
      expect(result.questionnaire.id).toMatch(/^qn_/);
      // 核心不变量：一次正常提问，不是故障。
      const projection = service.projection();
      expect(projection.questionnaires.filter((record) => record.status === 'open')).toHaveLength(1);
      expect(projection.questionnaires[0]?.taskId).toBe(task.id);
      expect(projection.blocked).not.toContain(task.id);
      expect(service.escalations.all).toHaveLength(0);
      expect(service.teamView(team.id).tasks.find((candidate) => candidate.id === task.id)?.status).toBe('in_progress');

      // 人作答 → 问卷 answered，答案落地。
      await service.answerQuestionnaire({
        questionnaireId: result.questionnaire.id,
        answers: { cache: 'redis' },
      });
      expect(service.projection().questionnaires.find((q) => q.id === result.questionnaire.id)?.status).toBe('answered');
      expect(service.teamView(team.id).tasks.find((candidate) => candidate.id === task.id)?.status).toBe('in_progress');
    } finally {
      await service.dispose();
    }
  }, 60_000);
});
