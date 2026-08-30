/**
 * 团队集合的运行期容器（Phase 4 第一步：状态容器，不动方法体）。
 *
 * 继承 Map —— 天然获得全部集合方法，service 里把 `this.teams` 当裸 Map 用的调用点
 * 与纯函数（`foundTeamId(taskId, this.teams)` 等）零改动；额外承载 `activeTeamId`
 * 与序列化 / 恢复。真正把团队命令语义（createTeam / addMember …）迁出留待后续
 * 里程碑。
 */
import type { TeamRecord } from './state.js';

export interface TeamStoreSnapshot {
  teams: TeamRecord[];
  activeTeamId: string | null;
}

export class TeamStore extends Map<string, TeamRecord> {
  activeTeamId: string | null = null;

  /** 清空全部团队并重置活动团队。 */
  override clear(): void {
    super.clear();
    this.activeTeamId = null;
  }

  all(): TeamRecord[] {
    return [...this.values()];
  }

  restore(snapshot: TeamStoreSnapshot): void {
    super.clear();
    for (const team of snapshot.teams) this.set(team.id, team);
    this.activeTeamId = snapshot.activeTeamId;
  }
}