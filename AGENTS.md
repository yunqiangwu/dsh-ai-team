# AGENTS.md

面向 AI 编码代理的仓库指南。dsh-ai-team 是 DeepSeek Harness（dsh）的插件：喂给它一台裸机、一组以环境变量引用的密钥和一个 git 远端，插件驱动的 AI 团队（leader / developer / reviewer / operator）自主跑完「引导 → 拆任务 → 并行开发 → 质量门 → 审查 → 合并 → 部署 → 迭代」，人只在升级（escalation）时介入。

> 本文件是 human-only 区（默认 `security.forbiddenPaths` 含 `AGENTS.md`），插件自身的 AI 团队不会修改它，只由人维护。

## 命令速查

| 目的 | 命令 |
| --- | --- |
| 安装依赖 | `pnpm install` |
| 类型检查 | `pnpm typecheck`（`tsc` 两份配置 `--noEmit`，strict，必须 0 error） |
| 静态检查 | `pnpm lint`（oxlint，必须 0 warning） |
| 测试 | `pnpm test`（vitest，真实 git 仓库） |
| 构建 | `pnpm build`（`tsc` × 2 → `tsdown` → `lib/{index.js,client.js}`） |
| 本地跑插件 | `pnpm dsh web --patch ./cordis.patch.yml` |
| 发布前校验 | `pnpm pack --dry-run`（`prepublishOnly` 已串起 typecheck+lint+test+build） |

环境：Node `>=22.19`、pnpm 11.x。单测跑单个文件用 `pnpm exec vitest run tests/test-unattended.ts`。

## 目录地图

```
src/
  index.ts        插件入口：四导出 name/inject/Config/apply，ctx.provide('autopilot')
  service.ts      AutopilotService —— 全部业务与循环逻辑（约 1.8k 行，核心）
  tools.ts        模型可见工具（defineTool 注册），每次变更 publish 一次快照
  view.ts         浏览器安全的视图类型（host 与 client 共用，禁 node 内置模块）
  events.ts       session 事件与投影的类型声明合并（唯一词汇表）
  projection.ts   `autopilot` 投影单元的注册 + zod schema（stateVersion: 2）
  git.ts          git CLI 薄封装，含远端 clone/push 与 push 安全规则
  team.ts         .tasks/*.md 契约解析 / 回写 / _board.md 生成
  gates.ts        质量门执行器 + 命令白名单（CommandNotAllowedError）
  bootstrap.ts    裸机引导：探测工具链 → rootless 安装 → setup → verify
  deploy.ts       部署 + 健康检查（指数退避）+ 自动回滚
  escalate.ts     升级记录：打标、写任务单留言、发 webhook
  notification.ts Mailer（自研 SMTP，仅用 node:net/tls）+ TicketServer（本地问卷工单）
  secrets.ts      密钥唯一出口：env 引用解析 + SecretRedactor 脱敏
  roles.ts        四角色的 system prompt 模板
  preset.ts       `autopilot-team` agent 预设的落盘（ensureAutopilotTeamPreset，缺失才拷贝、绝不覆盖、失败静默）
  client/         Web 端：面板、设置卡片、i18n 字典、样式（React 18，CJS 产物）
preset/
  autopilot-team/ 插件自带的 agent preset 模板（agent.cordis.yml + preset.yml），随包发布，运行时拷到用户级预设根
tests/            helpers.ts（真 git fixture）+ 三个测试文件 + cordis 冒烟（含预设落盘断言）
```

## 运行时拓扑

```
<rootDir>/<teamId>/repo                共享仓库（集成检出，始终在 baseBranch）
<rootDir>/<teamId>/workspaces/<memberId>  每个成员一个 git worktree，共享 object store
<stateDir>/state.json                  全量状态（防抖落盘，dispose 时 flush）
<stateDir>/heartbeat.json              每 tick 写入，供崩溃恢复
<repo>/.tasks/<id>.md                  任务真相源（frontmatter + Gherkin 验收）
<repo>/.tasks/_board.md                自动生成，勿手改
```

`.dsh-ai-team/` 与 `**/state.json`、`**/heartbeat.json` 已在 `.gitignore` 中，运行态绝不入库。

## 架构铁律

1. **核心与 cordis 解耦**：`AutopilotService` 不 import `ctx`/session，可独立实例化跑测试。插件层只做四件事——命名导出、提供服务、注册工具、`ctx.effect` 清理。
2. **只用命名导出**：`index.ts` 不能加 `export default`，否则 Loader 的默认解包会丢掉 `Config` schema。
3. **投影是全量快照 + last-write-wins**：每个 `autopilot/update` 事件携带完整的 `AutopilotProjection`，折叠函数直接替换，不做增量合并。
4. **状态与事件分离**：service 负责状态，tools.ts 负责把变更翻译成 session 事件。不要反向依赖。
5. **view.ts 是浏览器安全的**：客户端产物会内联它，任何 node 内置模块 import 都会炸客户端构建。

## 安全硬规则（不可绕过）

