/**
 * 工单凭据簿 —— 安全硬规则 6 的显式载体：token 唯一权威旁路表。
 *
 * 这是「谁能答这张工单」唯一落盘的地方，绝不进视图 / 投影 / 工具结果（那三类都会
 * 进模型读得到的 session 日志）。answerable 判断（是否还答得动）依赖问卷与升级
 * 状态，留在 service；这里只负责 token 本身的生成与存取。
 */
import { randomBytes } from 'node:crypto';

export class TicketVault {
  private readonly tokens = new Map<string, string>();

  get(id: string): string | undefined {
    return this.tokens.get(id);
  }

  /** 幂等铸 token：已有则返回原值（形如 32 位 hex）。 */
  mint(id: string): string {
    const existing = this.tokens.get(id);
    if (existing !== undefined) return existing;
    const token = randomBytes(16).toString('hex');
    this.tokens.set(id, token);
    return token;
  }

  entries(): Iterable<[string, string]> {
    return this.tokens;
  }

  restore(snapshot: Record<string, string>): void {
    this.tokens.clear();
    for (const [id, token] of Object.entries(snapshot)) this.tokens.set(id, token);
  }

  clear(): void {
    this.tokens.clear();
  }
}