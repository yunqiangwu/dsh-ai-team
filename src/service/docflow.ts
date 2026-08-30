/**
 * 人工决策回路的**文档审批链**（docs/design-interaction.md §4）与问卷记录的
 * 纯操作（§3.1）：draft 区读写、审批钉哈希、sha256 比对升格、答案的结构化回写。
 * 从 AutopilotService 搬出来是因为这一块是「纯逻辑却塞在编排文件里」的最大一块 ——
 * 搬出后可以脱离 git 工作区与守护循环单测（tests/test-service-modules.ts）。
 *
 * 分工（与 `service/report.ts`、`service/daemon.ts` 同一条约定）：这里只有纯函数
 * 与显式注入；`changed()` / 快照推送 / 投递（邮件 webhook）/ 等待唤醒这些副作用
 * 留在 service.ts，通过 {@link DocFlowDeps} 进来。`ask_human` / `answer_questionnaire`
 * 两个交互后端也留在 service.ts —— 它们与等待器、通知服务器、停机逻辑耦合。
 */
import { access, rm } from 'node:fs/promises';
import { join, relative as pathRelative } from 'node:path';
import { commitAll } from '../git.js';
import {
  assertRepoRelative,
  bumpVersion,
  defaultFormalPath,
  draftPathOfFormal,
  hashBody,
  insertSectionNotes,
  isDraftPath,
  listDocs,
  readDoc,
  repoFile,
  writeDoc,
  type DocEntry,
  type DocMeta,
  type DocStatus,
} from '../docdraft.js';
import {
  decisionNotes,
  newApprovalCode,
  questionnaireViewOf,
  type QuestionnaireManager,
  type QuestionnaireRecord,
} from '../questionnaire.js';
import { classifyForbiddenFiles, type ForbiddenRule } from '../profile.js';
import type { SecretRedactor } from '../secrets.js';
import { appendTaskNote, renderTaskNote } from '../team.js';
import type { Question, QuestionBinding, QuestionOption, QuestionnaireStatus, QuestionnaireView, TeamPhase } from '../view.js';
import { oneLine, requireTeamMember, TASKS_DIR, teamPhase, type TaskRecord, type TeamRecord } from './state.js';

/**
 * 审批问卷里那道「批 / 不批」题的保留名。工单答复与 `doc_approve` 都按它取决策，
 * 所以组长即使自己写了选择题也不能换个名字让流程认不出来。
 */
export const APPROVAL_QUESTION = 'decision';

/**
 * approval 问卷必须有一道明确的批/不批题 —— 没有它，答卷收上来也不知道人到底批没批。
 *
 * `defaultValue` 刻意是 **reject**：interactive 问卷超时会按默认方案继续（§3.2），
 * 默认批准等于让「没人应答」变成一次自动批准。
 */
export function withApprovalQuestion(questions: Question[]): Question[] {
  if (questions.some((question) => question.name === APPROVAL_QUESTION)) return questions;
  const options: QuestionOption[] = [
    {
      value: 'approve',
      label: '批准：升格进正式区，团队照它开工',
      impact: '这些文档立刻成为后续所有任务的验收依据',
      // 故意不给 recommended：工单页会预勾 recommended 项，一张预勾着「批准」的单
      // 等价于「闭着眼睛点提交就授权了」—— §8-10 要防的正是这个。预选项由
      // defaultValue 提供，也就是那个更保守的答案。
      recommended: false,
    },
    {
      value: 'reject',
      label: '不批准：退回继续改草稿',
      impact: '阶段回到 intake，团队不开工',
      recommended: false,
    },
  ];
  return [
    ...questions,
    {
      name: APPROVAL_QUESTION,
      label: '这批文档是否批准升格为正式文档？',
      type: 'select' as const,
      options,
      required: true,
      defaultValue: 'reject',
    },
  ];
}

/** 答案回写的落点报告：写到了哪个文件、绑定的章节有没有真的匹配上。 */
export interface WriteBack {
  writtenTo: string | null;
  sectionMatched: boolean | null;
}

