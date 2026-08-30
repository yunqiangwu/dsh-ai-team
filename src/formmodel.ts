/**
 * 工单表单的形状，以及「题目 → 表单字段」的映射 —— 服务端画 HTML 表单与面板画
 * React 卡片**共用这一份**（M2 / docs/design-interaction.md §3.3）。
 *
 * 为什么单独立一个文件而不是留在 `questionnaire.ts`：面板产物只能 import 浏览器
 * 安全的模块，而 `questionnaire.ts` 要用 `node:crypto` 铸审批码。同一个题面映射
 * 抄两份的代价是可证的 —— 服务端预勾 `recommended`、面板没预勾，人就会在两张长得
 * 不一样的表单上答同一组问题。
 *
 * 浏览器安全：不得 import node，不得 import zod（架构铁律 5 对 `view.ts` 的要求
 * 同样适用于本文件，它会进 `lib/client.js`）。
 */
import { MULTI_VALUE_SEP } from './vocab.js';
import type { Question, QuestionType } from './view.js';

/** 一个可选项。字符串是 `{value, label}` 的简写。 */
export interface TicketOption {
  value: string;
  label: string;
  /** 预勾选（单选题即默认项）。 */
  checked?: boolean;
  /** 选项副文案：选它的代价。 */
  impact?: string;
}

export type TicketOptionInput = string | TicketOption;

/** 归一化选项：字符串简写与对象写法在渲染层等价。 */
export function normalizeOption(option: TicketOptionInput): TicketOption {
  return typeof option === 'string' ? { value: option, label: option } : option;
}

export interface TicketField {
  name: string;
  label: string;
  /**
   * `multiselect` 渲染成复选框组（HTML 那条同名多次提交，服务端按分隔符连接；
   * 面板那条发成字符串数组）。`password` 只服务升级分诊表单以外的手写字段。
   * 刻意不做条件分段（branching）—— 见 docs/design-interaction.md §3.3。
   */
  type: QuestionType | 'password';
  required?: boolean;
  options?: TicketOptionInput[];
  placeholder?: string;
}

/**
 * 问卷题目 → 表单字段：选项题画 select / multiselect 并预勾推荐项与默认值，
 * 填空题画 text / textarea。
 */
export function fieldsOfQuestions(questions: readonly Question[]): TicketField[] {
  return questions.map((question) => {
    const defaultValues = question.defaultValue
      .split(MULTI_VALUE_SEP)
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const options: TicketOption[] = question.options.map((option) => {
      // 单选预选只能有一个：defaultValue 是「没人答时的兜底」，也是超时后的去向，
      // 表单预勾必须跟它一致 —— 否则人「闭眼提交」与「放着不管」会得到两个不同的答案。
      // 无默认值时才允许推荐项兜底预勾，免得 recommended 与 defaultValue 指到两处时
      // 两个 radio 同时被选中（表单无法表达「默认是 A 但推荐 B」）。
      const checked =
        question.type === 'multiselect'
          ? option.recommended || defaultValues.includes(option.value)
          : question.defaultValue !== ''
            ? option.value === question.defaultValue
            : !!option.recommended;
      return {
        value: option.value,
        label: option.label,
        checked,
        ...(option.impact === '' ? {} : { impact: option.impact }),
      };
    });
    return {
      name: question.name,
      label: question.label,
      type: question.type,
      ...(question.required ? { required: true } : {}),
      ...(options.length === 0 ? {} : { options }),
    };
  });
}

/**
 * 升级分诊表单的两个字段。与问卷不同，它不从题目映射而来 —— 一张升级工单永远问
 * 同两件事（怎么处置、有什么要补充的），所以服务端工单页与面板内联卡片共用这份
 * 常量，而不是各写一遍。
 */
export function escalationFields(): TicketField[] {
  return [
    {
      name: 'decision',
      label: '请确认如何处理该问题（填写你的决策）',
      type: 'textarea',
      required: true,
      placeholder: '例如：同意该方案 / 更换密钥 / 变更需求……',
    },
    {
      name: 'note',
      label: '补充说明（可选；密钥请通过环境变量提供，勿直接粘贴）',
      type: 'text',
      placeholder: '任何需要 AI 团队知道的上下文',
    },
  ];
}