1. **密钥只引用不落盘**：Config 只存环境变量名（`xxxEnv`），运行时 `process.env[name]` 读取。任何面向模型/日志/webhook 的输出必须过 `SecretRedactor`（脱敏为 `***`）。
2. **命令白名单**：gates / bootstrap / deploy 的每条命令首 token 必须命中 `security.commandAllowlist`，否则抛 `CommandNotAllowedError` 并引导走升级。
3. **forbiddenPaths**：push 前检查分支 diff，触及 human-only 区直接拒绝并升级。
4. **门不过不合并**：`pushRequiresGates` 时门红禁 push/approve；`requireCiGreen` 时远端 CI 不绿禁 approve。
5. **禁止破坏性 git**：不 force-push 共享分支（任务/成员分支仅限 `--force-with-lease`）、不 reset 共享分支、不删 base 分支。

## 代码风格

- TypeScript strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`：类型导入必须写 `import type`，相对导入必须带 `.js` 扩展名。
- 源码注释与标识符用英文；用户可见文案走 client 的 zh/en 字典。
- 加 i18n key 时 **zh 与 en 必须同时加**（`en: Record<keyof typeof zh, string>` 会强制你补齐）。
- 提交信息用 Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:`，正文中文，见 `git log`）。
- 先跑 `pnpm typecheck && pnpm lint && pnpm test` 再宣告完成；改动发布链路的还要 `pnpm build`。

## 状态机

- 任务：`pending → in_progress → in_review → done`，`changes_requested` 打回，升级置 `needs-human`（人工处理后可回 `pending`）。
- 循环：`stopped / running / paused / escalated / completed`。崩溃恢复时持久化的 `running` 一律降为 `paused`，等 `autopilot_resume`。
- 升级触发条件（命中即 escalate，禁止自行绕过）：需求矛盾 / 跨 3+ 域改动 / 需新增付费依赖或密钥 / 非本任务导致的门红 / 触及 forbiddenPaths / 返工超限 / 任务卡死 / 部署连续失败 / 引导失败。

## 改一处要连带改哪儿

| 你改了 | 必须同步 |
| --- | --- |
| `view.ts` 视图类型 | `projection.ts` 的 zod schema + `stateVersion` +1；`client/AutopilotPanel.tsx` 渲染；需要文案则加字典 |
| 新增 tool | `tools.ts` 内 `publish(service, exec)`；README「工具一览」 |
| 新增 role | `view.ts` 的 `ROLES` → `roles.ts` prompt → 字典 `role.*` |
| 新增 `EscalationReason` | `view.ts` union → `projection.ts` zod enum → 字典 `reason.*` |
| 新增 Config 字段 | `index.ts` 的 `Config` 接口与 schema → service `AutopilotOptions` → `apply()` 的映射 → README 配置块 → 需要时 `client/settings-card.tsx` |

## 已知坑

1. **本地起 dsh 会引导失败**：`cordis.patch.yml` 默认 `bootstrap.setupCommand: pnpm run setup`、`verifyCommand: pnpm run e2e:local`，但本仓库 scripts 里没有这两个。本地调试时把 `bootstrap.enabled` 设为 `false`，或指向真实存在的脚本，否则 `autopilot_init` 会 escalate + throw。
2. **tsdown 的 `clean: false` 是故意的**：`lib/types`（tsc 产物）与 `lib`（打包产物）同目录，打开 clean 会把 d.ts 一起抹掉。
3. **client 产物的 banner/footer 不能动**：`tsdown.config.ts` 用 `window.__ModuleLoader__.load(...)` 包裹 CJS 输出，改了 Loader 就加载不了插件。
4. **测试用真实 git，不 mock**：`tests/helpers.ts` 用本地 bare 仓库扮演 remote。vitest 配了 `fileParallelism: false` + `pool: 'forks'`，别图快改成并行，会互相踩 worktree。
5. **`smoke-cordis` 测的是构建产物**：它 import `../lib/index.js`，改完源码必须先 `pnpm build` 再跑，否则测的是旧产物。
6. **设置卡片改动需重启**：`autopilot` 命名空间在插件加载时注册，设置页改配置要带 `--patch` 重启服务端才生效。
7. **`autopilot-team` 预设是随包分发 + 运行时落盘的**：模板在 `preset/autopilot-team/`，`ensureAutopilotTeamPreset()` 在 `apply()` 时拷到用户预设根（缺失才拷、绝不覆盖）。预设目录盘点无缓存，落盘后刷新即见；但**自动建 `demo` 团队**的钩子在宿主 `lib/index.js`，改宿主代码后需重启服务端。

## 测试约定

- `tests/test-integration.ts` 全流程生命周期（clone → 派发 → 门 → 审查 → 合并 → push → 部署）。
- `tests/test-unattended.ts` 循环分支（崩溃恢复、依赖/域锁、卡死、返工上限、完成报告）+ 安全硬规则。
- `tests/test-notification.ts` 真 mock SMTP（net）+ 真工单端口，验证通知闭环。
- `tests/smoke-cordis.ts` Loader 契约冒烟。
- 新增断言优先用 `AutopilotOptions` 工厂 `testOptions(fixture, overrides)`，别手搓配置对象。

## 发布

`npm publish` 前 `prepublishOnly` 会自动跑 typecheck + lint + test + build，全绿才发包。`files` 含 `lib/`、`preset/`、`README.md`、`LICENSE`、`cordis.patch.yml`。改版本号后先 `pnpm pack --dry-run` 核对清单。