/** 一次 `ask_human` 的完整结果：问卷本身 + 答案 + 答案落到了哪儿。 */
export interface AskHumanResult {
  questionnaire: QuestionnaireView;
  /** async 模式恒为 `open`；interactive 为 `answered` / `expired` / `cancelled`。 */
  status: QuestionnaireStatus;
  /** 人给出的答案。interactive 超时时回落各题默认值（并如实标 `expired`）。 */
  answers: Record<string, string>;
  /** 答案回写到的文件（null = 没有绑定，或没人真的作答）。 */
  writtenTo: string | null;
  /** 绑定的文档章节是否真的匹配上（没匹配上会追加到文末并如实报 false）。 */
  sectionMatched: boolean | null;
}

/** 一次审批的结果。 */
export interface PromoteResult {
  promoted: { draft: string; formal: string; version: string }[];
  phase: TeamPhase;
  approvedBy: string;
}

/**
 * 文档审批链的显式依赖。全部是「service 已有的能力」的引用，不引入新的可变状态；
 * 未知团队 / 成员的错误文案仍以 service 与 state.ts 为唯一出处。
 */
export interface DocFlowDeps {
  /** docs 目录约定（Config）。 */
  docs: { draftDir: string; formalDir: string };
  /** 生效禁区规则：画像自身规则 + 被强制为 block 的 security.forbiddenPaths。 */
  forbiddenRules: readonly ForbiddenRule[];
  redactor: SecretRedactor;
  questionnaires: QuestionnaireManager;
  /** 未知团队即抛（文案唯一出处是 service.teamOf）。 */
  teamOf: (teamId: string) => TeamRecord;
  /** 任务查找（含跨团队）；找不到返回 null，不抛。 */
  tryFindTask: (taskId: string) => { team: TeamRecord; task: TaskRecord } | null;
  /** 提交 .tasks/ 区（任务绑定决策留言的落盘与提交）。 */
  commitTasksDir: (team: TeamRecord, message: string) => Promise<void>;
  /** 内部阶段推进（不经过 `autopilot_phase` 那个裸开关）。 */
  applyPhase: (team: TeamRecord, phase: TeamPhase) => void;
  /** 重开审批问卷后的投递通道（邮件 + webhook，尽力而为）。 */
  notifyQuestionnaire: (record: QuestionnaireRecord) => Promise<{ ticketUrl: string | null; mailDelivered: boolean }>;
}

/** draft 区（AI 唯一可写的文档区）的相对与绝对路径。 */
export function draftRoot(deps: DocFlowDeps, team: TeamRecord): { relative: string; absolute: string } {
  const relative = assertRepoRelative(deps.docs.draftDir, 'docs.draftDir');
  return { relative, absolute: repoFile(team.repoPath, relative) };
}

/** draft 区里可能进入审批的草稿：`draft` 与 `pending-approval`。 */
export async function pendingDrafts(deps: DocFlowDeps, team: TeamRecord): Promise<DocEntry[]> {
  const root = draftRoot(deps, team);
  const entries = await listDocs(root.absolute, root.relative);
  return entries.filter(
    (entry) => entry.doc.meta.status === 'draft' || entry.doc.meta.status === 'pending-approval',
  );
}

/**
 * 提交文档改动。draft 区与正式区都要提交，而且必须**同一次**提交：分两次会让
 * 「草稿已删、正式那边还没落地」的中间状态出现在仓库历史里。
 *
 * 不存在的目录不能当 pathspec —— `git add -A -- <不存在的目录>` 是 fatal，
 * 会把同批里另一侧的改动一起吞掉。所以先探一次，只提交存在的那些。
 */
export async function commitDocs(deps: DocFlowDeps, team: TeamRecord, message: string): Promise<void> {
  const existing: string[] = [];
  for (const dir of new Set([deps.docs.draftDir, deps.docs.formalDir])) {
    const relative = assertRepoRelative(dir, 'docs 目录');
    if (await access(repoFile(team.repoPath, relative)).then(() => true, () => false)) existing.push(relative);
  }
  if (existing.length === 0) return;
  await commitAll(team.repoPath, existing, message).catch(() => {});
}

