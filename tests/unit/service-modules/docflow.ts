/**
 * service/docflow.ts 的纯函数单测：问卷答案与审批题的纯函数。
 */
import { describe, expect, it } from 'vitest';
import { effectiveAnswers, withApprovalQuestion } from '../../../src/service/docflow.js';
import type { QuestionnaireRecord } from '../../../src/questionnaire.js';

describe('docflow: effectiveAnswers / withApprovalQuestion', () => {
  const question = { name: 'q1', label: 'Q1', type: 'text', options: [], required: true, defaultValue: '' };

  function record(overrides: Record<string, unknown>): QuestionnaireRecord {
    return {
      id: 'qn_1',
      teamId: 'team_1',
      kind: 'intake',
      mode: 'interactive',
      title: 't',
      questions: [question],
      answers: {},
      status: 'answered',
      binding: null,
      ticketUrl: null,
      mailDelivered: false,
      taskId: null,
      createdAt: 0,
      answeredAt: null,
      expiresAt: null,
      approvalCode: null,
      ...overrides,
    } as QuestionnaireRecord;
  }

  it('答完的用真答案；空串不算答案', () => {
    const answered = record({ answers: { q1: { value: 'docker', at: 1, source: 'ticket' } } });
    expect(effectiveAnswers(answered)).toEqual({ q1: 'docker' });
    const blank = record({ answers: { q1: { value: '', at: 1, source: 'ticket' } } });
    expect(effectiveAnswers(blank)).toEqual({});
  });

  it('expired 才回落 defaultValue；answered 不回落（§3.2 兜底只属于超时）', () => {
    const expired = record({
      status: 'expired',
      answers: {},
      questions: [{ ...question, defaultValue: 'docker' }],
    });
    expect(effectiveAnswers(expired)).toEqual({ q1: 'docker' });
    const open = record({ answers: {}, questions: [{ ...question, defaultValue: 'docker' }] });
    expect(effectiveAnswers(open)).toEqual({});
  });

  it('withApprovalQuestion 追加 decision 题且默认值是 reject（§8-10 的保守兜底）', () => {
    const withQuestion = withApprovalQuestion([]);
    expect(withQuestion).toHaveLength(1);
    expect(withQuestion[0]?.name).toBe('decision');
    expect(withQuestion[0]?.defaultValue).toBe('reject');
    // 已有同名题时不重复追加
    const existing = [{ ...question, name: 'decision' }];
    expect(withApprovalQuestion(existing)).toBe(existing);
  });
});