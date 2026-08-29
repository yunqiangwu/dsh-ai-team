/**
 * GitHub REST 适配层（pr_sync 的远端侧）。
 *
 * 只做两件事：为任务分支创建/更新 PR，以及查询某个 commit 的 CI 检查状态。
 * 抽成独立模块是为了让 service.ts 只关心协作编排，不掺 HTTP 细节。
 *
 * 安全约定：token 由调用方从环境变量名解析后传入，本模块只把它放进请求头，
 * 绝不落盘、绝不参与日志（调用方负责把 token 注册进 SecretRedactor）。
 */
import type { CiStatus } from './view.js';

/** GitHub REST API 根地址。 */
const API_ROOT = 'https://api.github.com';

/** 单次请求超时（毫秒）。CI/PR 查询不能拖住守护循环。 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * 从远端 URL 解析 `owner/repo`。
 * 兼容 `git@github.com:org/repo.git`、`https://github.com/org/repo.git`
 * 以及不带 `.git` 后缀的写法。
 */
export function githubRepoSlug(remoteUrl: string): string {
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remoteUrl);
  if (match === null) throw new Error(`cannot parse github owner/repo from remote url "${remoteUrl}"`);
  return match[1] ?? '';
}

export interface UpsertPullRequestInput {
  /** GitHub API token（由调用方从环境变量解析）。 */
  token: string;
  /** `owner/repo`。 */
  slug: string;
  title: string;
  body: string;
  /** 源分支（任务分支）。 */
  head: string;
  /** 目标分支（基础分支）。 */
  base: string;
  /** 可注入的 fetch，便于测试。 */
  fetchFn?: typeof fetch | undefined;
}

/**
 * PR 创建结果。区分「调用成功」与「拿到了 URL」两件事：
 * - `created: true` 表示 GitHub 接受了请求，url 正常应该有值；
 * - `created: false` 表示被拒绝（最典型是 422 —— PR 已经存在），此时调用方
 *   应当保留上一次的 URL，而不是把它当成错误抛给模型。
 */
export type PullRequestUpsert = { created: true; url: string | null } | { created: false };

/** 创建 PR。网络异常照常抛出，由调用方决定是否降级。 */
export async function upsertPullRequest(input: UpsertPullRequestInput): Promise<PullRequestUpsert> {
  const fetchImpl = input.fetchFn ?? fetch;
  const response = await fetchImpl(`${API_ROOT}/repos/${input.slug}/pulls`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return { created: false };
  const payload = (await response.json()) as { html_url?: string };
  return { created: true, url: payload.html_url ?? null };
}

export interface CheckRunStatusInput {
  /** 可选：私有仓库需要鉴权，公开仓库可省略。 */
  token?: string | undefined;
  slug: string;
  /** 待查询的 commit sha。 */
  sha: string;
  fetchFn?: typeof fetch | undefined;
}

/**
 * 汇总某个 commit 的 check-runs 状态。
 *
 * 判定顺序：查不到 → unknown；无检查项或有未完成的 → pending；
 * 全部为 success / neutral / skipped → success；否则 failure。
 */
export async function checkRunStatus(input: CheckRunStatusInput): Promise<CiStatus> {
  const fetchImpl = input.fetchFn ?? fetch;
  const response = await fetchImpl(`${API_ROOT}/repos/${input.slug}/commits/${input.sha}/check-runs`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(input.token !== undefined ? { authorization: `Bearer ${input.token}` } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return 'unknown';
  const payload = (await response.json()) as { check_runs?: { conclusion: string | null; status: string }[] };
  const runs = payload.check_runs ?? [];
  if (runs.length === 0) return 'pending';
  if (runs.some((run) => run.status !== 'completed')) return 'pending';
  const allGreen = runs.every(
    (run) => run.conclusion === 'success' || run.conclusion === 'neutral' || run.conclusion === 'skipped',
  );
  return allGreen ? 'success' : 'failure';
}
