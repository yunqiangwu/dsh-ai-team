/**
 * src/service/team-rules.ts 的纯函数单测：团队 / 派发业务不变量。
 */
import { describe, expect, it } from 'vitest';
import {
  atMemberLimit,
  atTaskLimit,
  canWriteCode,
  exactlyOneLeader,
  hasLeader,
} from '../../../src/service/team-rules.js';

const teamRuleMember = (role: string) => ({ role });

describe('team rules: 团队 / 派发业务不变量', () => {
  it('exactlyOneLeader: 有且仅有一个 leader 才通过', () => {
    expect(exactlyOneLeader([teamRuleMember('leader')])).toBe(true);
    expect(exactlyOneLeader([teamRuleMember('leader'), teamRuleMember('developer')])).toBe(true);
    expect(exactlyOneLeader([])).toBe(false);
    expect(exactlyOneLeader([teamRuleMember('leader'), teamRuleMember('leader')])).toBe(false);
    expect(exactlyOneLeader([teamRuleMember('developer')])).toBe(false);
  });

  it('hasLeader: 只要出现过 leader 就为真', () => {
    expect(hasLeader([teamRuleMember('leader')])).toBe(true);
    expect(hasLeader([teamRuleMember('developer'), teamRuleMember('leader')])).toBe(true);
    expect(hasLeader([teamRuleMember('developer')])).toBe(false);
    expect(hasLeader([])).toBe(false);
  });

  it('atMemberLimit / atTaskLimit: 达到上限即真', () => {
    expect(atMemberLimit([{}], 1)).toBe(true);
    expect(atMemberLimit([{}], 2)).toBe(false);
    expect(atTaskLimit([{}, {}], 2)).toBe(true);
    expect(atTaskLimit([{}, {}], 3)).toBe(false);
  });

  it('canWriteCode: reviewer / operator 不能承担写代码任务', () => {
    expect(canWriteCode('leader')).toBe(true);
    expect(canWriteCode('developer')).toBe(true);
    expect(canWriteCode('reviewer')).toBe(false);
    expect(canWriteCode('operator')).toBe(false);
  });
});