/**
 * 把 draft 区里所有草稿退回可编辑态（`draft`）并重新钉住正文哈希。
 * 被拒的开工包、以及「等人批的时候内容又变了」的审批都走这里。
 */
export async function resetDraftsToEditable(deps: DocFlowDeps, team: TeamRecord): Promise<void> {
  let touched = false;
  for (const entry of await pendingDrafts(deps, team)) {
    if (entry.doc.meta.status !== 'pending-approval') continue;
    touched = true;
    await writeDoc(
      entry.absolutePath,
      { ...entry.doc.meta, status: 'draft', sha256: hashBody(entry.doc.body) },
      entry.doc.body,
    );
  }
  if (touched) await commitDocs(deps, team, 'docs: drafts back to editable after approval');
}

/**
 * 作废这个团队所有还在等人批的问卷：取消 + 抹掉审批码。
 *
 * 存在的理由：草稿被改过之后，先前发给人的那个码覆盖的已经不是盘上的内容了。
 * 与其让「批 A 合 B」有机会发生，不如直接把码作废，让组长重新问一次。
 */
export function invalidateApprovals(deps: DocFlowDeps, team: TeamRecord): string[] {
  const cancelled: string[] = [];
  for (const record of deps.questionnaires.open) {
    if (record.teamId !== team.id || record.kind !== 'approval') continue;
    deps.questionnaires.cancel(record.id);
    deps.questionnaires.consumeApprovalCode(record.id);
    cancelled.push(record.id);
  }
  return cancelled;
}

/**
 * 答案落地的位置在**提问时**就要校验（§3.4）：文档绑定必须落在 draft 区
 *（正式文档对所有角色只读，§4.1），任务绑定必须是看板上的契约。
 * 等答完了才发现无处可去，等于让人白答一次。
 */
export function assertBindingWritable(
  deps: DocFlowDeps,
  team: TeamRecord,
  binding: QuestionBinding | null,
): QuestionBinding | null {
  if (binding === null) return null;
  if (binding.type === 'task') {
    const found = deps.tryFindTask(binding.contractId);
    if (found === null) {
      throw new Error(
        `binding contract "${binding.contractId}" is not on the board (team "${team.name}"); bind a draft document instead, or ask without a binding`,
      );
    }
    return binding;
  }
  const relative = assertRepoRelative(binding.path, 'binding.path');
  if (!isDraftPath(relative, draftRoot(deps, team).relative)) {
    throw new Error(
      `binding.path "${binding.path}" is outside the draft area ${draftRoot(deps, team).relative}/ — accepted documents are read-only for every role (§4.1). Draft the change under ${draftRoot(deps, team).relative}/ and let doc_approve move it.`,
    );
  }
  return { ...binding, path: relative };
}

/**
 * 交给调用方的答案：答完的用真答案；interactive 超时后按组长给的默认方案继续
 * （§3.2 的兜底），但**不写进文档** —— 没人做过的决策不该留下一条 `[decision]`。
 */
export function effectiveAnswers(record: QuestionnaireRecord): Record<string, string> {
  const out: Record<string, string> = {};
  for (const question of record.questions) {
    const answer = record.answers[question.name];
    if (answer !== undefined && answer.value !== '') out[question.name] = answer.value;
    else if (record.status === 'expired' && question.defaultValue !== '') out[question.name] = question.defaultValue;
  }
  return out;
}

/** `ask_human` 的返回组装（纯函数）：问卷视图 + 答案 + 回写落点。 */
export function questionnaireResult(record: QuestionnaireRecord, writeBack: WriteBack): AskHumanResult {
  return {
    questionnaire: questionnaireViewOf(record),
    status: record.status,
    answers: effectiveAnswers(record),
    ...writeBack,
  };
}

