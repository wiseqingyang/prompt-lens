const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSSRApp } = require('vue');
const { renderToString } = require('@vue/server-renderer');

test('protocol functions handle SSE detection, multi-protocol stream merging and JSON formatting', async () => {
  const {
    isSsePayload,
    parseSseJsonChunks,
    assembleSsePayload,
    formatPayload
  } = require('../dist/shared/protocol.js');

  // 1. Detection
  assert.equal(isSsePayload('{"role":"user","content":"hi"}'), false);
  assert.equal(isSsePayload('data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]'), true);
  assert.equal(isSsePayload('event: message_start\ndata: {"type":"message_start"}\n\n'), true);

  // 2. Single-line JSON formatting
  const singleLineJson = '{"model":"gpt-4o","messages":[{"role":"user","content":"hello world"}]}';
  const formattedJson = formatPayload(singleLineJson);
  assert.ok(formattedJson.includes('\n  "model": "gpt-4o"'));
  assert.ok(formattedJson.includes('\n  "messages": ['));

  // 3. OpenAI Chat Completions SSE merging
  const chatStream = [
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":42}}',
    '',
    'data: [DONE]'
  ].join('\n');

  const assembledChat = assembleSsePayload(chatStream);
  assert.equal(assembledChat.id, 'chatcmpl-1');
  assert.equal(assembledChat.object, 'chat.completion');
  assert.equal(assembledChat.choices[0].message.content, 'Hello world');
  assert.equal(assembledChat.choices[0].finish_reason, 'stop');
  assert.equal(assembledChat.usage.total_tokens, 42);

  // Formatting chat stream: merged vs unmerged
  const unmergedDisplay = formatPayload(chatStream, false);
  assert.equal(unmergedDisplay, chatStream);
  const mergedDisplay = formatPayload(chatStream, true);
  assert.ok(mergedDisplay.includes('"content": "Hello world"'));
  assert.ok(mergedDisplay.includes('"total_tokens": 42'));

  // 4. Anthropic Messages API SSE merging
  const anthropicStream = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_100","type":"message","role":"assistant","model":"claude-3-5-sonnet","content":[],"usage":{"input_tokens":15}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think"}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Here is the answer"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}'
  ].join('\n');

  const assembledAnthropic = assembleSsePayload(anthropicStream);
  assert.equal(assembledAnthropic.id, 'msg_100');
  assert.equal(assembledAnthropic.role, 'assistant');
  assert.equal(assembledAnthropic.content[0].type, 'thinking');
  assert.equal(assembledAnthropic.content[0].thinking, 'Let me think');
  assert.equal(assembledAnthropic.content[1].type, 'text');
  assert.equal(assembledAnthropic.content[1].text, 'Here is the answer');
  assert.equal(assembledAnthropic.stop_reason, 'end_turn');
  assert.equal(assembledAnthropic.usage.input_tokens, 15);
  assert.equal(assembledAnthropic.usage.output_tokens, 25);

  // 5. OpenAI Responses API (Codex) completed event
  const codexStream = [
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_999","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done!"}]}]}}'
  ].join('\n');
  const assembledCodex = assembleSsePayload(codexStream);
  assert.equal(assembledCodex.id, 'resp_999');
  assert.equal(assembledCodex.status, 'completed');
  assert.equal(assembledCodex.output[0].content[0].text, 'Done!');
});

