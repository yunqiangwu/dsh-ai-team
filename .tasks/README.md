# 任务看板规范（唯一真相源）

> **本文件是任务单 frontmatter 字段定义、状态机、域锁规则的唯一真相源。**
> PRD §7.4 只放任务单正文模板（字段规范以本文件为准）；`AGENTS.md` §5 只放 agent 的执行步骤；
> `docs/development-guidelines.md` §9.1 只放本地 main 直接提交的工程约束（worktree / commit / merge），不重复本文件的调度规则。

## 1. 为什么用文件而不是 GitHub Projects / Linear

无人值守场景下，看板必须满足：**git 原生（随提交走）、机器可 diff、无外部服务依赖、提交即同步**。
文件看板天然满足。

- **真相源**：`.tasks/*.md` 的 frontmatter（`status` / `owner` / `depends_on` / `touches`）
- **归档**：已 `done` 的任务由 lead agent 移入 `.tasks/archive/`（`git mv`，frontmatter 不变）——
  只做组织归档，不改状态，仍参与 `depends_on` 解析（见 §3）。看板只展示活跃任务。
- **人类视图**：`.tasks/_board.md`（由 lead agent 在每次状态变更后重新生成，不手工编辑，只含活跃任务）

## 2. frontmatter 字段规范

完整字段集（前 6 项必填，`touches` 决定域锁，**不允许缺项**）：

```yaml
---
id: FN-012                    # 必填。<域>-<序号>，格式见 §4
title: 发布云函数为 MCP Tool   # 必填。动宾短语，不超过 30 字
status: pending               # 必填。枚举见 §3
owner: unassigned             # 必填。agent 标识，未认领时为 unassigned
depends_on: [FN-008]          # 必填（无依赖写 []）。全部为 done 才可派发
touches: [server/domains/mcp/]                      # 必填。预期改动范围 = 域锁依据
forbidden: [AGENTS.md, server/db/schema/]      # 选填。受限区，见 §2.1
---
```

### 2.1 `touches` 与 `forbidden` 的语义

| 字段 | 语义 | 谁用它 |
| --- | --- | --- |
| `touches` | 任务**预期改动**的路径前缀。决定域锁（§5） | lead agent 派发 |
| `forbidden` | **受限区**：落在其中的改动需该域 owner 确认，而非"禁止" | 域锁与 touches 交集判定 |

规则：

1. `touches` 与 `forbidden` **不得有交集**。
   若任务确实必须改动受限区，必须在正文「范围」段显式声明原因与确认该改动的 owner，且**独立提交**、rebase 最新 main 后立即合入。
2. `forbidden` 只写**与本任务 touches 邻近、确实可能被顺手改到**的受限路径。
   与本任务路径无关的高冲突区（如纯前端任务写 `server/db/schema/`）属于噪音，不要写——域锁已经保证不会碰。
3. 路径一律用仓库根相对路径；目录以 `/` 结尾，文件不带。

> 常见错误：`touches: [server/db/]` 同时 `forbidden: [server/db/schema/]` ——后者是前者的子路径，构成交集。
> 正确做法是**收窄 touches 到实际改动的最细路径**（如 `scripts/verify-sqlite/`），而不是靠 forbidden 做减法。

### 2.2 正文结构（必填五段）

`# [<id>] <title>` 之下依次是：`## 背景`（含 PRD 章节引用）→ `## 范围` → `## 验收标准（Gherkin）` → `## 自验证命令` → `## 超出范围`。
验收标准的编写要求见 PRD §7.4.4（必须可由命令或 HTTP 断言判定，禁止"体验良好"类表述）。

## 3. 状态机与枚举

`status` 取且仅取以下 5 个值：

```
pending → in_progress → done
   ↑           │
   └──── needs-human ──（分诊后）──→ pending
                    └──（废弃）──→ cancelled
```

| 值 | 含义 | 由谁改 |
| --- | --- | --- |
| `pending` | 待派发（依赖未满足或域锁占用） | lead agent |
| `in_progress` | 已认领 | 执行 agent（认领时随认领提交一并改） |
| `needs-human` | 触发升级条件，停止推进 | 执行 agent（必须留言说明） |
| `done` | 已合入 main | lead agent（**仅**在合入后） |
| `cancelled` | 废弃。**保留文件不删除**，保持可追溯 | lead agent |

规则：

- `pending → in_progress`：由执行 agent 改 frontmatter `status` + `owner`，与认领提交一起提交。
- `in_progress → needs-human`：触发 `AGENTS.md` §8 任一升级条件；必须在正文留言说明根因。
- `in_progress → done`：**仅**在改动合入 main 后由 lead agent 标记。执行 agent 不得自行标记。
- `cancelled` 任务保留文件，不删除。
- **归档 `done`（组织规则，非状态变更）**：`done` 后由 lead agent 将任务单 `git mv` 到
  `.tasks/archive/<原文件名>`——**frontmatter（含 `status: done`）与正文一字不改**，仅物理归档，
  保持可追溯。归档任务不再显示在看板，但仍被 `validate:docs` 扫描用于 `depends_on` 解析；
  新任务不得 `depends_on` 一个 `done` 任务以外的新依赖（它已不可再执行）。若历史归档文件
  内容需修订（如补验收证据），就地改归档文件即可，不必迁回顶层。

## 4. 任务编号

`<域>-<序号>`，域代码：

