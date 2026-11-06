const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractResponseInfo, extractRequestInfo } = require('../dist/main/parser');
const { CoreManager } = require('../dist/main/core');

const tools = [{ type: 'namespace', name: 'functions', tools: [
  { type: 'function', name: 'wait', parameters: {
    type: 'object', properties: { cell_id: { type: 'string' } }, required: ['cell_id']
  } },
  { type: 'function', name: 'exec', parameters: {
    type: 'object', properties: { command: { type: 'string' } }
  } }
] }];
const request = {
  type: 'response.create', model: 'fixture-model', generate: false,
  input: [
    { type: 'additional_tools', role: 'developer', tools },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Updated instructions' }] }
  ]
};
const response = { object: 'response', generate: false, status: 'completed', output: [], tools,
  instructions: 'Updated instructions', usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 } };
const stream = [
  { type: 'codex.response.metadata', headers: { tools } },
  { type: 'response.created', response: { ...response, status: 'in_progress' } },
  { type: 'response.in_progress', response: { ...response, status: 'in_progress' } },
  { type: 'response.completed', response }
].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('');

test('Codex context updates do not turn echoed tool definitions into calls', () => {
  const req = extractRequestInfo('openai', JSON.stringify(request), '/backend-api/codex/responses');
  assert.equal(req.messages.length, 0);
  assert.equal(req.system_prompt, 'Updated instructions');
  for (const provider of ['openai', 'unknown']) {
    for (const body of [stream, JSON.stringify(response)]) {
      const parsed = extractResponseInfo(provider, body);
      assert.deepEqual(parsed.toolCalls, []);
      assert.equal(parsed.responseText, '');
      assert.equal(parsed.finishReason, 'completed');
      assert.equal(parsed.usage.input_tokens, 10);
      assert.equal(parsed.usage.output_tokens, 0);
    }
  }
});

test('capture labels generate:false updates without phantom tool calls', () => {
  let saved;
  const core = new CoreManager({ insertRecord: record => { saved = record; return 1; } });
  core.handleCapturePayload({ url_path: '/backend-api/codex/responses',
    request_headers: { 'user-agent': 'codex/fixture' },
    request_body: JSON.stringify(request), response_body: stream });
  assert.equal(saved.prompt_summary, '上下文更新（不生成回复）');
  assert.equal(saved.response_preview, '');
  assert.equal(saved.tool_calls_json, '[]');
  assert.equal(saved.finish_reason, 'completed');
});

test('real Responses calls still parse in direct JSON and streamed snapshots', () => {
  const output = [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'wait', arguments: '{"cell_id":"abc"}' }];
  const real = { ...response, generate: true, output };
  for (const body of [JSON.stringify(real),
    `data: ${JSON.stringify({ type: 'response.completed', response: real })}\n\n`]) {
    const parsed = extractResponseInfo('openai', body);
    assert.equal(parsed.toolCalls.length, 1);
    assert.equal(parsed.toolCalls[0].name, 'wait');
    assert.equal(parsed.toolCalls[0].id, 'call_1');
    assert.deepEqual(JSON.parse(parsed.toolCalls[0].args), { cell_id: 'abc' });
  }
});

test('unknown protocol probe ignores schemas but preserves real invocations', () => {
  const parsed = extractResponseInfo('unknown', JSON.stringify({ tools,
    definition: tools[0].tools[0],
    invocations: [{ name: 'wait', parameters: { cell_id: 'abc' }, call_id: 'call_1' }] }));
  assert.equal(parsed.toolCalls.length, 1);
  assert.deepEqual(parsed.toolCalls[0].args, { cell_id: 'abc' });
});

test('timeline separates context instructions and definitions from user input and tool calls', async t => {
  const { createServer } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  const server = await createServer({ configFile: false, root: require('node:path').resolve(__dirname, '..'),
    plugins: [vue()], server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom' });
  t.after(() => server.close());
  const { buildChatTimelineTurns, getTurnReqCopyContent } = await server.ssrLoadModule('/src/renderer/utils/messageParser.ts');
  const session = { id: 'synthetic', agent_name: 'Codex', model: 'fixture', user_prompt: 'Earlier user request',
    turns: [{ record_id: 1, turn_index: 1 }] };
  const record = { id: 1, prompt_summary: '上下文更新（不生成回复）', request_body: JSON.stringify(request),
    response_body: JSON.stringify(response), status_code: 101, capture_status: 'complete', raw_loaded: true };
  const turn = buildChatTimelineTurns(session, { 1: record })[0];
  assert.equal(turn.question.roleLabel, '上下文更新');
  assert.equal(turn.question.isUser, false);
  assert.equal(turn.question.newText, 'Updated instructions');
  assert.deepEqual(turn.question.contextTools, tools);
  assert.deepEqual(turn.answer.toolCalls, []);
  assert.equal(turn.answer.responseText, '');
  const copy = getTurnReqCopyContent(turn, false);
  assert.match(copy, /Updated instructions/);
  assert.match(copy, /cell_id/);
  assert.equal(getTurnReqCopyContent(turn, true), record.request_body);

  const light = buildChatTimelineTurns(session, { 1: { ...record, request_body: '', response_body: '', raw_loaded: false } })[0];
  assert.equal(light.question.roleLabel, '上下文更新');
  assert.ok(!light.question.newText.includes('Earlier user request'));
  const normal = buildChatTimelineTurns(session, { 1: { ...record,
    request_body: JSON.stringify({ generate: true, input: 'Real user question' }) } })[0];
  assert.equal(normal.question.isUser, true);
  assert.equal(normal.question.newText, 'Real user question');
  assert.equal(normal.question.isContextUpdate, false);
  const broken = buildChatTimelineTurns(session, { 1: { ...record, request_body: '{broken' } })[0];
  assert.equal(broken.question.isContextUpdate, false);

  const { createSSRApp } = require('vue');
  const { renderToString } = require('@vue/server-renderer');
  const Timeline = (await server.ssrLoadModule('/src/renderer/components/timeline/TimelineView.vue')).default;
  const html = await renderToString(createSSRApp(Timeline, { turns: [turn], isLoading: false }));
  assert.match(html, /上下文说明/);
  assert.match(html, /附加工具定义/);
  assert.match(html, /本次仅更新上下文，不生成模型回复/);
  assert.doesNotMatch(html, /用户指令/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  const error = { ...turn, captureStatus: 'error', statusCode: 500 };
  const failedHtml = await renderToString(createSSRApp(Timeline, { turns: [error], isLoading: false }));
  assert.doesNotMatch(failedHtml, /本次仅更新上下文，不生成模型回复/);
});