/**
 * 把开工包标成「等人批」，并钉住每份草稿此刻的正文哈希。
 * @returns 被标的草稿
 */
export async function stampForApproval(deps: DocFlowDeps, team: TeamRecord, title: string): Promise<DocEntry[]> {
  const drafts = await pendingDrafts(deps, team);
  if (drafts.length === 0) {
    throw new Error(
      `nothing to approve: ${draftRoot(deps, team).relative}/ has no draft documents. Write the kickoff bundle with doc_write first (§4.3) — asking for approval of an empty bundle would be a claim with nothing behind it.`,
    );
  }
  for (const entry of drafts) {
    await writeDoc(
      entry.absolutePath,
      { ...entry.doc.meta, status: 'pending-approval', sha256: hashBody(entry.doc.body) },
      entry.doc.body,
    );
  }
  await commitDocs(deps, team, `docs: kickoff bundle pending approval (${oneLine(title)})`);
  // 标完就是「开工包等人批」了：让阶段跟着这个事实走，组长不必自己 setPhase 越过去。
  if (teamPhase(team) === 'intake') deps.applyPhase(team, 'kickoff_pending_approval');
  return drafts;
}

/**
 * 答案的结构化回写（§3.4）：一条带时间戳的 `[decision]` 跟着代码进 git，
 * 而不是只活在 `state.json` 里。半年后读 PRD 的人要能看到这个数是谁定的。
 */
export async function writeBackAnswers(deps: DocFlowDeps, team: TeamRecord, record: QuestionnaireRecord): Promise<WriteBack> {
  const notes = decisionNotes(record);
  const binding = record.binding;
  if (notes.length === 0 || binding === null) return { writtenTo: null, sectionMatched: null };
  if (binding.type === 'task') {
    const found = deps.tryFindTask(binding.contractId);
    if (found === null || found.task.contractId === null) return { writtenTo: null, sectionMatched: null };
    const path = contractPathOf(found.team, found.task);
    await appendTaskNote(path, notes.join('\n')).catch(() => {});
    await deps.commitTasksDir(found.team, `tasks: human decision on ${found.task.contractId}`);
    // 报告相对路径：与文档绑定同一口径，别让模型看见一个绝对临时目录。
    const back = pathRelative(found.team.repoPath, path);
    return { writtenTo: back.startsWith('..') ? path : back.replace(/\\/g, '/'), sectionMatched: null };
  }
  const relativePath = assertRepoRelative(binding.path, 'binding.path');
  const absolute = repoFile(team.repoPath, relativePath);
  const doc = await readDoc(absolute, relativePath);
  const { body, matched } = insertSectionNotes(doc?.body ?? '', binding.section, notes);
  const meta: DocMeta =
    doc?.meta ??
    { path: relativePath, status: 'draft', version: '1.0', sha256: '', approvedBy: null, approvedAt: null };
  await writeDoc(absolute, { ...meta, path: relativePath, sha256: hashBody(body) }, body);
  await commitDocs(deps, team, `docs: human decision on ${relativePath}`);
  return { writtenTo: relativePath, sectionMatched: matched };
}

/** 契约文件路径计算（与 service 的 contractPathFor 同一逻辑，落点与兜底一致）。 */
function contractPathOf(team: TeamRecord, task: TaskRecord): string {
  return task.contractPath ?? join(team.repoPath, TASKS_DIR, `${task.contractId ?? task.id}.md`);
}

/**
 * 升格开工包（§4.2 / §4.3）：一次批完、一次提交。三道不可伪造性：
 *
 * 1. 审批码只活在服务侧记录与工单页 / 邮件里，全量快照里没有（见 schema.ts）；
 * 2. 落盘前重新比对 `sha256` 与盘上正文，不一致即拒批、作废并重开问卷 ——
 *    一次审批只覆盖人当时看到的那一份内容，眼看的 diff 挡不住事后被改掉的一行；
 * 3. 目标路径过 `security.forbiddenPaths`：任何答复都解锁不了 `LICENSE`（§8-8）。
 */