| 域 | 含义 | 域 | 含义 |
| --- | --- | --- | --- |
| `CORE` | 平台内核（脚手架 / 插件内核 / DB 层 / 认证 / 网关 / 类型包） | `FN` | 云函数 |
| `MCP` | MCP Gateway 与 Tool | `DB` | 项目数据库 |
| `ST` | 文件存储 | `DOM` | 项目与域名 |
| `CLI` | 命令行工具 | `FE` | 前端 |
| `RT` | 实时通道（顶层 server / WS 连接 / 通道派发） | `GAME` | GameArcade 游戏应用层（`apps/game/`，ADR-0014；G1~G4 期间曾落平台核心域，GAME-008 起应用层化） |

> **域码新增的时机**：在**该域第一个任务建单的同时**加行，不在 PRD 提到该特性时提前占位。
> 按此规则，M8 应用打包的 `APP` 域（PRD §2.11 / tech-stack §2.8 已规划 `APP-000`）**当前故意不在表内**——
> 建单时才加，避免出现"登记了域却永远没有任务"的幽灵条目（同 `AGENTS.md` §9「文档引用了尚未存在的产物」教训）。

序号规则：

- 域内从 `001` 起递增。
- **`000` 为保留号，仅用于「域内首个任务的前置验证任务」**（如 `DB-000` 是 DB 域开工前的驱动兼容性验证）。
  它语义上排在所有 `001+` 之前，因此不违反递增约定。除此外不得使用 `000`。

## 5. 域锁（并行防冲突的核心机制）

**粒度定义：域 = `touches` 中声明的最细路径。** 不是插件顶层目录。

判定时取两个任务 `touches` 列表的**两两路径前缀比较**：任一路径是另一路径的前缀（或相等）即判定冲突。

例：

| 任务 A touches | 任务 B touches | 判定 |
| --- | --- | --- |
| `server/domains/database/builder/` | `server/domains/database/console-routes.ts` | ✅ 可并行（互不为前缀） |
| `server/domains/database/` | `server/domains/database/builder/` | ❌ 冲突（A 是 B 的前缀） |
| `app/pages/dashboard/` | `app/pages/dashboard/storage/` | ❌ 冲突（A 是 B 的前缀） |

规则：

- `in_progress` 任务的 `touches` 路径即被锁定；新任务与其冲突时，lead **不得派发**，保持在 `pending`。
- 同一时刻同一路径最多 1 个 `in_progress` 任务。
- 冲突而必须同做的（如两个任务都要改 `server/domains/functions/publish/`），用 `depends_on` 串行化，不要并行。

> ⚠️ 这条规则要求 `touches` **写得足够细**。写 `server/domains/database/` 会把整个域锁死，
> 写 `server/domains/database/builder/` 才能让同域不同子模块并行。派发前 lead 应检查这一点。

## 6. lead agent 职责循环

1. 扫描 `depends_on` 全部 `done` 且 `status=pending` 的任务 → 按 §5 检查域锁 → 派发给空闲执行 agent
2. 每次状态变更后重新生成 `_board.md`（状态表 + DAG 进度 + 阻塞清单）
3. 分诊 `needs-human`：能自行澄清的澄清后改回 `pending`；涉及需求矛盾/付费依赖的留给人类
4. 仲裁跨域冲突：后到的任务 rebase，先到先得，禁止并行改同一路径

## 7. 域附加要求

### 7.1 `DB` 域（安全高敏）

项目数据库是安全高敏域（SQL 注入 / 跨项目越权）。涉及 `server/domains/database/` 的任务单，验收标准里**必须包含**：

1. **参数化断言**：生成的 SQL 不含拼接字面量（可由单测捕获并断言）
2. **跨项目越权的反向用例**：e2e 断言项目 A 无法读到项目 B 的数据
3. **标识符白名单校验用例**：非法表名/列名被拒绝且不执行任何 SQL

硬规则见 `docs/development-guidelines.md` §6.1，决策背景见 [ADR-0006](../docs/adr/0006-project-database.md)。

### 7.2 `MCP` 域

涉及 Tool 元数据（`inputSchema`）的任务，必须在 `contracts/` 下登记 Tool/Widget schema 兼容性契约，
由 `pnpm run test:contracts` 校验（质量门之一，见 `AGENTS.md` §3）。

### 7.3 `RT` 域（实时通道，安全 + 资源双高敏）

涉及 `server/domains/realtime/` 的任务单，验收标准里**必须包含**四类断言（与 §7.1 同一条思路：
每条都对应一个"跑起来一切正常、出事就是大事"的静默失效面）：

1. **订阅授权反向用例**：持有效票据订阅他人 / 他项目 channel 必须被拒，且**拒绝响应不得泄露该 channel 是否存在**
   （防枚举；对应越权）
2. **票据单次有效**：同一 `ticket` 第二次握手必须失败；重放用例是正向用例之外的独立一条
   （对应凭据重放）
3. **背压不吞进程**：订阅后不读取数据的慢客户端，出站缓冲达硬上限即被主动断开，且持续注入下 RSS 不单调上涨
   （对应资源耗尽——这一条不测，最先倒下的是整个宿主进程，不是那个客户端）
4. **发布不踢人**：发布新版本后既有连接不得收到 close，且下一条上行由新版本处理
   （对应 `docs/agent-deploy-platform-prd.md` §3.2.9 硬约束 1；违反的代价不是安全而是**正确性**，
   且只在"发布的那一刻"暴露，所以必须是常备门禁而非临时用例）

**附加**：访问日志与错误信息中 `ticket` 必须脱敏（携带方式见 PRD §2.12.5 步 3——走 `Sec-WebSocket-Protocol` 而非 query，
脱敏清单见 `docs/development-guidelines.md` §7）。

> 这四条**尚未进 `scripts/validate-docs.py` 的自动校验**（该校验目前只对 `DB-` 前缀任务单检查关键词，
> 且为警告级）。是否把 `RT-` 加进去属脚本改动，需要一个任务号承接——先登记在此，不留幽灵门禁。
