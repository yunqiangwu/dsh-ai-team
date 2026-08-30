# Checklist

## 契约与看板

- [x] `.tasks/TECH-1.md` 存在，frontmatter 含 `id: TECH-1`、`status: pending`、`touches: [src/, tests/]`，正文含四组 Gherkin 场景（单一实现 / 投递状态语义不变 / 脱敏增强 / 文档收口）
- [x] `.tasks/TECH-2.md` 存在，frontmatter 含 `id: TECH-2`、`status: pending`、`touches: [src/, tests/, docs/]`，正文明确「域锁推迟但不空转 + 跳过可见」策略及四组 Gherkin 场景
- [x] TECH-2 契约未引入配置开关 / 严格优先级模式（超出范围清单已写明）
- [x] INT-1..4、PIL-1..2 的 frontmatter `status` 均为 `done`，且除 `status:` 行外无任何其它改动
- [x] `.tasks/_board.md` 与 `regenerateBoard` 对当前 8 张契约的输出逐字节一致（标题行、六列表格按 id 字典序、阻塞清单与已废弃均为 `(none)`、无时间戳）

## 文档修订

- [x] `docs/design-interaction.md` 头部注记②已指向 `.tasks/TECH-1.md` 并标注「未实施」
- [x] `docs/design-interaction.md` §11 第 3 条已改写为已决策略口径并指向 `.tasks/TECH-2.md`
- [x] 头部注记①未被改动
- [x] 未改动 README.md / AGENTS.md / PILOT.md（本变更无配置语义与架构连带）

## 回归

- [x] 本变更未触及 `src/` 下任何文件
- [x] `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 全绿（0 error / 0 warning；14 个测试文件 204 条用例全部通过）
