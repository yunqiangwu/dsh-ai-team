/**
 * service/state.ts 的纯函数单测：共享纯工具。
 */
import { describe, expect, it } from 'vitest';
import { clip, HELD_STATUSES, noteLines, oneLine, shortId } from '../../../src/service/state.js';

describe('state helpers', () => {
  it('clip returns empty for a non-positive budget', () => {
    // 这是预算倒排能成立的前提：clip(text, 0) 若走 slice(0,-1) 会留下几乎全文
    expect(clip('hello world', 0)).toBe('');
    expect(clip('hello world', -5)).toBe('');
    expect(clip('abc', 10)).toBe('abc');
    expect(clip('abcdef', 4)).toBe('abc…');
  });

  it('shortId prefixes and stays 8 hex chars', () => {
    expect(shortId('task')).toMatch(/^task_[0-9a-f]{8}$/);
  });

  it('oneLine strips markdown bullets and blank leading lines', () => {
    expect(oneLine('\n\n- **fix the flake**: retry\nmore')).toBe('**fix the flake**: retry');
    expect(oneLine('   \n  ')).toBe('');
  });

  it('noteLines prefixes every line and honours the cap', () => {
    expect(noteLines('a\nb')).toEqual(['> a', '> b']);
    expect(noteLines('a\nb\nc', 2)).toEqual(['> a', '> b']);
  });

  it('HELD_STATUSES covers exactly the two waiting states', () => {
    expect([...HELD_STATUSES].toSorted()).toEqual(['needs-clarification', 'needs-human']);
  });
});