export async function promoteDrafts(
  deps: DocFlowDeps,
  team: TeamRecord,
  record: QuestionnaireRecord | null,
  approvedBy: string,
): Promise<PromoteResult> {
  const { relative: draftDir } = draftRoot(deps, team);
  const drafts = (await pendingDrafts(deps, team)).filter((entry) => entry.doc.meta.status === 'pending-approval');
  if (drafts.length === 0) {
    throw new Error(
      `nothing pending approval under ${draftDir}/ — ask with ask_human(kind: "approval") first so the bundle gets stamped`,
    );
  }
  const drifted = drafts.filter((entry) => entry.doc.meta.sha256 !== hashBody(entry.doc.body));
  if (drifted.length > 0) {
    const paths = drifted.map((entry) => entry.path).join(', ');
    await resetDraftsToEditable(deps, team);
    const cancelled = invalidateApprovals(deps, team);
    const reopened = await reopenApprovalQuestionnaire(deps, team, record, paths);
    // 重开的那张单要覆盖「此刻盘上的内容」：不重新钉哈希，人拿着新码来批还是会撞
    // "nothing pending approval"，整条审批链就死锁在组长身上。
    await stampForApproval(deps, team, `重开审批：${oneLine(paths)}`);
    throw new Error(
      `approval refused: ${paths} changed after the code was issued (批 A 合 B 防护). ` +
        `审批码 ${cancelled.join(', ') || '(本次会话批准)'} 已作废，已重开问卷 ${reopened} 请人重读后重批。`,
    );
  }
  const rules = deps.forbiddenRules;
  const notes = record === null ? [] : decisionNotes(record);
  const provenance = ['', renderTaskNote('approved', Date.now(), `by ${approvedBy}`), ''];
  const promoted: PromoteResult['promoted'] = [];
  for (const entry of drafts) {
    const formalRelative = defaultFormalPath(entry.path, draftDir, assertRepoRelative(deps.docs.formalDir, 'docs.formalDir'));
    const { blocks } = classifyForbiddenFiles([formalRelative], rules);
    if (blocks.length > 0) {
      throw new Error(
        `cannot promote to ${blocks.join(', ')}: security.forbiddenPaths is a configuration boundary, not a gate an approval may cross (§8-8)`,
      );
    }
    const formalAbsolute = repoFile(team.repoPath, formalRelative);
    const existing = await readDoc(formalAbsolute, formalRelative);
    const body = notes.length === 0
      ? `${entry.doc.body.trimEnd()}\n${provenance.join('\n')}`
      : `${entry.doc.body.trimEnd()}\n${notes.join('\n')}${provenance.join('\n')}`;
    const meta: DocMeta = {
      path: formalRelative,
      status: 'accepted',
      // 同一路径被第二次批：版本号递增（§6.5 的 PRD 版本化），git 历史就是变更日志。
      version: existing === null ? entry.doc.meta.version : bumpVersion(existing.meta.version),
      sha256: hashBody(body),
      approvedBy,
      approvedAt: Date.now(),
    };
    await writeDoc(formalAbsolute, meta, body);
    // 只删文件不删目录：draft 区还在，后续 commitDocs 的 pathspec 才不会 fatal。
    await rm(entry.absolutePath, { force: true });
    promoted.push({ draft: entry.path, formal: formalRelative, version: meta.version });
  }
  await commitDocs(deps, team, `docs: promote approved drafts (${approvedBy})`);
  if (teamPhase(team) === 'kickoff_pending_approval') deps.applyPhase(team, 'scaffolding');
  return { promoted, phase: teamPhase(team), approvedBy };
}

/**
 * 正式区的 drift 检测（TECH-3 / §11-2）：`accepted` 文档的正文与批准时钉住的
 * sha256 不符即为漂移。判定口径是「集成检出里的字节与批准哈希不符」，不关心
 * 改动怎么进来的 —— 人直接编辑检出、或经远端合入都一样命中。
 */
