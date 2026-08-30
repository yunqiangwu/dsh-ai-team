# Tasks

- [x] Task 1: 同步既有契约状态——INT-1..4、PIL-1..2 的 frontmatter `status: pending` 改为 `done`（仅改 `status:` 一行，其余逐字节保留）
- [x] Task 2: 新建 `.tasks/TECH-1.md` 契约（webhook 投递两份实现合并）
  - [x] frontmatter：`id: TECH-1` / `title` / `status: pending` / `touches: [src/, tests/]`（目录粒度，规避 `distinctDomainCount` 前缀折叠的跨域误伤——见 INT-1「前置条件」）
  - [x] 背景：引用 design-interaction.md 头部注记②与 `postHumanWebhook` 注释里的「后续搬家工作」声明
  - [x] 验收标准：按 spec.md「Requirement: 任务契约 TECH-1」的四组场景写 Gherkin（单一实现 / 投递状态语义不变 / 脱敏增强 / 文档收口）
  - [x] 超出范围：不动问卷侧载荷语义、不引入 webhook 重试
- [x] Task 3: 新建 `.tasks/TECH-2.md` 契约（优先级 × 域锁调度策略）
  - [x] frontmatter：`id: TECH-2` / `title` / `status: pending` / `touches: [src/, tests/, docs/]`（与 TECH-1 无 `depends_on`；域锁天然把两单串行化）
  - [x] 背景：引用 design-interaction.md §11 未决问题 #3 与 `dispatch` 现状（`toSorted` 稳定排序 + `touchesOverlap` 静默 `continue`）
  - [x] 验收标准：按 spec.md「Requirement: 任务契约 TECH-2」的四组场景写 Gherkin（派别的 / 跳过可见 / 策略入档 / 回归不变）
  - [x] 超出范围：不加调度策略配置开关、不引入严格优先级模式、不改 `touchesOverlap` 判定本身
- [x] Task 4: 新建 `.tasks/_board.md` 任务看板
  - [x] 按 `regenerateBoard`（src/team.ts）的输出格式手写：标题行、六列表格（8 张契约按 id 字典序：INT-1..4 → PIL-1..2 → TECH-1..2）、`## 阻塞清单` 与 `## 已废弃` 各一条 `(none)`
  - [x] done 行为 INT-1..4 / PIL-1..2（Task 1 已同步），pending 行为 TECH-1 / TECH-2
- [x] Task 5: 修订 `docs/design-interaction.md`
  - [x] 头部注记②追加「合并已立契约 `.tasks/TECH-1.md`（未实施）」
  - [x] §11 未决问题 #3 改写为已决口径（域锁推迟但不空转 + 跳过可见），实施指向 `.tasks/TECH-2.md`
  - [x] 注记①不动
- [x] Task 6: 验证
  - [x] `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 四件套全绿（顺序要求见 AGENTS.md「测试约定」；本变更无源码改动，红即说明改错了文件）
  - [x] 用 node 快速核对：`parseTaskContract` 能解析 TECH-1 / TECH-2，`regenerateBoard` 对 8 张契约的输出与手写 `_board.md` 逐字节一致

# Task Dependencies

- Task 4 依赖 Task 1（看板的 done 状态以 frontmatter 同步为前提）
- Task 2、Task 3 相互独立，可并行
- Task 5 独立
- Task 6 收尾
