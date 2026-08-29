---
id: INT-3
title: M2 卡片：面板内作答与安全加固
status: pending
depends_on: [INT-2]
touches:
  - src/
  - tests/
---

# M2 卡片：面板内作答与安全加固

对应设计文档 [DESIGN-INTERACTION.md](../DESIGN-INTERACTION.md) §9 里程碑 M2、§7。

## 背景

`SlotProps` 现状只有 `{ sessionId?, useProjection, t }`（`src/client/contract.ts:13-18`）——**面板发不出任何东西**，`AutopilotPanel.tsx` 是纯只读投影渲染器，唯一可点的是折叠按钮和两个跳外部的 `<a>`。宿主 `Session` 类没有"投一条消息"的写入口，`ctx.approval` 只表达 `allowed-once/rejected/cancelled` 且不携带工具参数。

选定方案：面板渲染问卷卡片 + `fetch POST` 到插件自己的工单 HTTP 服务。改动全在自己手里，服务端已有表单渲染与回写闭环。

## 验收标准

### 场景一：面板内直接作答

- **Given** 一个 `status: 'open'` 的问卷已在投影里
- **When** 用户在 `conversation.input.dock` 的面板卡片里选完并点提交
- **Then** 不跳外部浏览器即可完成作答，卡片就地转为"已答复"态
- **And** 提交失败（400/网络错误）时卡片保留用户输入并显示服务端返回的缺失项说明

### 场景二：跨源可达且不放空鉴权

- **Then** 工单服务具备带白名单的 `OPTIONS` 预检与 `Access-Control-Allow-Origin`，且**白名单不是 `*`**
- **And** dsh web 走 HTTPS 时不因混合内容被拦（同源反代路径或 https 端点，二选一并写进 README）
- **And** 工单/问卷 URL 携带不可猜测 token；无 token 的 GET/POST 返回 404（不返回 403，避免枚举 id）
- **And** 端点默认仍只绑 `127.0.0.1`，README 保留"远程访问走 SSH 隧道"的警告
- **And** `notification.autoResume` 默认值保持 `false`，且在配置为监听非回环地址时 fail-loud 拒绝启动

### 场景三：等待态是人眼可见的

- **Then** 面板有明确的"等人回答"区块（问卷标题、待答问题数、async 模式下"答完请回会话说一声继续"的指引）
- **And** 升级事件流与"等人回答"在视觉上可区分——前者是"坏了"，后者是"在等你决策"

### 场景四：产物仍然浏览器安全

- **Given** 架构铁律 5（`view.ts` 不得有 node 依赖、对 `schema.ts` 只能类型 re-export）
- **When** `pnpm build` 后跑 `tests/smoke-cordis.ts`
- **Then** "keeps the client bundle browser-safe" 通过：`lib/client.js` 内无 zod、无 `node:` require，词表仍在产物里
- **And** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 全绿

## 前置说明

`fetch` 的目标端口在 `ticket.port: 0`（默认自动分配）下是运行时才知道的。卡片要能拿到它，M2 需要把实际监听地址纳入投影，而不是让前端猜。

## 超出范围

- `cancelled` / `priority` / `replan_*`——属 M3。
- 让宿主接管"答完自动唤醒组长"——依赖我们不该引入的 `dsh-agent` / workflow 写入口，见 §11-1，本里程碑明确不做。