export async function findAcceptedDrift(deps: DocFlowDeps, team: TeamRecord): Promise<DocEntry[]> {
  const formalDir = assertRepoRelative(deps.docs.formalDir, 'docs.formalDir');
  const entries = await listDocs(repoFile(team.repoPath, formalDir), formalDir);
  return entries.filter(
    (entry) => entry.doc.meta.status === 'accepted' && entry.doc.meta.sha256 !== hashBody(entry.doc.body),
  );
}

/**
 * drift 退回重批（TECH-3 / §11-2）：被改动的正式文档整体退回 draft 区同相对
 * 路径并钉住新哈希（`pending-approval`，不是 `draft` —— 退回就是为了重批，
 * 直接落待批态，人拿新码来批不会撞 `nothing pending approval`），正式区删除，
 * 两侧同一次提交；随即重开一张 approval 问卷。
 *
 * 幂等免费：退回后正式区已无该文档，下一拍扫描不再命中。
 */
export async function revertAcceptedDrift(
  deps: DocFlowDeps,
  team: TeamRecord,
  drifted: DocEntry[],
): Promise<{ reverted: string[]; questionnaireId: string }> {
  const { relative: draftDir } = draftRoot(deps, team);
  const formalDir = assertRepoRelative(deps.docs.formalDir, 'docs.formalDir');
  const reverted: string[] = [];
  for (const entry of drifted) {
    const draftRelative = draftPathOfFormal(entry.path, draftDir, formalDir);
    await writeDoc(
      repoFile(team.repoPath, draftRelative),
      {
        path: draftRelative,
        status: 'pending-approval',
        // 重批落回正式区时 formal 侧已删，version 就是这里给的值 —— 递增一格，
        // git 历史读起来才是「这份文档改过一版」，而不是原地覆盖 1.0。
        version: bumpVersion(entry.doc.meta.version),
        sha256: hashBody(entry.doc.body),
        approvedBy: null,
        approvedAt: null,
      },
      entry.doc.body,
    );
    await rm(entry.absolutePath, { force: true });
    reverted.push(entry.path);
  }
  await commitDocs(deps, team, `docs: accepted doc drifted, reverted to drafts (${oneLine(reverted.join(', '))})`);
  const paths = reverted.join(', ');
  const questionnaireId = await reopenApprovalQuestionnaire(
    deps,
    team,
    null,
    paths,
    `重开审批：${paths} 在批准后被改动`,
  );
  return { reverted, questionnaireId };
}

/**
 * 比对失败 / drift 退回后重开的那份审批问卷（§4.2 + §11-2）：新码、新快照。
 * `stale` 为 null 表示没有对应的旧问卷（TECH-3 的 drift 退回场景）。
 */
export async function reopenApprovalQuestionnaire(
  deps: DocFlowDeps,
  team: TeamRecord,
  stale: QuestionnaireRecord | null,
  driftedPaths: string,
  title = `重开审批：${driftedPaths} 在上一码发出后被改动`,
): Promise<string> {
  const record = deps.questionnaires.create({
    teamId: team.id,
    kind: 'approval',
    title,
    mode: stale?.mode ?? 'async',
    questions: withApprovalQuestion(stale === null ? [] : stale.questions.filter((q) => q.name !== APPROVAL_QUESTION)),
    binding: stale?.binding ?? null,
    taskId: stale?.taskId ?? null,
    timeoutMs: 0,
    approvalCode: newApprovalCode(),
  });
  const delivery = await deps.notifyQuestionnaire(record);
  deps.questionnaires.markDelivery(record.id, delivery);
  return record.id;
}

/**
 * `doc_approve` 的主体。两条合法来源（§8-10）：
 *
 * - 人带着工单页 / 邮件里的一次性码在会话里调（`code`）；
 * - 人自己在会话里调（不传 `actorId`，也不传 `code`）。
 *
 * 组长或 developer 带着 `actorId` 来调一律拒绝 —— 那正是「模型自己伪造审批」的形状。
 * 调用方（service）在成功后负责 `changed()` 与快照推送。
 */
