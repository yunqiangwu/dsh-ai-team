# llm-mock — 确定性 LLM 模拟服务（dsh-ai-team 试点专用）

> 定位：让无人值守 e2e 试点**离线、零 token 成本**地重复跑。本项目**不是**真实大模型，
> 只是按 dsh（DeepSeek Harness）实际使用的 OpenAI 兼容协议，把**请求序映射到脚本化响应**，
> 从而确定性地驱动 leader / developer / reviewer 走完协作闭环。

## 为什么需要它

真实试点每次都会烧模型 token（都是钱）。把本服务配进 dsh web 后，所有「AI 团队」的对话
都打到本服务，返回**预置**的 assistant 消息 / `tool_calls`，团队行为完全可预测、可复现，
适合做 CI 级回归。

## 协议（对齐 OpenAI Chat Completions）

- 端点：`POST /v1/chat/completions`
- 支持 `stream: true`（`text/event-stream` SSE，`data: {...}` 分片，以 `data: [DONE]` 结束）
- 也支持非流式（返回一条 `chat.completion` JSON）
- message 支持 `content` 与 `tool_calls`（`type: 'function'` + `function.name` / `function.arguments`）
- 健康检查：`GET /health` → `{ ok: true, service: 'llm-mock' }`

## 用法

```bash
node src/server.mjs --port 11434 [--script ./responses.json]
```

- 无 `--script`：返回一条固定文字回复，用于验证连通性。
- `--script ./responses.json`：`responses.json` 为**数组**，每个元素是一条 OpenAI assistant message
  （形状见 `src/server.mjs` 顶部注释）。按请求序依次返回，用完后循环回第一个。

### 响应脚本示例 `responses.json`

```json
[
  { "role": "assistant", "content": "我先看一下当前团队与配置。" },
  { "role": "assistant", "content": null, "tool_calls": [
      { "id": "call_1", "type": "function",
        "function": { "name": "team_list", "arguments": "{}" } }
  ] }
]
```

要让整个团队真正「干活」，这个数组需要把 leader / developer / reviewer 的**整条工具调用链**
（`autopilot_init` → `team_add_member` → `autopilot_run` → `contract_create` → `task_assign`
→ `gates_run` → `code_review` → …）按 dsh 实际向模型发的消息序编排好。属于 e2e 测试脚手架的一部分，
随 e2e 脚本一同提供（`scripts/e2e-driver.mjs`）。

## 如何接入 dsh web

把 dsh 的 LLM provider 指到本服务即可（baseURL 用 `/v1` 前缀）：

```
baseURL = http://127.0.0.1:11434/v1
apiKey  = mock        # dsh 一般要求非空，任意值
model   = llm-mock
```

具体配置入口以 dsh web「选择模型 / 模型设置」为准（不同版本字段略异）。接入后模型名显示为
`llm-mock`，请求全部打到本服务，不再消耗真实 token。
