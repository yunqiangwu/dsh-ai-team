/**
 * 面板字典与枚举词表的对齐断言。
 *
 * 面板里的 t() 几乎全是运行时拼出来的 key（`reason.${...}` / `phase.${...}`），而
 * Translator 接受任意字符串 —— 新增一个枚举值忘了配字典，表现是界面上直接渲染出
 * `phase.intake` 这种原始 key，编译器和现有测试一条都不会响。`src/client/index.tsx`
 * 把 zh 导出来就是为了这一刻（见该文件注释），但那条意图此前一直只写在注释里。
 *
 * 断言方向是**枚举 → 字典**，不是字典 → 枚举：字典里允许有与枚举无关的静态文案
 * （`panel.title`、`config.save`……），漏配才是 bug。
 */
import { describe, expect, it } from 'vitest';
import { en, zh } from '../src/client/index.js';
import {
  CI_STATUSES,
  DEPLOY_STATUSES,
  ESCALATION_REASONS,
  LOOP_STATES,
  NOTIFICATION_STATUSES,
  ROLES,
  TASK_STATUSES,
  TEAM_PHASES,
} from '../src/vocab.js';

/**
 * 面板用 `${prefix}.${枚举值}` 取文案的前缀，与 AutopilotPanel.tsx 里的 t() 一一对应。
 * 不在此列的枚举是刻意原样渲染的（`learning.bucket` 直接显示桶名），或压根没有面向人的
 * 取值文案（`member.status` 只喂 CSS 类名）—— 给它们补字典只会多出没人读的 key。
 */
const rendered: [string, readonly string[]][] = [
  ['role', ROLES],
  ['status', TASK_STATUSES],
  ['reason', ESCALATION_REASONS],
  ['loop', LOOP_STATES],
  ['phase', TEAM_PHASES],
  ['ci', CI_STATUSES],
  ['deploy', DEPLOY_STATUSES],
  ['notify', NOTIFICATION_STATUSES],
];

/**
 * 字典是字面量对象，key 类型是那些字面量的联合；运行时拼出来的字符串索引它，
 * 需要一次显式收口成 Record（而不是在每条断言里各写一遍 cast）。
 */
const zhByKey: Record<string, string> = zh;
const enByKey: Record<string, string> = en;

describe('client: 枚举值都有中英文案', () => {
  for (const [prefix, values] of rendered) {
    it(`${prefix}.* 覆盖 ${prefix} 的全部 ${values.length} 个取值`, () => {
      for (const value of values) {
        const key = `${prefix}.${value}`;
        // 漏一条的表现是面板把 key 原样渲染出来，所以两边都必须是非空字符串。
        expect(zhByKey[key], key).toBeTypeOf('string');
        expect(zhByKey[key], key).not.toBe('');
        expect(enByKey[key], key).toBeTypeOf('string');
        expect(enByKey[key], key).not.toBe('');
      }
    });
  }

  it('中英文 key 集合完全一致（en 的类型已强制，这里断言的是反向漏配）', () => {
    expect(Object.keys(en).toSorted()).toEqual(Object.keys(zh).toSorted());
  });
});
