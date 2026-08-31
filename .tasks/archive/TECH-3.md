---
id: TECH-3
title: sha256 审批链失效重批：accepted 文档被手改的检测与退回重批
status: done
touches:
  - src/
  - tests/
  - docs/
---

# sha256 审批链失效重批：accepted 文档被手改的检测与退回重批

对应设计文档 [docs/design-interaction.md](../docs/design-interaction.md) §11 未决问题 #2、§4（文档审批链）。

## 背景

sha256 审批链的承诺是「正式区只放人批过的字节，`approvedBy`/`sha256` 记录谁批了哪些字节」。这条承诺目前只护住了**升格那一刻**：

- `pending-approval` 草稿被人手改 → `promoteDrafts` 比对失败 → 拒批、作废旧码、重开问卷、重钉哈希（已实现且已测，`tests/test-questionnaire.ts`「批完草稿被悄悄改掉」一条）；
- 但文档升格为 `accepted` 之后被人直接手改正文 → **全仓库没有任何检测**。frontmatter 里的哈希与批准记录从此静默说谎：人批的是 A，团队照着干的是 B′，而任何人都看不见。

§11 #2 的原话正是「sha256 审批链**在用户直接手改文档时**如何失效并重批」。前半句（升格窗口内的手改）已兑现；本契约收后半句（accepted 之后的手改）。

## 策略（本契约把它定死）

**检测在 daemon tick，响应用既有审批链原地重走**：

1. 每拍扫描正式区（`docs.formalDir`）：`status: accepted` 且 `hashBody(body) !== meta.sha256` 即 drift。判定口径是「集成检出里的字节与批准哈希不符」，不关心改动怎么进来的（人直接编辑检出、或经远端合入都一样命中）。
2. drift 的文档**整体退回 draft 区**：内容写到 draft 区同相对路径、正式区删除、`commitDocs` 一次提交两侧（与 `promoteDrafts` 逆向对称）。退回态直接是 `pending-approval` 并按新正文重算哈希——不是 `draft`：退回就是为了重批，直接落待批态，人拿新码来批不会撞 `nothing pending approval`（该死锁在 `promoteDrafts` 注释里已有先例）。version 先递增一格（1.0 → 1.1），`approvedBy`/`approvedAt` 清空——谎言不留档。
3. 随即重开一张 approval 问卷（题面含 decision 题，title 写明哪份文档在批准后被改动），投递走既有 `notifyQuestionnaire`。不调 `stampForApproval`：它会把 draft 区**其它**草稿也扫进审批包，还带 intake 阶段副作用——退回谁就重批谁。
4. 此后全是既有链路：人批 approve → `promoteDrafts` 升格（formal 侧已删，version 用退回时递增过的值）；reject → `resetDraftsToEditable` 停在 draft 区。
5. **幂等免费**：退回后正式区已无该文档，下一拍扫描不再命中，不会重复发问卷。

一句话：**正式区只放人批过的字节；批过的字节变了 → 回 draft 重批**。「失效」= 退出正式区，「重批」= 走同一条审批链。不造追认（ratify）新问卷类型、不动 `afterAnswered`、不动 phase。

## 验收标准

### 场景一：升格窗口内的手改防护保持不变（锁定既有行为）

- **Given** 一份 `pending-approval` 草稿在审批码发出后被手改正文
- **When** 人带码调 `doc_approve`（或工单答复 approve 触发升格）
- **Then** 拒批、旧码作废、重开问卷、哈希重钉——现有 `tests/test-questionnaire.ts`「批完草稿被悄悄改掉」一条断言一字不改地通过

### 场景二：accepted 文档被手改 → 检测并退回重批

- **Given** 正式区一份 `accepted` 文档（含 `approvedBy`/`sha256`），人直接编辑其正文（frontmatter 的 sha256 保持旧值）
- **When** 守护循环跑一拍 `tickOnce`
- **Then** 该文档出现在 draft 区同相对路径，`status: 'pending-approval'`、`sha256` 为新正文的哈希、version 递增一格（`1.0 → 1.1`）；正式区该文件已删除；两侧改动落在**同一次** git 提交里
- **And** 存在一张 open 的 approval 问卷，title 指名该文档路径与「批准后被改动」，且已走 `notifyQuestionnaire` 投递
- **And** 被改文档的旧 `approvedBy` 记录不再随正式区存在——谎言不留档

### 场景三：重批 approve 走既有升格链

- **When** 人对场景二重开的问卷答 approve（带新审批码）
- **Then** `promoteDrafts` 正常升格，version 按同路径二次批先例递增（`1.0 → 1.1`），`approvedBy` 记录本轮批准来源
- **And** 不需要 `afterAnswered` 任何新分支（重开的就是 `kind: 'approval'`）

### 场景四：多拍幂等

- **Given** 场景二已发生（文档已在 draft 区、问卷已 open）
- **When** 守护循环再跑一拍
- **Then** 不再产生新的退回提交、不再新开问卷（扫描不再命中，事件流无重复条目）

### 场景五：正常文档不误伤

- **Given** 正式区一份哈希一致的 `accepted` 文档
- **When** 守护循环跑一拍
- **Then** 无退回、无问卷、无提交——检测是静默的，只有 drift 才出声

### 场景六：文档与连带收口

- **Then** `docs/design-interaction.md` §11 #2 结案：升格窗口内手改（既有）与 accepted 之后手改（本契约）均已落代码，口径指向本契约
- **And** 检测的纯逻辑（扫描 + drift 判定）落 `service/docflow.ts`，tick 编排（退回 + 重开 + 投递）留 `service.ts`——遵循既有分工约定
- **And** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 全绿

## 超出范围

- **对抗性伪造不防**：人把正文连 frontmatter `sha256` 一起改掉，检测必然失效。与工单 token 同一威胁模型——挡误操作与模型注入，不挡本机的人（AGENTS.md 安全硬规则 6 的诚实边界）。
- **不动 phase**：drift 退回不把 `developing` 拉回 `intake`——在途任务照跑，世界变了要重批的是文档，不是团队阶段。
- **不做 diff 渲染**：问卷 title 只报路径与事实，「改了什么」由 git 历史回答。
- 不新增 `EscalationReason`、不新增问卷 kind、不改 `QuestionnaireView` 形状（`stateVersion` 不动）。
