/**
 * llm-mock —— 一个确定性的 OpenAI 兼容 LLM 模拟服务。
 *
 * 目的：让 dsh-ai-team 的无人值守试点可以**离线、零 token 成本**地重复跑。
 * dsh（DeepSeek Harness）通过 OpenAI 兼容的 `POST /v1/chat/completions`
 * 与模型对话，支持 `stream: true` 的 SSE 流式返回。本服务只实现这一个端点，
 * 用「脚本化响应」代替真实大模型：按请求序返回预置的 assistant 消息 / tool_calls，
 * 从而驱动 leader / developer / reviewer 走完整个协作闭环。
 *
 * 协议对齐：OpenAI Chat Completions（含 `tool_calls`、SSE `data: {...}` 分片、`data: [DONE]`）。
 *
 * 用法：
 *   node src/server.mjs [--port 11434] [--script ./responses.json]
 *
 * 把 dsh 的 baseURL 指向 http://127.0.0.1:<port>/v1 即可（见 README.md）。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = Number(process.env.LLM_MOCK_PORT ?? 11434);
const HOST = process.env.LLM_MOCK_HOST ?? '127.0.0.1';

/** 从 argv 里取 --port / --script（极简解析，够用即可）。 */
function argValue(name, fallback) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  return argv[index + 1] ?? fallback;
}

/**
 * 脚本化响应：按「第几次请求」返回一条 assistant 消息。
 *
 * 形状（OpenAI 的 message）：
 *   { role: 'assistant', content: '...' }
 *   { role: 'assistant', content: null, tool_calls: [{ id, type:'function', function:{ name, arguments } }] }
 *
 * `responses.json` 是一个数组，元素即上面形状；用完后循环回第一个。
 * 未提供脚本时，返回一条固定的文字回复（用于验证连通性）。
 */
function loadScript() {
  const path = argValue('--script', '');
  if (path === '') {
    return [
      { role: 'assistant', content: 'Hello from llm-mock. To drive the AI team, provide a --script with scripted tool_calls.' },
    ];
  }
  const raw = readFileSync(resolve(path), 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`script must be a JSON array: ${path}`);
  return parsed;
}

/** 把 body 解析成 JSON；失败返回 null。 */
function readJsonBody(request) {
  return new Promise((resolveBody) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      try { resolveBody(raw === '' ? {} : JSON.parse(raw)); } catch { resolveBody(null); }
    });
  });
}

/** OpenAI 流式分片。delta 为 message 的增量；finish_reason 缺省为 null。 */
function sseChunk(id, delta, finish = null) {
  const payload = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'llm-mock',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 单条 scripted message → 一系列流式 delta。 */
function deltasFor(message) {
  if (typeof message.content === 'string' && message.content !== '') {
    return [{ content: message.content }];
  }
  if (Array.isArray(message.tool_calls)) {
    return message.tool_calls.map((call) => ({
      tool_calls: [call],
    }));
  }
  return [{}];
}

const script = loadScript();
let counter = 0;

function nextMessage() {
  const message = script[counter % script.length] ?? { role: 'assistant', content: '' };
  counter += 1;
  return message;
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, service: 'llm-mock', port: PORT }));
    return;
  }

  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }

  const body = await readJsonBody(request);
  if (body === null) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
    return;
  }

  const message = nextMessage();
  const id = `chatcmpl-mock-${counter}`;

  if (body.stream === true) {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const delta of deltasFor(message)) {
      response.write(sseChunk(id, delta));
    }
    response.write(sseChunk(id, {}, 'stop'));
    response.write('data: [DONE]\n\n');
    response.end();
    return;
  }

  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'llm-mock',
    choices: [{ index: 0, message, finish_reason: 'stop' }],
  }));
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`llm-mock listening on http://${HOST}:${PORT}/v1`);
});
