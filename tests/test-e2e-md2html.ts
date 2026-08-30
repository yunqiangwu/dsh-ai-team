/**
 * Deterministic e2e: 复刻「md2html 真实试点」的无人值守闭环，但**不依赖 LLM、不联网、零 token**。
 *
 * 覆盖的真实流程：
 *   autopilot_init（clone）→ 补 dev/reviewer → 三段契约（MD2HTML-1/2/3，同 docs/REQUIREMENT.md
 *   拆分）→ task_assign → 开发补丁 → in_review → gates_run → code_review approve
 *   → merge 进 main → 全部 done + 已合并 + 零升级。
 *
 * 与 test-integration 的差异：这里用**三段式 md2html 任务**复现试点结构；门禁用轻量命令以保持
 * 离线确定性。真实 md2html 源码作为「开发产物」由 commitInWorktree 写入，作者是脚本而不是 LLM
 * —— 被测对象是**编排闭环**本身（拆单 → 派发 → 门禁 → 评审 → 合并）。
 */
import { describe, expect, it } from 'vitest';
import { AutopilotService } from '../src/service.js';
import { gitTest, makeFixture, seedRemote, testOptions, commitInWorktree } from './helpers.js';

/** md2html 三段任务的最终产物（对应 docs/REQUIREMENT.md 的行内/块级/CLI 实现）。 */
const PARSER_IMPL = `
export interface HtmlOptions {
  document?: boolean;
  title?: string;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^\\p{L}\\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
}

export function renderInline(text: string): string {
  return text
    .replace(/\`([^\`]+)\`/g, (_m, code) => '<code>' + esc(String(code)) + '</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, (_m, b) => '<strong>' + renderInline(String(b)) + '</strong>')
    .replace(/\\*([^*]+)\\*/g, (_m, i) => '<em>' + renderInline(String(i)) + '</em>')
    .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, (_m, t, u) => '<a href="' + esc(String(u)) + '">' + renderInline(String(t)) + '</a>');
}

export function renderMarkdown(markdown: string, options: HtmlOptions = {}): string {
  const lines = markdown.split(/\\r?\\n/);
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') { i += 1; continue; }
    const heading = /^(#{1,6})\\s+(.+)$/.exec(line);
    if (heading !== null) {
      html += '<h' + (heading[1]?.length ?? 1) + ' id="' + esc(slug(heading[2] ?? '')) + '">' + renderInline(heading[2] ?? '') + '</h' + (heading[1]?.length ?? 1) + '>';
      i += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '') {
      paragraph.push(lines[i] ?? '');
      i += 1;
    }
    html += '<p>' + renderInline(paragraph.join(' ')) + '</p>';
  }
  if (options.document === true) {
    return '<!DOCTYPE html>\\n<html lang="en">\\n<head>\\n<meta charset="utf-8">\\n<title>' + esc(options.title ?? 'Untitled') + '</title>\\n</head>\\n<body>\\n' + html + '\\n</body>\\n</html>';
  }
  return html;
}
`;

const CLI_IMPL = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderMarkdown } from './parser.js';

const args = process.argv.slice(2);
let input: string | undefined;
let output: string | undefined;
let title: string | undefined;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i] ?? '';
  if (arg === '-h' || arg === '--help') { process.stdout.write('usage: md2html <input.md> [-o out.html] [--title T]\\n'); process.exit(0); }
  const next = args[i + 1];
  if (arg === '-i' || arg === '--input') { input = next; i += 1; continue; }
  if (arg === '-o' || arg === '--output') { output = next; i += 1; continue; }
  if (arg === '--title') { title = next; i += 1; continue; }
  if (input === undefined) input = arg;
}
if (input === undefined) { process.stdout.write('usage: md2html <input.md> [-o out.html] [--title T]\\n'); process.exit(0); }
const html = renderMarkdown(readFileSync(resolve(input), 'utf8'), { document: true, title });
if (output === undefined) process.stdout.write(html);
else writeFileSync(resolve(output), html, 'utf8');
`;

/** 轻量门禁（离线、确定性）：用白名单内的 sh 验证产物文件存在，焦点在编排闭环。 */
const CHEAP_GATES = ['git --version', 'sh -c "test -f src/parser.ts"'];

describe('e2e: md2html unattended loop (deterministic, no LLM)', () => {
  it('init → members → 3 contracts → dev output → gates → approve → merge', async () => {
    const fixture = await makeFixture('e2e-md2html');
    await seedRemote(fixture, [
      { id: 'MD2HTML-1', title: 'Implement inline Markdown rendering', touches: ['src', 'tests'] },
      { id: 'MD2HTML-2', title: 'Implement block-level Markdown rendering', touches: ['src', 'tests'] },
      { id: 'MD2HTML-3', title: 'Complete CLI behaviour + integration coverage', touches: ['src', 'tests'] },
    ]);

    const service = await AutopilotService.create(
      testOptions(fixture, {
        remote: { url: fixture.remotePath, sshKeyEnv: 'AUTOPILOT_TEST_GIT_KEY', platform: 'generic' },
        gates: { commands: CHEAP_GATES, requireCiGreen: false, timeoutMinutes: 1 },
      }),
    );
    try {
      const init = await service.initAutopilot('md2html-team');
      const team = service.teamView(init.teamId);
      expect(team.members).toHaveLength(1);
      expect(team.members[0]?.role).toBe('leader');

      const dev = await service.addMember({ teamId: team.id, role: 'developer' });
      const reviewer = await service.addMember({ teamId: team.id, role: 'reviewer' });

      const jobs: Array<{ id: string; title: string; file: string; content: string; msg: string }> = [
        { id: 'MD2HTML-1', title: 'inline rendering', file: 'src/parser.ts', content: PARSER_IMPL + '\\n// [inline]\\n', msg: 'feat(parser): inline rendering' },
        { id: 'MD2HTML-2', title: 'block-level rendering', file: 'src/parser.ts', content: PARSER_IMPL + '\\n// [block]\\n', msg: 'feat(parser): block rendering' },
        { id: 'MD2HTML-3', title: 'CLI + coverage', file: 'src/index.ts', content: CLI_IMPL, msg: 'feat(cli): md2html CLI' },
      ];

      for (const job of jobs) {
        const task = await service.assignTask({
          teamId: team.id,
          title: job.title,
          assigneeId: dev.id,
          contractId: job.id,
        });
        expect(task.status).toBe('in_progress');
        commitInWorktree(dev.workspacePath, job.file, job.content, job.msg);
        if (job.id === 'MD2HTML-3') {
          commitInWorktree(dev.workspacePath, 'tests/parser.test.ts', 'import { test } from "node:test";\n', 'test(cli): coverage');
        }
        await service.updateTask({ taskId: task.id, status: 'in_review' });
        const gates = await service.runGatesForTask({ taskId: task.id });
        expect(gates.allPassed).toBe(true);
        const verdict = await service.review({ taskId: task.id, reviewerId: reviewer.id, verdict: 'approve' });
        expect(verdict.merged).toBe(true);
        expect(verdict.task.status).toBe('done');
      }

      const view = service.teamView(team.id);
      expect(view.tasks.every((task) => task.status === 'done')).toBe(true);
      const mainFile = gitTest(['show', 'main:src/parser.ts'], team.repoPath);
      expect(mainFile).toContain('renderMarkdown');
      expect(service.escalations.all).toHaveLength(0);
    } finally {
      await service.dispose();
    }
  }, 60_000);
});