test('timeline component renders high-contrast RAW switch, removes legacy copy dropdown and includes per-box copy buttons', async (t) => {
  const { createServer } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  const server = await createServer({
    configFile: false,
    root: path.resolve(__dirname, '..'),
    plugins: [vue()],
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: 'custom'
  });
  t.after(() => server.close());

  const Timeline = (await server.ssrLoadModule('/src/renderer/components/timeline/TimelineView.vue')).default;

  const sampleTurns = [
    {
      recordId: 101,
      turnIndex: 1,
      statusCode: 200,
      captureStatus: 'complete',
      bodyFormat: '',
      rawLoaded: true,
      rawHeaders: { 'content-type': 'application/json', authorization: 'Bearer [REDACTED]' },
      rawRequestBody: '{"messages":[{"role":"user","content":"编写快速排序"}],"model":"gpt-4"}',
      rawResponseBody: 'data: {"id":"chatcmpl-101","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"好的，这是快速排序：\\n```python\\ndef qsort...\\n```"},"finish_reason":"stop"}]}\n\ndata: [DONE]',
      question: {
        roleLabel: '用户指令',
        isContextUpdate: false,
        historyCount: 1,
        historyMessages: [{ role: 'user', text: '前置上下文' }],
        newText: '编写快速排序',
        toolResults: [
          { name: 'run_command', output: 'test passed' }
        ]
      },
      answer: {
        model: 'gpt-4',
        thinkingText: '用户需要快速排序代码，先解释思路。',
        toolCalls: [
          { name: 'read_file', args: { path: '/tmp/test.py' } }
        ],
        responseText: '好的，这是快速排序代码。'
      }
    }
  ];

  const html = await renderToString(createSSRApp(Timeline, {
    sessionId: 'session-101',
    turns: sampleTurns,
    isLoading: false
  }));

  // AC-1: High-contrast RAW switch button is present with switch role and RAW label
  assert.match(html, /role="switch"/);
  assert.match(html, /RAW/);

  // AC-2: Legacy 3-choice copy dropdown menus are removed
  assert.ok(!html.includes('脱敏复制请求 (推荐)'));
  assert.ok(!html.includes('原始 Raw 请求'));
  assert.ok(!html.includes('复制本轮完整测试用例'));
  assert.ok(!html.includes('脱敏复制响应 (推荐)'));
  assert.ok(!html.includes('原始 Raw 响应'));

  // AC-2: Individual direct copy buttons exist across formatted sections
  assert.match(html, /title="复制请求正文"/);
  assert.match(html, /title="复制工具输出"/);
  assert.match(html, /title="复制思考过程"/);
  assert.match(html, /title="复制工具调用参数"/);
  assert.match(html, /title="复制回复正文"/);
});

test('timeline component in RAW mode formats JSON, displays SSE tag, merge switch, and raw copy buttons', async (t) => {
  const { createServer } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  const server = await createServer({
    configFile: false,
    root: path.resolve(__dirname, '..'),
    plugins: [vue()],
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: 'custom'
  });
  t.after(() => server.close());

  const Timeline = (await server.ssrLoadModule('/src/renderer/components/timeline/TimelineView.vue')).default;

  const rawReq = '{"model":"gpt-4","messages":[{"role":"user","content":"ping"}]}';
  const sseRes = 'data: {"id":"chatcmpl-200","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"pong"}}]}\n\ndata: [DONE]';

  const sampleTurns = [
    {
      recordId: 200,
      turnIndex: 1,
      statusCode: 200,
      captureStatus: 'complete',
      bodyFormat: '',
      rawLoaded: true,
      rawHeaders: { host: 'api.openai.com' },
      rawRequestBody: rawReq,
      rawResponseBody: sseRes,
      question: { roleLabel: '用户指令', isContextUpdate: false, historyCount: 0, newText: 'ping', toolResults: [] },
      answer: { model: 'gpt-4', thinkingText: '', toolCalls: [], responseText: 'pong' }
    }
  ];

  const app = createSSRApp(Timeline, {
    sessionId: 'session-200',
    turns: sampleTurns,
    isLoading: false
  });

  const html = await renderToString(app);

  // In default readable mode, headers and raw pre are not in DOM
  assert.ok(!html.includes('Request Headers (已脱敏)'));

  // Test formatPayload output directly for the JSON formatting requirement (AC-4)
  const { formatPayload } = require('../dist/shared/protocol.js');
  const formattedReq = formatPayload(rawReq);
  assert.ok(formattedReq.includes('\n  "model": "gpt-4"'), 'single-line JSON request body is formatted with indentation');

  // Test SSE merged output formatting (AC-3, AC-4)
  const formattedMerged = formatPayload(sseRes, true);
  assert.ok(formattedMerged.includes('\n  "choices": ['), 'merged SSE is formatted with indentation');
  assert.ok(formattedMerged.includes('"content": "pong"'), 'merged SSE contains assembled content');

  const unmerged = formatPayload(sseRes, false);
  assert.equal(unmerged, sseRes, 'unmerged SSE preserves raw stream');
});