export async function docApprove(deps: DocFlowDeps, input: { teamId: string; code?: string; actorId?: string }): Promise<PromoteResult> {
  const team = deps.teamOf(input.teamId);
  if (input.actorId !== undefined) {
    const actor = requireTeamMember(team, input.actorId);
    throw new Error(
      `${actor.name} (${actor.role}) cannot approve documents: 审批不能由模型自己伪造（§8-10）. Ask with ask_human(kind: "approval") and let a human answer the ticket, or have the human run doc_approve with the one-time code.`,
    );
  }
  const usable = deps.questionnaires.all.filter(
    (record) =>
      record.teamId === team.id &&
      record.kind === 'approval' &&
      record.approvalCode !== null &&
      (record.status === 'open' || record.status === 'answered'),
  );
  const via = input.code === undefined ? usable[0] : usable.find((record) => deps.questionnaires.verifyApprovalCode(record.id, input.code!));
  if (input.code !== undefined && via === undefined) {
    throw new Error(
      `no approval questionnaire in this team matches that code; codes are one-time and die when the drafts change (${usable.length === 0 ? 'none pending' : `pending: ${usable.map((r) => r.id).join(', ')}`})`,
    );
  }
  const result = await promoteDrafts(deps, team, via ?? null, via === undefined ? 'human(会话直批)' : 'human(审批码)');
  if (via !== undefined) deps.questionnaires.consumeApprovalCode(via.id);
  return result;
}

/**
 * `doc_write` 的主体：AI 写文档**只进 draft 区**（§4.1）。
 *
 * 改了正在等人批的草稿会连带作废该团队的审批问卷 —— 悄悄 restamp sha256 是
 * 「批 A 合 B」唯一的通路，宁可让组长重新问一次。调用方在成功后负责 `changed()`。
 */
export async function docWrite(
  deps: DocFlowDeps,
  input: { teamId: string; path: string; body: string },
): Promise<{
  path: string;
  status: DocStatus;
  version: string;
  sha256: string;
  approvalsCancelled: string[];
}> {
  const team = deps.teamOf(input.teamId);
  const relative = assertRepoRelative(input.path, 'path');
  const draftDir = draftRoot(deps, team).relative;
  if (!relative.endsWith('.md')) {
    throw new Error(`doc_write only takes .md paths; got "${relative}"`);
  }
  if (!isDraftPath(relative, draftDir)) {
    throw new Error(
      `refused: "${relative}" is outside the draft area ${draftDir}/ (§4.1 — AI writes drafts, never the formal documents). Write ${draftDir}/<name>.md, then ask for approval; doc_approve is what moves it into place and records who approved which bytes.`,
    );
  }
  const { blocks } = classifyForbiddenFiles([relative], deps.forbiddenRules);
  if (blocks.length > 0) {
    throw new Error(`refused: ${blocks.join(', ')} is in security.forbiddenPaths — the draft area cannot be a side door to a blocked path`);
  }
  const absolute = repoFile(team.repoPath, relative);
  const existing = await readDoc(absolute, relative);
  if (existing?.meta.status === 'accepted') {
    throw new Error(
      `"${relative}" is already accepted; accepted documents are read-only. Write a new draft revision and re-approve it (§4.1).`,
    );
  }
  const body = deps.redactor.redact(input.body);
  const meta: DocMeta = {
    path: relative,
    status: 'draft',
    version: existing?.meta.version ?? '1.0',
    sha256: hashBody(body),
    approvedBy: null,
    approvedAt: null,
  };
  await writeDoc(absolute, meta, body);
  const approvalsCancelled = invalidateApprovals(deps, team);
  if (approvalsCancelled.length > 0) await resetDraftsToEditable(deps, team);
  await commitDocs(deps, team, `docs: draft ${relative}`);
  return { path: relative, status: meta.status, version: meta.version, sha256: meta.sha256, approvalsCancelled };
}
