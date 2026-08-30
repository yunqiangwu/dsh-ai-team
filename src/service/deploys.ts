/**
 * 部署域的运行期容器（Phase 2 拆分）：把 `deploys` 历史、上次部署基线 SHA 与
 * 一次部署的执行入账从 AutopilotService 中移出。推进判定与团队侧副作用（metrics /
 * 升级 / 通知）仍留在 service.ts —— 本模块不 import AutopilotService，依赖单向。
 */
import { runDeploy } from '../deploy.js';
import { resolveRef } from '../git.js';
import type { DeployView } from '../view.js';
import type { SecretRedactor } from '../secrets.js';

export const TASKS_DIR = '.tasks';

/** 上次部署点以来的变更是否纯 `.tasks/` 文档（这种提交不该触发部署）。 */
export function isTasksOnlyChange(files: readonly string[], tasksDir: string = TASKS_DIR): boolean {
  return files.length > 0 && files.every((file) => file.startsWith(`${tasksDir}/`));
}

/**
 * 一次部署的可变输入。全部由调用方（service）从当前 options 现读、现传：
 * 运行期配置（setRuntimeConfig）能改 deploy 块，这里不缓存配置以免用上过期值。
 */
export interface DeployRunConfig {
  command: string;
  healthCheckUrl?: string | undefined;
  rollbackCommand?: string | undefined;
  secretsEnv: readonly string[];
  allowlist: readonly string[];
  fetchFn?: typeof fetch | undefined;
  backoffMs?: number | undefined;
}

export interface DeployRunTarget {
  repoPath: string;
  branch: string;
  teamId: string;
}

export class DeployCoordinator {
  readonly deploys: DeployView[] = [];
  lastDeployBaseSha: string | null = null;

  constructor(private readonly redactor: SecretRedactor) {}

  restore(snapshot: { deploys: DeployView[]; lastDeployBaseSha: string | null }): void {
    this.deploys.length = 0;
    this.deploys.push(...snapshot.deploys);
    this.lastDeployBaseSha = snapshot.lastDeployBaseSha;
  }

  /** 执行一次部署并维护部署域状态；团队侧副作用（metrics / 升级）由调用方处理。 */
  async run(config: DeployRunConfig, target: DeployRunTarget): Promise<DeployView> {
    const view = await runDeploy({
      command: config.command,
      healthCheckUrl: config.healthCheckUrl,
      rollbackCommand: config.rollbackCommand,
      secretsEnv: config.secretsEnv,
      allowlist: config.allowlist,
      redactor: this.redactor,
      cwd: target.repoPath,
      branch: target.branch,
      ...(config.fetchFn !== undefined ? { fetchFn: config.fetchFn } : {}),
      ...(config.backoffMs !== undefined ? { backoffMs: config.backoffMs } : {}),
    });
    // 落团队归属（TECH-4）：runDeploy 不知道团队是谁，这里盖上再入账 ——
    // 调用方（工具 / 测试）与投影看到的是同一份带归属的记录。
    view.teamId = target.teamId;
    this.deploys.push(view);
    if (view.status === 'healthy') {
      this.lastDeployBaseSha = await resolveRef(target.repoPath, target.branch);
    }
    return view;
  }
}