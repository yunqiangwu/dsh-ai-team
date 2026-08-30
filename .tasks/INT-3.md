---
id: INT-3
title: M2 卡片：面板内作答与安全加固
status: done
depends_on: [INT-2]
touches:
  - src/
  - tests/
---

# M2 卡片：面板内作答与安全加固

对应设计文档 [docs/design-interaction.md](../docs/design-interaction.md) §9 里程碑 M2、§7。

## 背景

`SlotProps` 现状只有 `{ sessionId?, useProjection, t }`（`src/client/contract.ts:13-18`）——**面板发不出任何东西**，`AutopilotPanel.tsx` 是纯只读投影渲染器，唯一可点的是折叠按钮和两个跳外部的 `<a>`。宿主 `Session` 类没有"投一条消息"的写入口，`ctx.approval` 只表达 `allowed-once/rejected/cancelled` 且不携带工具参数。

选定方案：面板渲染问卷卡片 + `fetch POST` **相对路径**到挂在宿主 `webServer` 上的同源路由；插件自己的工单端口保留，只服务邮件里的链接。改动全在自己手里，服务端已有的表单渲染与回写闭环复用一份。

## 验收标准

### 场景一：面板内直接作答

- **Given** 一个 `status: 'open'` 的问卷已在投影里
- **When** 用户在 `conversation.input.dock` 的面板卡片里选完并点提交
- **Then** 不跳外部浏览器即可完成作答，卡片就地转为"已答复"态
- **And** 提交失败（400/网络错误）时卡片保留用户输入并显示服务端返回的缺失项说明

### 场景二：一份 handler 两个挂载点，都不放空鉴权

一个 `TicketHandler` 同时服务两处，凭据语义按入口分：

| 入口 | GET 表单 | 提交 |
| --- | --- | --- |
| 独立工单端口 `/ticket/<id>`（只服务邮件里的链接） | **必须** `?t=<token>` | `POST` urlencoded，**必须** `?t=<token>` |
| 宿主 web 同源路由 `/autopilot/ticket/<id>` | 围栏 **或** token | `POST <base>/<id>/answer` JSON，围栏 **或** token |

- **Then** 未知 id、无凭据、围栏不过三种情况返回**逐字节相同**的 404 响应体（绝不 403，否则工单号可被枚举）
- **And** 面板走同源相对路径，因此**不开任何 CORS 面**（`OPTIONS` 无人应答也不影响：浏览器同源不发预检）
- **And** 同源信任围栏整抄宿主 `isTrustedApiRequest` 三段判据（`Host` 是回环或命中可信 authority → `sec-fetch-site !== cross-site` → 有 `Origin` 时其 host 必须等于 `Host`）；少了第一段，DNS rebinding 下 `Host: evil.com` 与 `Origin: http://evil.com` **相等**，光比 Origin 形同虚设
- **And** 端点默认仍只绑 `127.0.0.1`，配置为监听非回环地址时 fail-loud 拒绝启动；README 保留"远程访问走 SSH 隧道"的警告
- **And** `notification.autoResume` 默认值保持 `false`

### 场景三：等待态是人眼可见的

- **Then** 面板有明确的"等人回答"区块（问卷标题、待答问题数、async 模式下"答完请回会话说一声继续"的指引）
- **And** 升级事件流与"等人回答"在视觉上可区分——前者是"坏了"，后者是"在等你决策"

### 场景四：产物仍然浏览器安全

- **Given** 架构铁律 5（`view.ts` 不得有 node 依赖、对 `schema.ts` 只能类型 re-export）
- **When** `pnpm build` 后跑 `tests/smoke-cordis.ts`
- **Then** "keeps the client bundle browser-safe" 通过：`lib/client.js` 内无 zod、无 `node:` require，词表仍在产物里
- **And** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 全绿

## 前置说明（作废：它是选型的副产品）

原文担心 `ticket.port: 0` 下端口要运行时才知道、M2 得把监听地址纳入投影。选了同源挂载之后这条**不成立**：面板发相对路径，浏览器永远不需要知道端口。同理，HTTPS 混合内容只在用户自己往前面架 TLS 反代时出现——而那恰恰是同源相对路径能自动骑过去、独立端口方案永远骑不过去的那一种场景。

## 已定岔路

1. **同源挂宿主 `webServer`**：`src/index.ts` 用 `ctx.inject(['webServer', 'webRuntime'])` 注册 `prefix` 路由（不是顶层 `inject`，那是硬依赖，无头 profile 会起不来）。宿主不在就只是没有这条路由，独立端口照旧。
2. **token 绝不进任何视图**：凭据存在 `state.json.ticketTokens` 旁路表里（内部记录字段，**不是**视图字段，`stateVersion` 保持 7）。投影里的 `ticketUrl` 依旧无 token，因此面板上那两个跳外部的 `<a>` 改成内联表单——不是审美问题，是它们点了必 404。
3. **独立工单服务保留**：只服务邮件里的链接，读写一律强制 token。

## 超出范围

- `cancelled` / `priority` / `replan_*`——属 M3。
- 让宿主接管"答完自动唤醒组长"——依赖我们不该引入的 `dsh-agent` / workflow 写入口，见 §11-1，本里程碑明确不做。
