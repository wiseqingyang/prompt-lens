const { temporaryDatabase } = require('./fixtures.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  extractResponseInfo,
  extractRequestInfo,
  parseJsonChunks,
  detectAgent,
  detectProvider,
  schemaRegistry,
  SchemaRegistry
} = require('../dist/main/parser');
const {
  clusterRecordsIntoTasks,
  resolveSessionIdentity,
  extractUserPromptFromRecord,
  dissectPromptAnatomy,
  extractHistoryAndInjectionsChars,
  isSubagentRecord
} = require('../dist/main/session');
const { StorageEngine } = require('../dist/main/storage');
const {
  sanitizeText,
  sanitizeHeaders,
  createSanitizedFixture
} = require('../dist/main/sanitizer');
const { WebServer } = require('../dist/main/web');
const { FIXTURES } = require('./fixtures.cjs');

test('parseJsonChunks parses formatted multi-line JSON, JSON arrays, and data: without spaces', () => {
  // 1. Multi-line formatted JSON
  const multiLineJson = `data: {
  "response": {
    "candidates": [
      {
        "content": {
          "parts": [{ "text": "Hello world" }]
        },
        "finishReason": "STOP"
      }
    ],
    "usageMetadata": {
      "promptTokenCount": 100,
      "candidatesTokenCount": 20,
      "totalTokenCount": 120,
      "cachedContentTokenCount": 40
    }
  }
}

`;
  const chunks1 = parseJsonChunks(multiLineJson);
  assert.equal(chunks1.length, 1);
  assert.equal(chunks1[0].response.candidates[0].content.parts[0].text, 'Hello world');

  // 2. JSON array
  const jsonArray = `[
    { "candidates": [{ "content": { "parts": [{ "text": "Item 1" }] } }] },
    { "candidates": [{ "content": { "parts": [{ "text": "Item 2" }] } }] }
  ]`;
  const chunks2 = parseJsonChunks(jsonArray);
  assert.equal(chunks2.length, 2);
  assert.equal(chunks2[0].candidates[0].content.parts[0].text, 'Item 1');
  assert.equal(chunks2[1].candidates[0].content.parts[0].text, 'Item 2');

  // 3. data: without space
  const noSpaceSse = `data:{"candidates":[{"content":{"parts":[{"text":"Fast chunk"}]}}]}`;
  const chunks3 = parseJsonChunks(noSpaceSse);
  assert.equal(chunks3.length, 1);
  assert.equal(chunks3[0].candidates[0].content.parts[0].text, 'Fast chunk');
});

test('extractResponseInfo accurately extracts finishReason, toolCalls, and token_source', () => {
  // Case A: Gemini reported usage and tool call
  const geminiSse = `data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"foo.ts"}}}]},"finishReason":"TOOL_CALLS"}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":15,"totalTokenCount":65,"cachedContentTokenCount":10}}}`;
  const infoA = extractResponseInfo('gemini', geminiSse);
  assert.equal(infoA.finishReason, 'TOOL_CALLS');
  assert.equal(infoA.toolCalls.length, 1);
  assert.equal(infoA.toolCalls[0].name, 'read_file');
  assert.equal(infoA.toolCalls[0].args.path, 'foo.ts');
  assert.equal(infoA.usage.token_source, 'reported');
  assert.equal(infoA.usage.input_tokens, 50);
  assert.equal(infoA.usage.cached_tokens, 10);
  assert.equal(infoA.usage.cache_ratio, 20.0);

  // Case B: Missing usage remains unavailable; output text is not a token meter.
  const openaiSse = `data: {"choices":[{"delta":{"content":"Estimated answer text"},"finish_reason":"stop"}]}`;
  const infoB = extractResponseInfo('openai', openaiSse);
  assert.equal(infoB.finishReason, 'stop');
  assert.equal(infoB.usage.token_source, 'unavailable');
  assert.equal(infoB.usage.output_tokens, 0);
  assert.equal(infoB.responseText, 'Estimated answer text');

  // Case C: Unavailable or empty
  const infoC = extractResponseInfo('gemini', '');
  assert.equal(infoC.usage.token_source, 'unavailable');
});

test('clusterRecordsIntoTasks strictly isolates tasks by session_id without merging identical prompts', () => {
  const records = [
    // Session 1: User types "继续", has 2 turns
    {
      id: 1,
      session_id: 'session_alpha',
      user_prompt: '继续',
      agent_name: 'Antigravity',
      created_at: '2026-09-20T10:00:00Z',
      status_code: 200,
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 20,
      response_preview: '[Tool Call] edit_file'
    },
    {
      id: 2,
      session_id: 'session_alpha',
      user_prompt: '继续',
      agent_name: 'Antigravity',
      created_at: '2026-09-20T10:00:05Z',
      status_code: 200,
      input_tokens: 120,
      output_tokens: 80,
      cached_tokens: 50,
      response_preview: 'Task finished'
    },
    // Session 2: Interleaved chronologically, user ALSO types "继续"
    {
      id: 3,
      session_id: 'session_beta',
      user_prompt: '继续',
      agent_name: 'Claude Code',
      created_at: '2026-09-20T10:00:02Z',
      status_code: 200,
      input_tokens: 200,
      output_tokens: 60,
      cached_tokens: 0,
      response_preview: 'Done in beta'
    }
  ];

  const tasks = clusterRecordsIntoTasks(records);

  // Must yield 2 distinct tasks, NOT 1 merged task!
  assert.equal(tasks.length, 2);

  const taskAlpha = tasks.find((t) => t.session_id === 'session_alpha');
  const taskBeta = tasks.find((t) => t.session_id === 'session_beta');

  assert.ok(taskAlpha, 'session_alpha task must exist');
  assert.ok(taskBeta, 'session_beta task must exist');

  assert.equal(taskAlpha.turns_count, 2);
  assert.equal(taskBeta.turns_count, 1);
  assert.equal(taskBeta.agent_name, 'Claude Code');
});

test('StorageEngine correctly persists and returns token_source, finish_reason, and tool_calls_json', (t) => {
  const tmpDbPath = temporaryDatabase(t);
  const storage = new StorageEngine(tmpDbPath);

  try {
    const id = storage.insertRecord({
      session_id: 'sess-b08',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 1200,
      input_tokens: 500,
      output_tokens: 150,
      cached_tokens: 200,
      thinking_tokens: 50,
      total_tokens: 650,
      cache_ratio: 40.0,
      token_source: 'reported',
      finish_reason: 'STOP',
      tool_calls_json: JSON.stringify([{ name: 'run_command', args: { cmd: 'ls' } }])
    });

    const record = storage.getRecordById(id);
    assert.ok(record);
    assert.equal(record.token_source, 'reported');
    assert.equal(record.finish_reason, 'STOP');
    assert.ok(record.tool_calls_json.includes('run_command'));

    // Check list view query includes token_source and finish_reason
    const list = storage.getRecords({ sessionId: 'sess-b08' });
    assert.equal(list.length, 1);
    assert.equal(list[0].token_source, 'reported');
    assert.equal(list[0].finish_reason, 'STOP');
  } finally {
    storage.close();
    try { fs.unlinkSync(tmpDbPath); } catch {}
  }
});

test('fixtures parse correctly', () => {
  // 1. Verify Gemini tool call fixture extraction
  const geminiBody = JSON.stringify(FIXTURES.gemini.toolCallResponse);
  const infoGemini = extractResponseInfo('gemini', geminiBody);
  assert.equal(infoGemini.finishReason, 'STOP');
  assert.equal(infoGemini.toolCalls.length, 1);
  assert.equal(infoGemini.toolCalls[0].name, 'readFile');
  assert.equal(infoGemini.toolCalls[0].args.path, 'package.json');

  // 2. Verify Anthropic SSE fixture extraction
  const claudeSse = FIXTURES.anthropic.sampleSse.join('');
  const chunks = parseJsonChunks(claudeSse);
  assert.ok(chunks.length >= 2);
  const startChunk = chunks.find(c => c.type === 'message_start');
  assert.equal(startChunk.message.usage.input_tokens, 50);
  assert.equal(startChunk.message.usage.cache_read_input_tokens, 20);

});

test('detectAgent accurately identifies Pi Agent across various UA strings and headers', () => {
  assert.equal(detectAgent({ 'user-agent': 'pi/0.85.1 (darwin; node/v22.12.0; arm64)' }, '/v1/messages'), 'Pi Agent');
  assert.equal(detectAgent({ 'user-agent': 'pi (darwin 24.4.0; arm64)' }, '/v1/responses'), 'Pi Agent');
  assert.equal(detectAgent({ 'user-agent': 'pi-coding-agent/0.85.1' }, '/v1/messages'), 'Pi Agent');
  assert.equal(detectAgent({ 'user-agent': 'Cursor/0.45.0' }, '/v1/chat/completions'), 'Cursor');
  assert.equal(detectAgent({ 'user-agent': 'claude-cli/1.0.0' }, '/v1/messages'), 'Claude Code');
  assert.equal(detectAgent({ 'user-agent': 'pi/0.87.1', 'x-client-name': 'codex-compatible-gateway' }, '/v1/messages'), 'Pi Agent');
});

test('detectAgent and detectProvider accurately identify Codex App, CLI and local reverse proxy', () => {
  // 1. User Agent detections
  assert.equal(detectAgent({ 'user-agent': 'CodexBrowser/1.0 (Macintosh; arm64)' }, '/backend-api/lat/r'), 'Codex');
  assert.equal(detectAgent({ 'user-agent': 'codex-cli/0.146.0' }, '/v1/responses'), 'Codex');
  assert.equal(detectAgent({ 'user-agent': 'ChatGPT/1.2024.1' }, '/v1/responses'), 'Codex');

  assert.equal(detectAgent({ 'chatgpt-account-id': 'acc_7788', 'user-agent': 'curl/8.7.1' }, '/backend-api/codex/responses'), 'Codex');
  assert.equal(detectAgent({}, '/v1internal:streamGenerateContent', { request: { contents: [] } }), 'Antigravity');
  assert.equal(detectAgent({ host: 'daily-cloudcode-pa.googleapis.com' }, '/v1internal:loadCodeAssist', {}), 'Antigravity');

  // 2. Provider detections (official cloud and local reverse proxy)
  assert.equal(detectProvider('/backend-api/codex/responses', { host: 'chatgpt.com' }), 'openai');
  assert.equal(detectProvider('/v1/responses', { host: '127.0.0.1:15721' }, { input: 'hello' }), 'openai');
  assert.equal(detectProvider('/v1/responses', { host: 'localhost:54560' }, { instructions: 'rules' }), 'openai');
});

test('v2 chat completions captures model and reported usage for daily statistics', (t) => {
  const { CoreManager } = require('../dist/main/core');
  const storage = new StorageEngine(temporaryDatabase(t));
  t.after(() => storage.close());
  const core = new CoreManager(storage);
  const id = core.handleCapturePayload({
    event_id: 'synthetic-v2-chat', url_path: '/v2/chat/completions',
    request_headers: { host: 'gateway.example.test' },
    request_body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'Hello' }] }),
    response_body: 'data: {"model":"fixture-model","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105}}\n\n'
  });
  const row = storage.getRecordById(id);
  assert.equal(row.provider, 'openai');
  assert.equal(row.model, 'fixture-model');
  assert.equal(row.token_source, 'reported');
  assert.equal(row.total_tokens, 105);
  const day = new Date().toLocaleDateString('en-CA');
  assert.equal(storage.getDayModelUsage(day).find(item => item.model === 'fixture-model').total_tokens, 105);
  assert.equal(detectProvider('/v2/chat/completions-extra', { host: 'gateway.example.test' }), 'unknown');
});

test('extractRequestInfo and extractResponseInfo handle OpenAI Responses API (Codex format)', () => {
  // 1. Request Info (instructions + input array)
  const reqBody = JSON.stringify({
    model: 'ag/gemini-3.8-flash-high',
    instructions: 'You are Codex, an expert software developer.',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Fix the unit test' }] }
    ],
    tools: [{ type: 'function', name: 'exec_command' }]
  });

  const reqInfo = extractRequestInfo('openai', reqBody, '/v1/responses');
  assert.equal(reqInfo.model, 'ag/gemini-3.8-flash-high');
  assert.equal(reqInfo.system_prompt, 'You are Codex, an expert software developer.');
  assert.equal(reqInfo.messages.length, 1);
  assert.equal(reqInfo.messages[0].role, 'user');
  assert.equal(reqInfo.messages[0].text, 'Fix the unit test');

  // 2. Response Info (Responses API SSE stream with delta and usage)
  const codexSse = [
    'data: {"type":"response.output_text.delta","delta":"Here is "}\n\n',
    'data: {"type":"response.output_text.delta","delta":"the solution."}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"total_tokens":150,"input_tokens":100,"output_tokens":50,"input_tokens_details":{"cached_tokens":40},"output_tokens_details":{"reasoning_tokens":15}}}}\n\n',
    'data: [DONE]\n\n'
  ].join('');

  const resInfo = extractResponseInfo('openai', codexSse);
  assert.equal(resInfo.responseText, 'Here is the solution.');
  assert.equal(resInfo.finishReason, 'completed');
  assert.equal(resInfo.usage.token_source, 'reported');
  assert.equal(resInfo.usage.input_tokens, 100);
  assert.equal(resInfo.usage.output_tokens, 50);
  assert.equal(resInfo.usage.cached_tokens, 40);
  assert.equal(resInfo.usage.thinking_tokens, 15);
  assert.equal(resInfo.usage.total_tokens, 150);
  assert.equal(resInfo.usage.cache_ratio, 40.0);
});

test('Codex Responses API full SSE stream strictly prevents duplicate output text (Regression test for record 7152)', () => {
  const answerText = '是我这边同一条回复显示了两遍，应该不是你的解析错误。抱歉。';
  const fullCodexSse = [
    'data: {"type":"response.created","response":{"id":"resp_123","status":"in_progress"}}\n\n',
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning","content":[]}}\n\n',
    'data: {"type":"response.reasoning_summary_text.delta","delta":"Clarifying duplicate message"}\n\n',
    'data: {"type":"response.reasoning_summary_text.done","text":"Clarifying duplicate message"}\n\n',
    'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning"}}\n\n',
    'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_1","type":"message","status":"in_progress","content":[]}}\n\n',
    'data: {"type":"response.output_text.delta","delta":"是我这边"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"同一条回复显示了两遍，应该不是你的解析错误。抱歉。"}\n\n',
    'data: {"type":"response.output_text.done","text":"' + answerText + '"}\n\n',
    'data: {"type":"response.output_item.done","output_index":1,"item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"' + answerText + '"}]}}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"' + answerText + '"}]}]}}\n\n',
    'data: [DONE]\n\n'
  ].join('');

  const resInfo = extractResponseInfo('openai', fullCodexSse);
  assert.equal(resInfo.responseText, answerText);
  assert.equal(resInfo.responseText.length, answerText.length);
});

test('resolveSessionIdentity and extractUserPromptFromRecord correctly parse Codex conversation payload', () => {
  // Session resolution from Codex turn / thread headers or payload
  const headers = { 'x-codex-turn-id': 'turn_session_xyz' };
  const sid = resolveSessionIdentity(headers, null, 'openai', 'gpt-5').id;
  assert.equal(sid, 'unknown');

  const bodyData = { conversation_id: 'conv_codex_123', input: 'Run git status' };
  const sidFromPayload = resolveSessionIdentity({}, bodyData, 'openai', 'gpt-5').id;
  assert.equal(sidFromPayload, 'conv_codex_123');

  // User prompt extraction from Responses API input
  const prompt = extractUserPromptFromRecord({
    request_body: JSON.stringify(bodyData)
  });
  assert.equal(prompt, 'Run git status');
});

test('Codex Responses API tool calls, output feedback, and compaction filtering', () => {
  // 1. Tool call in SSE response stream
  const codexToolSse = [
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","name":"exec_command","call_id":"call_1","arguments":""}}\n\n',
    'data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":"{\\"cmd\\":\\"git status\\"}"}\n\n',
    'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","type":"function_call","name":"exec_command","call_id":"call_1","arguments":"{\\"cmd\\":\\"git status\\"}"}}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
  ].join('');

  const toolRes = extractResponseInfo('openai', codexToolSse);
  assert.equal(toolRes.toolCalls.length, 1);
  assert.equal(toolRes.toolCalls[0].name, 'exec_command');
  assert.equal(toolRes.toolCalls[0].args, '{"cmd":"git status"}');

  // 2. Multi-turn feedback injection in request body (input with function_call and function_call_output)
  const reqBodyWithFeedback = JSON.stringify({
    model: 'ag/gemini-3.8-flash-high',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '我们应该做什么' }] },
      { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"git status"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'On branch main\nnothing to commit' }
    ]
  });

  const reqInfo = extractRequestInfo('openai', reqBodyWithFeedback, '/v1/responses');
  assert.equal(reqInfo.messages.length, 3);
  assert.equal(reqInfo.messages[0].role, 'user');
  assert.equal(reqInfo.messages[0].text, '我们应该做什么');
  assert.equal(reqInfo.messages[1].role, 'assistant');
  assert.equal(reqInfo.messages[1].tools[0].name, 'exec_command');
  assert.equal(reqInfo.messages[2].role, 'tool');
  assert.equal(reqInfo.messages[2].tools[0].name, 'exec_command');
  assert.ok(reqInfo.messages[2].text.includes('On branch main'));

  // 3. User prompt ignores compaction summary and environment context, locating real user prompt
  const reqBodyWithCompaction = JSON.stringify({
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: '<app-context>Desktop</app-context>' }] },
      { role: 'user', content: [{ type: 'input_text', text: '<environment_context><cwd>/app</cwd></environment_context>' }] },
      { role: 'user', content: [{ type: 'input_text', text: '我们应该做什么' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Another language model started to solve this problem and produced a summary of its thinking process.\n## Context Checkpoint Compaction\nSummary...' }] }
    ]
  });

  const extractedUserPrompt = extractUserPromptFromRecord({
    request_body: reqBodyWithCompaction
  });
  assert.equal(extractedUserPrompt, '我们应该做什么');
});

test('Codex custom_tool_call and custom_tool_call_output streaming and anatomy', () => {
  // 1. SSE response with custom_tool_call streaming input deltas
  const codexCustomToolSse = [
    'event: response.output_item.added\n',
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"ctc_1","type":"custom_tool_call","name":"exec","call_id":"call_exec_99","input":""}}\n\n',
    'event: response.custom_tool_call_input.delta\n',
    'data: {"type":"response.custom_tool_call_input.delta","item_id":"ctc_1","delta":"tools.exec_command({cmd: "}\n\n',
    'event: response.custom_tool_call_input.delta\n',
    'data: {"type":"response.custom_tool_call_input.delta","item_id":"ctc_1","delta":"\\"git status\\"})"}\n\n',
    'event: response.custom_tool_call_input.done\n',
    'data: {"type":"response.custom_tool_call_input.done","item_id":"ctc_1","input":"tools.exec_command({cmd: \\"git status\\"})"}\n\n',
    'event: response.output_item.done\n',
    'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"ctc_1","type":"custom_tool_call","name":"exec","call_id":"call_exec_99","input":"tools.exec_command({cmd: \\"git status\\"})"}}\n\n',
    'event: response.completed\n',
    'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
  ].join('');

  const toolRes = extractResponseInfo('openai', codexCustomToolSse);
  assert.equal(toolRes.toolCalls.length, 1);
  assert.equal(toolRes.toolCalls[0].name, 'exec');
  assert.equal(toolRes.toolCalls[0].args, 'tools.exec_command({cmd: "git status"})');

  // 2. Request body with additional_tools, custom_tool_call and array-based custom_tool_call_output
  const reqBody = JSON.stringify({
    model: 'gpt-5.6-terra',
    input: [
      {
        type: 'additional_tools',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            tools: [{ type: 'custom', name: 'exec' }, { type: 'custom', name: 'web_search' }]
          }
        ]
      },
      { role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Check git status' }] },
      { type: 'custom_tool_call', name: 'exec', call_id: 'call_exec_99', input: 'tools.exec_command({cmd: "git status"})' },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_exec_99',
        output: [
          { type: 'input_text', text: 'On branch main\nnothing to commit' }
        ]
      }
    ]
  });

  const reqInfo = extractRequestInfo('openai', reqBody, '/v1/responses');
  assert.equal(reqInfo.system_prompt, 'You are Codex.');
  assert.equal(reqInfo.messages.length, 3); // user, assistant (call), tool (output)
  assert.equal(reqInfo.messages[0].role, 'user');
  assert.equal(reqInfo.messages[1].role, 'assistant');
  assert.equal(reqInfo.messages[1].tools[0].name, 'exec');
  assert.equal(reqInfo.messages[2].role, 'tool');
  assert.equal(reqInfo.messages[2].tools[0].name, 'exec');
  assert.ok(reqInfo.messages[2].text.includes('On branch main'));

  // 3. Prompt anatomy extracts additional_tools properly
  const { dissectPromptAnatomy } = require('../dist/main/session');
  const anatomy = dissectPromptAnatomy({ request_body: reqBody, input_tokens: 1000 });
  const toolLayer = anatomy.layers.find(l => l.id === 'tool_schemas');
  assert.ok(toolLayer);
  assert.equal(toolLayer.tool_count, 2);
});

test('synthetic multi-turn Responses input resolves custom tool output without fallback to msgs', () => {
  const input = [];
  for (let i = 0; i < 3; i++) {
    input.push({ role: 'user', content: [{ type: 'input_text', text: `Synthetic question ${i}` }] });
    input.push({ role: 'assistant', content: [{ type: 'output_text', text: `Synthetic answer ${i}` }] });
  }
  input.push({ type: 'custom_tool_call', call_id: 'synthetic-call', name: 'exec', input: 'git status' });
  input.push({ type: 'custom_tool_call_output', call_id: 'synthetic-call', output: 'Script completed' });
  const reqInfo = extractRequestInfo('openai', JSON.stringify({
    model: 'synthetic-model', instructions: 'You are Codex, a synthetic test assistant.', input
  }), '/v1/responses');
  assert.equal(reqInfo.model, 'synthetic-model');
  assert.ok(reqInfo.system_prompt.includes('You are Codex'));
  assert.ok(reqInfo.messages.length > 5);

  // Verify the last message is custom_tool_call_output with resolved name 'exec'
  const lastMsg = reqInfo.messages[reqInfo.messages.length - 1];
  assert.equal(lastMsg.role, 'tool');
  assert.ok(lastMsg.tools && lastMsg.tools[0].name === 'exec');
  assert.ok(lastMsg.text.includes('Script completed'));
});

test('Chat Completions streaming tool_calls chunk assembly and reasoning_content', () => {
  const streamSse = [
    'data: {"choices":[{"delta":{"reasoning_content":"Thinking deeply..."}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":"{\\"q\\": "}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"hello\\"}"}}]}}]}\n\n',
    'data: [DONE]\n\n'
  ].join('');

  const info = extractResponseInfo('openai', streamSse);
  assert.equal(info.thinkingText, 'Thinking deeply...');
  assert.equal(info.toolCalls.length, 1);
  assert.equal(info.toolCalls[0].name, 'search');
  assert.equal(info.toolCalls[0].args, '{"q": "hello"}');
});

test('Codex custom_tool_call stream with empty output_item.added input, deltas, and completed deduplication', () => {
  const streamSse = [
    'event: response.created\n',
    'data: {"type":"response.created","response":{"id":"resp_123","model":"gpt-5.6-sol"}}\n\n',
    'event: response.output_item.added\n',
    'data: {"type":"response.output_item.added","output_index":2,"item":{"id":"ctc_01","type":"custom_tool_call","call_id":"call_abc","name":"exec","input":""}}\n\n',
    'event: response.custom_tool_call_input.delta\n',
    'data: {"type":"response.custom_tool_call_input.delta","output_index":2,"item_id":"ctc_01","delta":"const rs = await Promise.all([\\n"}\n\n',
    'event: response.custom_tool_call_input.delta\n',
    'data: {"type":"response.custom_tool_call_input.delta","output_index":2,"item_id":"ctc_01","delta":"  tools.exec_command({cmd:\\"git diff\\"})\\n]);\\n"}\n\n',
    'event: response.custom_tool_call_input.done\n',
    'data: {"type":"response.custom_tool_call_input.done","output_index":2,"item_id":"ctc_01","input":"const rs = await Promise.all([\\n  tools.exec_command({cmd:\\"git diff\\"})\\n]);\\n"}\n\n',
    'event: response.output_item.done\n',
    'data: {"type":"response.output_item.done","output_index":2,"item":{"id":"ctc_01","type":"custom_tool_call","call_id":"call_abc","name":"exec","input":"const rs = await Promise.all([\\n  tools.exec_command({cmd:\\"git diff\\"})\\n]);\\n"}}\n\n',
    'event: response.completed\n',
    'data: {"type":"response.completed","response":{"id":"resp_123","status":"completed","output":[{"id":"ctc_01","type":"custom_tool_call","call_id":"call_abc","name":"exec","input":"const rs = await Promise.all([\\n  tools.exec_command({cmd:\\"git diff\\"})\\n]);\\n"}],"usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150}}}\n\n'
  ].join('');

  const info = extractResponseInfo('openai', streamSse);
  assert.equal(info.toolCalls.length, 1);
  assert.equal(info.toolCalls[0].id, 'call_abc');
  assert.equal(info.toolCalls[0].name, 'exec');
  assert.ok(info.toolCalls[0].args.includes('tools.exec_command'));
  assert.equal(info.usage.input_tokens, 100);
  assert.equal(info.usage.output_tokens, 50);
});

test('detectAgent identifies Antigravity (WebSearch) for web_search requestType', () => {
  const agent = detectAgent(
    { 'user-agent': 'antigravity/hub/2.17.0' },
    '/v1internal:generateContent',
    { requestType: 'web_search' }
  );
  assert.equal(agent, 'Antigravity (WebSearch)');
});

test('extractResponseInfo accurately extracts response text from direct non-SSE Gemini JSON payload', () => {
  const directJson = JSON.stringify({
    response: {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'Full markdown table content without truncation' }]
          },
          finishReason: 'STOP'
        }
      ],
      usageMetadata: {
        promptTokenCount: 97,
        candidatesTokenCount: 440,
        totalTokenCount: 537
      }
    }
  });

  const info = extractResponseInfo('gemini', directJson);
  assert.equal(info.responseText, 'Full markdown table content without truncation');
  assert.equal(info.usage.input_tokens, 97);
  assert.equal(info.usage.output_tokens, 440);
  assert.equal(info.finishReason, 'STOP');
});

test('dissectPromptAnatomy accurately calculates 0 history for single-turn Gemini request and prevents raw subtraction bloat', () => {
  const singleTurnRecord = {
    provider: 'gemini',
    model: 'gemini-3.1-flash-lite',
    system_prompt: 'You are a helpful web search agent.',
    user_prompt: 'what is the latest weather in Tokyo',
    input_tokens: 120,
    request_body: JSON.stringify({
      project: 'aicode-consumers',
      request: {
        systemInstruction: {
          parts: [{ text: 'You are a helpful web search agent.' }]
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: 'what is the latest weather in Tokyo' }]
          }
        ],
        tools: [
          {
            functionDeclarations: [
              { name: 'search', description: 'Search the web' }
            ]
          }
        ]
      }
    })
  };

  const anatomy = dissectPromptAnatomy(singleTurnRecord);
  const historyLayer = anatomy.layers.find((l) => l.id === 'history_artifacts');
  assert.ok(historyLayer, 'history_artifacts layer should exist');
  assert.equal(historyLayer.chars, 0, 'Single-turn history chars must strictly be 0');
  assert.equal(historyLayer.percentage, 0, 'Single-turn history percentage must strictly be 0%');
  assert.ok(historyLayer.content.includes('首轮对话'), 'Content should indicate first turn');
});

test('dissectPromptAnatomy accurately calculates multi-turn history and tool injections from AST', () => {
  // 1. Gemini multi-turn
  const geminiMultiTurnRecord = {
    provider: 'gemini',
    system_prompt: 'System prompt instructions',
    user_prompt: 'What did I say earlier?',
    input_tokens: 500,
    request_body: JSON.stringify({
      contents: [
        { role: 'user', parts: [{ text: 'Hello, my name is Alice.' }] },
        { role: 'model', parts: [{ text: 'Nice to meet you, Alice!' }] },
        { role: 'user', parts: [{ text: 'What did I say earlier?' }] }
      ]
    })
  };

  const geminiAnatomy = dissectPromptAnatomy(geminiMultiTurnRecord);
  const geminiHistory = geminiAnatomy.layers.find((l) => l.id === 'history_artifacts');
  const expectedHistoryChars = 'Hello, my name is Alice.'.length + 'Nice to meet you, Alice!'.length;
  assert.equal(geminiHistory.chars, expectedHistoryChars);
  assert.ok(geminiHistory.chars > 0);
  assert.ok(geminiHistory.content.includes('Alice'));

  // 2. OpenAI Codex Responses API multi-turn with tool output
  const codexRecord = {
    provider: 'openai',
    user_prompt: 'Fix the bug',
    input_tokens: 600,
    request_body: JSON.stringify({
      input: [
        { type: 'message', role: 'user', content: 'Please inspect app.ts' },
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"app.ts"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'export const app = true;' },
        { type: 'message', role: 'user', content: 'Fix the bug' }
      ]
    })
  };

  const codexAnatomy = dissectPromptAnatomy(codexRecord);
  const codexHistory = codexAnatomy.layers.find((l) => l.id === 'history_artifacts');
  assert.ok(codexHistory.chars > 0);
  assert.ok(codexHistory.content.includes('Codex Output: call_1'));
});

test('StorageEngine Version 4 schema persists response_text, thinking_text, is_subagent, and subagent_type with backfill', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-m1-'));
  const dbFile = path.join(tempDir, 'test.db');
  try {
    const storage = new StorageEngine(dbFile);

    // 1. Insert record with new v4 fields
    const testRecord = {
      event_id: 'evt_v4_test_01',
      session_id: 'sess_v4',
      provider: 'gemini',
      model: 'gemini-3.1-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 120,
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 0,
      total_tokens: 150,
      cache_ratio: 0,
      system_prompt: 'System prompt',
      prompt_summary: 'Test summary',
      response_preview: 'Preview 200 chars...',
      response_text: 'Complete un-truncated model response text with tables and markdown details.',
      thinking_text: 'Deep thinking process steps...',
      is_subagent: 1,
      subagent_type: 'web_search',
      request_headers: '{}',
      request_body: '{}',
      response_body: '{"candidates":[{"content":{"parts":[{"text":"Complete un-truncated model response text with tables and markdown details."}]}}]}',
      raw_usage: '{}',
      created_at: new Date().toISOString()
    };

    storage.insertRecord(testRecord);

    const records = storage.getRecords({ limit: 10, offset: 0, sessionId: 'sess_v4' });
    assert.equal(records.length, 1);
    const saved = records[0];
    assert.equal(saved.response_text, 'Complete un-truncated model response text with tables and markdown details.');
    assert.equal(saved.thinking_text, 'Deep thinking process steps...');
    assert.equal(saved.is_subagent, 1);
    assert.equal(saved.subagent_type, 'web_search');

    // 2. Historical backfill test
    // Insert older record where response_text is null, then close and re-open to trigger backfill
    storage.db.prepare(`
      INSERT INTO records (
        session_id, provider, model, method, url_path, status_code, duration_ms,
        input_tokens, output_tokens, cached_tokens, total_tokens, cache_ratio,
        system_prompt, prompt_summary, response_preview, response_text,
        request_headers, request_body, response_body, raw_usage, created_at, schema_version
      ) VALUES (
        'sess_old', 'gemini', 'gemini-3.1-pro', 'POST', '/v1internal', 200, 100,
        10, 20, 0, 30, 0,
        '', 'old prompt', 'short preview', NULL,
        '{}', '{}', '{"candidates":[{"content":{"parts":[{"text":"Recovered from old raw response body"}]}}]}', '{}', '2026-09-01T00:00:00Z', 3
      )
    `).run();

    // Reopen DB to trigger initDb migration & backfill
    storage.db.close();
    const storageReopened = new StorageEngine(dbFile);
    const oldRecs = storageReopened.getRecords({ limit: 10, offset: 0, sessionId: 'sess_old' });
    assert.equal(oldRecs.length, 1);
    assert.equal(oldRecs[0].response_text, 'Recovered from old raw response body');

    storageReopened.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('StorageEngine refresh reclassifies historical Agents without altering response text', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-v5-'));
  const dbFile = path.join(tempDir, 'test.db');
  try {
    const storage = new StorageEngine(dbFile);

    // Seed historical records with version manually downgraded to 4
    const codexHeaders = JSON.stringify({
      'user-agent': 'Codex Desktop/0.158.0-alpha.2.1 (Mac OS 15.4.0; arm64) WarpTerminal/v0.2026.09.02.08.27.stable_01 (Codex Desktop; 26.924.22138)',
      originator: 'Codex Desktop'
    });
    const piHeaders = JSON.stringify({
      'user-agent': 'pi (darwin 24.4.0; arm64)'
    });
    const genuinePiHeaders = JSON.stringify({
      'user-agent': 'pi/0.87.1'
    });

    storage.db.prepare(`
      INSERT INTO records (session_id, agent_name, provider, model, url_path, request_headers, created_at)
      VALUES
        ('sess_misclassified_codex', 'Pi Agent', 'openai', 'gpt-6-astra', '/v1/responses', ?, '2026-10-01 06:00:00'),
        ('sess_old_pi', 'OpenAI Agent', 'openai', 'gemini-3.8-flash-high', '/v1/messages', ?, '2026-09-29 10:00:00'),
        ('sess_genuine_pi', 'Pi Agent', 'openai', 'openrouter/stealth/space-bunny-alpha', '/v1/messages', ?, '2026-09-29 12:00:00')
    `).run(codexHeaders, piHeaders, genuinePiHeaders);
    storage.db.prepare(
      `INSERT INTO records (session_id, agent_name, provider, model, response_text, created_at)
       VALUES ('sess_legitimate_repeat', 'Codex', 'openai', 'gpt-6-astra', ?, '2026-09-29 13:00:00')`
    ).run('ha haha ha');
    const seededIds = storage.db.prepare('SELECT id FROM records ORDER BY id ASC').all().map((r) => r.id);

    // Rollback user_version to 4 to simulate an existing database before identity migrations
    storage.db.pragma('user_version = 4');
    storage.close();

    // Reopen DB to trigger the identity migrations
    const storageV5 = new StorageEngine(dbFile);
    const ver = Number(storageV5.db.pragma('user_version', { simple: true }));
    assert.equal(ver, 19, 'Database user_version must include historical identity and attribution invalidation migrations');

    const fixedCodex = storageV5.getRecordById(seededIds[0]);
    assert.equal(fixedCodex.agent_name, 'Codex', 'Misclassified Pi Agent must be healed to Codex');

    const fixedPi = storageV5.getRecordById(seededIds[1]);
    assert.equal(fixedPi.agent_name, 'Pi Agent', 'Historical OpenAI Agent from Pi must be healed to Pi Agent');

    const genuinePi = storageV5.getRecordById(seededIds[2]);
    assert.equal(genuinePi.agent_name, 'Pi Agent', 'Genuine Pi record must remain Pi Agent');

    const legitimateRepeat = storageV5.getRecordById(seededIds[3]);
    assert.equal(legitimateRepeat.response_text, 'ha haha ha', 'A repeated phrase without raw proof must remain intact');

    storageV5.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('SchemaRegistry loads custom schema from JSON file and adapts to novel protocol without code recompilation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-m2-'));
  const schemaFile = path.join(tempDir, 'custom_schemas.json');
  try {
    const customConfig = [
      {
        id: 'kimi_moonshot_custom',
        name: 'Kimi Moonshot Custom',
        provider: 'openai',
        textPaths: ['moonshot.output.text'],
        thinkingPaths: ['moonshot.output.reasoning_steps'],
        finishReasonPaths: ['moonshot.status'],
        usage: {
          input_tokens: 'moonshot.usage.in',
          output_tokens: 'moonshot.usage.out'
        }
      }
    ];
    fs.writeFileSync(schemaFile, JSON.stringify(customConfig));

    const registry = new SchemaRegistry(schemaFile);
    assert.equal(registry.loadCustomSchemas(), 1);

    const syntheticKimiPayload = {
      moonshot: {
        output: {
          text: 'Here is the answer parsed via declarative schema!',
          reasoning_steps: 'Step 1: Analyzed input. Step 2: Formulated response.'
        },
        status: 'finished',
        usage: {
          in: 128,
          out: 64
        }
      }
    };

    const ctx = registry.extract([syntheticKimiPayload], 'openai');
    assert.equal(ctx.textSegments.join(''), 'Here is the answer parsed via declarative schema!');
    assert.equal(ctx.thinkingSegments.join(''), 'Step 1: Analyzed input. Step 2: Formulated response.');
    assert.equal(ctx.finishReason, 'finished');
    assert.equal(ctx.inTok, 128);
    assert.equal(ctx.outTok, 64);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('SchemaRegistry programmatically registers runtime schema with priority override', () => {
  const registry = new SchemaRegistry();
  registry.register({
    id: 'test_runtime_schema',
    name: 'Test Runtime Override',
    provider: 'gemini',
    priority: 999,
    textPaths: ['custom_gemini_wrapper.message.body'],
    thinkingPaths: ['custom_gemini_wrapper.message.thoughts'],
    finishReasonPaths: ['custom_gemini_wrapper.complete_reason'],
    usage: {
      input_tokens: 'custom_gemini_wrapper.usage.in_tokens',
      output_tokens: 'custom_gemini_wrapper.usage.out_tokens'
    }
  });

  const payload = {
    custom_gemini_wrapper: {
      message: {
        body: 'Custom gemini extracted string',
        thoughts: 'Step-by-step thinking'
      },
      complete_reason: 'DONE',
      usage: {
        in_tokens: 300,
        out_tokens: 150
      }
    }
  };

  const ctx = registry.extract([payload], 'gemini');
  assert.equal(ctx.textSegments.join(''), 'Custom gemini extracted string');
  assert.equal(ctx.thinkingSegments.join(''), 'Step-by-step thinking');
  assert.equal(ctx.finishReason, 'DONE');
  assert.equal(ctx.inTok, 300);
  assert.equal(ctx.outTok, 150);
});

test('Adaptive Heuristic Probe unpacks text, thinking and tools without inferring usage from unknown numeric fields', () => {
  const unseenProtocolPayload = JSON.stringify({
    novel_pipeline_v1: {
      telemetry: {
        in_tokens: 512,
        out_tokens: 256,
        status: 'finished'
      },
      thought_process: 'Step 1: Computed topological defects in cosmic inflation.',
      primary_output: {
        reply: 'Cosmic strings are 1D topological defects formed during phase transitions in the early universe.'
      },
      invocations: [
        {
          tool_name: 'query_astronomy_catalog',
          parameters: { catalog: 'NGC_4258', band: 'X-ray' },
          call_id: 'call_cosmic_007'
        }
      ]
    }
  });

  const res = extractResponseInfo('unknown', unseenProtocolPayload);
  assert.equal(res.confidence, 'heuristic');
  assert.equal(res.responseText, 'Cosmic strings are 1D topological defects formed during phase transitions in the early universe.');
  assert.equal(res.thinkingText, 'Step 1: Computed topological defects in cosmic inflation.');
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, 'query_astronomy_catalog');
  assert.equal(res.toolCalls[0].id, 'call_cosmic_007');
  assert.equal(res.toolCalls[0].args.catalog, 'NGC_4258');
  assert.equal(res.finishReason, 'finished');
  assert.equal(res.usage.input_tokens, 0);
  assert.equal(res.usage.output_tokens, 0);
  assert.equal(res.usage.token_source, 'unavailable');
});

test('Adaptive Heuristic Probe benchmarks under 15ms for a massive 2MB payload', () => {
  const bigList = [];
  for (let i = 0; i < 2000; i++) {
    bigList.push({
      item_id: i,
      data_chunk: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(15)
    });
  }

  const payload = {
    enterprise_data_lake: {
      records: bigList,
      pipeline_status: 'completed',
      computation_metrics: {
        prompt_tokens: 2048,
        completion_tokens: 1024
      },
      thought_process: 'Analyzed all 2000 records successfully.',
      final_result: {
        message: 'Aggregated statistical analysis is complete.'
      }
    }
  };

  const rawJson = JSON.stringify(payload);
  const sizeMb = rawJson.length / (1024 * 1024);
  assert.ok(sizeMb > 1.5, 'Payload should exceed 1.5MB for benchmark');

  const t0 = performance.now();
  const res = extractResponseInfo('unknown', rawJson);
  const durationMs = performance.now() - t0;

  assert.equal(res.confidence, 'heuristic');
  assert.equal(res.responseText, 'Aggregated statistical analysis is complete.');
  assert.equal(res.thinkingText, 'Analyzed all 2000 records successfully.');
  assert.equal(res.usage.input_tokens, 0);
  assert.equal(res.usage.output_tokens, 0);
  assert.equal(res.usage.token_source, 'unavailable');
  assert.ok(durationMs < 50, `Execution time was ${durationMs.toFixed(2)}ms (expected < 50ms)`);
});

test('Sanitizer redacts Bearer tokens, API keys, home directories, and emails', () => {
  const dirty = [
    'Authorization: Bearer ya29.a0AfH6SMBadSecretToken1234567890',
    'OpenAI: sk-proj-abc123456789012345678901234567890',
    'Google: AIzaSyD-abc12345678901234567890123456',
    'Mac Path: /Users/testuser/Desktop/secret_project/config.yaml',
    'Linux Path: /home/testadmin/data/records.sqlite',
    'Windows Path: C:\\Users\\Administrator\\AppData\\Local\\Token.txt',
    'Contact: author@example.invalid for info'
  ].join('\n');

  const clean = sanitizeText(dirty);

  assert.ok(!clean.includes('ya29.a0AfH6SMBadSecretToken1234567890'));
  assert.ok(clean.includes('Bearer [REDACTED_TOKEN]'));

  assert.ok(!clean.includes('sk-proj-abc123456789012345678901234567890'));
  assert.ok(clean.includes('sk-[REDACTED_API_KEY]'));

  assert.ok(!clean.includes('AIzaSyD-abc12345678901234567890123456'));
  assert.ok(clean.includes('AIza[REDACTED_GOOGLE_KEY]'));

  assert.ok(!clean.includes('/Users/testuser/'));
  assert.ok(clean.includes('/Users/[USER]/Desktop/secret_project/config.yaml'));

  assert.ok(!clean.includes('/home/testadmin/'));
  assert.ok(clean.includes('/home/[USER]/data/records.sqlite'));

  assert.ok(!clean.includes('Administrator'));
  assert.ok(clean.includes('C:\\Users\\[USER]\\AppData\\Local\\Token.txt'));

  assert.ok(!clean.includes('author@example.invalid'));
  assert.ok(clean.includes('[REDACTED_EMAIL]'));
});

test('Sanitizer headers redacts authorization headers and scrubs paths', () => {
  const headers = {
    'Authorization': 'Bearer super_secret_token_1234567890',
    'Cookie': 'session_token=secret_cookie_val_123',
    'x-api-key': 'secret_key_abc',
    'user-agent': 'LLM-Client at /Users/developer/bin/app',
    'accept': 'application/json'
  };

  const cleanHeaders = sanitizeHeaders(headers);

  assert.equal(cleanHeaders['Authorization'], '[REDACTED]');
  assert.equal(cleanHeaders['Cookie'], '[REDACTED]');
  assert.equal(cleanHeaders['x-api-key'], '[REDACTED]');
  assert.equal(cleanHeaders['user-agent'], 'LLM-Client at /Users/[USER]/bin/app');
  assert.equal(cleanHeaders['accept'], 'application/json');
});

test('createSanitizedFixture produces complete sanitized fixture payload', () => {
  const rawRecord = {
    id: 5122,
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    agent_name: 'Antigravity (WebSearch)',
    method: 'POST',
    url_path: '/v1beta/models/gemini-2.5-pro:generateContent',
    status_code: 200,
    request_headers: JSON.stringify({
      authorization: 'Bearer secret_token_xyz_987654321',
      host: 'generativelanguage.googleapis.com'
    }),
    request_body: 'Check path /Users/testauthor/Desktop/myProjects for api_key sk-12345678901234567890123456',
    response_body: 'Found file at /Users/testauthor/test.txt with email admin@example.invalid',
    response_text: 'Result in /Users/testauthor/test.txt',
    thinking_text: 'Examining user home /Users/testauthor/myProjects',
    input_tokens: 300,
    output_tokens: 150,
    cached_tokens: 50,
    thinking_tokens: 30,
    total_tokens: 450,
    finish_reason: 'STOP',
    confidence: 'exact'
  };

  const fixture = createSanitizedFixture(rawRecord);

  assert.equal(fixture.id, 5122);
  assert.equal(fixture.provider, 'gemini');
  assert.equal(fixture.model, 'gemini-2.5-pro');
  assert.equal(fixture.agent_name, 'Antigravity (WebSearch)');
  assert.equal(fixture.request_headers['authorization'], '[REDACTED]');
  assert.equal(fixture.request_headers['host'], 'generativelanguage.googleapis.com');

  assert.ok(!fixture.request_body.includes('testauthor'));
  assert.ok(!fixture.request_body.includes('sk-12345678901234567890123456'));
  assert.ok(fixture.request_body.includes('/Users/[USER]/Desktop/myProjects'));
  assert.ok(fixture.request_body.includes('sk-[REDACTED_API_KEY]'));

  assert.ok(!fixture.response_body.includes('testauthor'));
  assert.ok(!fixture.response_body.includes('admin@example.invalid'));
  assert.ok(fixture.response_body.includes('[REDACTED_EMAIL]'));

  assert.ok(!fixture.extracted_meta.response_text.includes('testauthor'));
  assert.ok(!fixture.extracted_meta.thinking_text.includes('testauthor'));
  assert.equal(fixture.extracted_meta.input_tokens, 300);
  assert.equal(fixture.extracted_meta.output_tokens, 150);
  assert.equal(fixture.extracted_meta.total_tokens, 450);
});

test('WebServer /api/records/:id/fixture returns sanitized fixture with 200 or 404', async (t) => {
  const tmpDbPath = temporaryDatabase(t);
  const storage = new StorageEngine(tmpDbPath);
  const certMgr = {
    getFingerprint: () => 'A1:B2',
    getCertPaths: () => ({ caCertPath: '/tmp/ca.crt', exists: true }),
    prepareAgentCaBundle: () => '/tmp/ca.bundle'
  };

  const recId = storage.insertRecord({
    session_id: 'session_fixture_test',
    client_ip: '127.0.0.1',
    agent_name: 'Antigravity',
    provider: 'openai',
    model: 'gpt-4o',
    method: 'POST',
    url_path: '/v1/chat/completions',
    status_code: 200,
    duration_ms: 320,
    request_headers: {
      'authorization': 'Bearer sk-super-secret-token-abcdef1234567890',
      'host': 'api.openai.com'
    },
    request_body: 'Hello from /Users/testauthor/code',
    response_body: 'Reply with token sk-123456789012345678901234567890',
    response_text: 'Clean reply',
    input_tokens: 120,
    output_tokens: 80,
    total_tokens: 200,
    finish_reason: 'stop',
    confidence: 'exact'
  });

  const web = new WebServer(storage, certMgr, 0);

  try {
    // 1. Success case: GET /api/records/:id/fixture
    const res = await web.app.inject({
      method: 'GET',
      url: `/api/records/${recId}/fixture`,
      headers: { host: '127.0.0.1' }
    });

    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);

    assert.equal(data.id, recId);
    assert.equal(data.provider, 'openai');
    assert.equal(data.model, 'gpt-4o');
    assert.equal(data.request_headers['authorization'], '[REDACTED]');
    assert.ok(data.request_body.includes('/Users/[USER]/code'));
    assert.ok(!data.request_body.includes('testauthor'));
    assert.ok(!data.response_body.includes('sk-123456789012345678901234567890'));
    assert.ok(data.response_body.includes('sk-[REDACTED_API_KEY]'));

    // 2. Not found case: GET /api/records/9999999/fixture
    const res404 = await web.app.inject({
      method: 'GET',
      url: '/api/records/9999999/fixture',
      headers: { host: '127.0.0.1' }
    });

    assert.equal(res404.statusCode, 404);
  } finally {
    await web.stop();
    storage.close();
    try { fs.unlinkSync(tmpDbPath); } catch {}
  }
});

test('isSubagentRecord universally identifies subagent indicators across platforms', () => {
  // 1. Explicit database tag
  assert.equal(isSubagentRecord({ is_subagent: 1 }), true);
  assert.equal(isSubagentRecord({ subagent_type: 'web_search' }), true);

  // 2. Agent naming indicators (Antigravity, Claude Code, custom worker)
  assert.equal(isSubagentRecord({ agent_name: 'Antigravity (WebSearch)' }), true);
  assert.equal(isSubagentRecord({ agent_name: 'Claude Code (SubAgent)' }), true);
  assert.equal(isSubagentRecord({ agent_name: 'TestWorker' }), true);
  assert.equal(isSubagentRecord({ agent_name: 'Code-Review-Tool-Runner' }), true);

  // 3. System prompt persona signatures
  assert.equal(isSubagentRecord({ system_prompt: 'You are a search engine bot. Your task is to perform search.' }), true);
  assert.equal(isSubagentRecord({ system_prompt: 'You are an autonomous research agent assisting the primary model.' }), true);

  // 4. Request body signatures (Antigravity web_search, OpenAI role: subagent)
  assert.equal(isSubagentRecord({ request_body: '{"project":"test","requestType":"web_search"}' }), true);
  assert.equal(isSubagentRecord({ request_body: '{"messages":[{"role":"subagent","content":"inspect"}]}' }), true);

  // 5. Normal human user chat is NOT a subagent
  assert.equal(isSubagentRecord({
    is_subagent: 0,
    agent_name: 'Antigravity',
    system_prompt: 'You are an AI coding assistant.',
    user_prompt: '帮我重构代码',
    request_body: '{"project":"test","contents":[{"role":"user","parts":[{"text":"帮我重构代码"}]}]}'
  }), false);
});

test('clusterRecordsIntoTasks applies Plan B: folds subagent records into parent turn and hides from top task list', () => {
  // Scenario:
  // User triggers a task (#101).
  // Model thinks and triggers a web search tool call (#102).
  // Antigravity launches subagent requests (#103, #104) with lighter model (flash-lite).
  // Model receives tool feedback and completes the answer (#105).
  const records = [
    {
      id: 101,
      session_id: 'sess_main_claude_1', // A matching session is required for parent attachment.
      agent_name: 'Antigravity',
      model: 'claude-opus-4-6-thinking',
      created_at: '2026-09-28 10:00:00',
      user_prompt: '帮我搜索并对比 Opus 4.6 与 Google 模型性能',
      prompt_summary: '1 msgs',
      response_preview: '我来为你搜索相关评测数据...',
      status_code: 200,
      input_tokens: 300,
      output_tokens: 100
    },
    {
      id: 102,
      session_id: 'sess_main_claude_1',
      agent_name: 'Antigravity',
      model: 'claude-opus-4-6-thinking',
      created_at: '2026-09-28 10:00:05',
      user_prompt: '帮我搜索并对比 Opus 4.6 与 Google 模型性能',
      prompt_summary: '2 msgs',
      response_preview: '[Tool Call] search_web',
      tool_calls_json: JSON.stringify([{ name: 'search_web', args: { query: 'Opus 4.6 vs Google benchmark' } }]),
      status_code: 200,
      input_tokens: 500,
      output_tokens: 50
    },
    {
      id: 103,
      session_id: 'sess_main_claude_1',
      agent_name: 'Antigravity (WebSearch)',
      model: 'gemini-3.1-flash-lite',
      created_at: '2026-09-28 10:00:08',
      is_subagent: 1,
      subagent_type: 'web_search',
      user_prompt: 'Opus 4.6 vs Google benchmark 2026',
      response_preview: '| Metric | Opus 4.6 | Gemini 3.8 |',
      response_text: '| Metric | Opus 4.6 | Gemini 3.8 |\n|---|---|---|\n| SWE-bench | 72% | 71% |',
      status_code: 200,
      duration_ms: 1200,
      input_tokens: 200,
      output_tokens: 150
    },
    {
      id: 104,
      session_id: 'sess_main_claude_1',
      agent_name: 'Antigravity',
      model: 'claude-opus-4-6-thinking',
      created_at: '2026-09-28 10:00:15',
      user_prompt: '帮我搜索并对比 Opus 4.6 与 Google 模型性能',
      prompt_summary: '3 msgs | Last: [Tool Result: search_web]',
      response_preview: '根据最新评测，Opus 4.6 在软件工程基准上表现卓越...',
      response_text: '根据最新评测，Opus 4.6 在软件工程基准上表现卓越...',
      status_code: 200,
      input_tokens: 900,
      output_tokens: 400
    }
  ];

  const tasks = clusterRecordsIntoTasks(records);

  // 1. Plan B Requirement: The subagent request MUST NOT create a standalone task card!
  assert.equal(tasks.length, 1, 'Subagent must NOT produce an independent session card in task list');

  const mainTask = tasks[0];
  assert.equal(mainTask.user_prompt, '帮我搜索并对比 Opus 4.6 与 Google 模型性能');
  assert.equal(mainTask.turns.length, 3, 'Main task has 3 main turns');

  // 2. Plan B Requirement: Turn 2 (which triggered the tool call) must nest Record #103!
  const turn2 = mainTask.turns[1];
  assert.equal(turn2.record_id, 102);
  assert.ok(turn2.subagents, 'Turn 2 must have subagents list attached');
  assert.equal(turn2.subagents.length, 1);

  const sub = turn2.subagents[0];
  assert.equal(sub.record_id, 103);
  assert.equal(sub.agent_name, 'Antigravity (WebSearch)');
  assert.equal(sub.model, 'gemini-3.1-flash-lite');
  assert.equal(sub.user_prompt, 'Opus 4.6 vs Google benchmark 2026');
  assert.ok(sub.response_text.includes('SWE-bench'));
  assert.equal(sub.duration_ms, 1200);
});

test('multi-turn tail diff isolation accurately folds 100+ history turns and isolates only active tail', () => {
  // Simulate Gemini protocol with 184 contents items
  const mockGeminiContents = [];
  for (let i = 0; i < 90; i++) {
    mockGeminiContents.push({ role: 'user', parts: [{ text: `User request ${i}` }] });
    mockGeminiContents.push({ role: 'model', parts: [{ text: `Model answer ${i}`, functionCall: { name: 'run_cmd' } }] });
  }
  // Now tail has 1 tool response
  mockGeminiContents.push({ role: 'user', parts: [{ text: 'User follow up' }] });
  mockGeminiContents.push({ role: 'model', parts: [{ text: 'Model thought' }] });
  mockGeminiContents.push({ role: 'model', parts: [{ functionResponse: { name: 'run_cmd', response: { out: 'done' } } }] });

  // Function implementation mirroring extractTailDiffAndHistory
  let lastModelIdx = -1;
  for (let i = mockGeminiContents.length - 1; i >= 0; i--) {
    const m = mockGeminiContents[i];
    if (m.role === 'model') {
      const parts = m.parts || [];
      if (parts.some((p) => p.text || p.functionCall || p.thought)) {
        lastModelIdx = i;
        break;
      }
    }
  }

  const splitIdx = lastModelIdx + 1;
  const historyCount = splitIdx;
  const diffCount = mockGeminiContents.length - splitIdx;

  assert.equal(diffCount, 1, 'Only the active tail functionResponse is treated as diff');
  assert.equal(historyCount, mockGeminiContents.length - 1, 'All previous turns are correctly folded as history');
});

test('CoreManager prompt_summary and parseRequestTurnPayload omit msgs prefixes and resolve tool results across protocols', (t) => {
  const { CoreManager } = require('../dist/main/core');
  const { parseRequestTurnPayload, cleanPromptSummary } = require('../dist/shared/protocol');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-summary-'));
  const storage = new StorageEngine(path.join(tmpDir, 'test.db'));
  t.after(() => {
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const core = new CoreManager(storage);

  // 1. Anthropic tool_result request
  const antReq = JSON.stringify({
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'user', content: '查看当前目录' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'run_command', input: { cmd: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md\nsrc' }] }
    ]
  });
  const antId = core.handleCapturePayload({
    event_id: 'ant-tool-1',
    url_path: '/v1/messages',
    request_headers: { 'anthropic-version': '2023-06-01' },
    request_body: antReq,
    response_body: JSON.stringify({ content: [{ type: 'text', text: '目录已列出' }], usage: { input_tokens: 10, output_tokens: 5 } })
  });
  const antRec = storage.getRecordById(antId);
  assert.equal(antRec.prompt_summary, '[Tool Result: run_command]');
  assert.doesNotMatch(antRec.prompt_summary, /msgs|Last:/);
  const antParsed = parseRequestTurnPayload(antReq);
  assert.equal(antParsed.historyCount, 2);
  assert.equal(antParsed.newText, '');
  assert.deepEqual(antParsed.toolResults, [{ name: 'run_command', output: 'README.md\nsrc' }]);

  // 2. OpenAI Responses API with top-level function_call and function_call_output
  const respReq = JSON.stringify({
    model: 'gpt-5',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '执行状态检查' }] },
      { type: 'function_call', call_id: 'call_99', name: 'run_command', arguments: '{"cmd":"git status"}' },
      { type: 'function_call_output', call_id: 'call_99', output: 'clean tree' }
    ]
  });
  const respParsed = parseRequestTurnPayload(respReq);
  assert.equal(respParsed.historyCount, 2, 'function_call and prior user input must fold into historyCount');
  assert.equal(respParsed.newText, '', 'prior user input must not repeat in tool result turn');
  assert.deepEqual(respParsed.toolResults, [{ name: 'run_command', output: 'clean tree' }]);

  // 3. OpenAI Chat Completions with role: 'tool'
  const chatReq = JSON.stringify({
    model: 'gpt-4o',
    messages: [
      { role: 'user', content: '读取配置' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tc_1', content: '{"port":8080}' }
    ]
  });
  const chatId = core.handleCapturePayload({
    event_id: 'chat-tool-1',
    url_path: '/v1/chat/completions',
    request_headers: { host: 'api.openai.com' },
    request_body: chatReq,
    response_body: JSON.stringify({ choices: [{ message: { content: '端口为 8080' } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })
  });
  assert.equal(storage.getRecordById(chatId).prompt_summary, '[Tool Result: read_file]');
  const chatParsed = parseRequestTurnPayload(chatReq);
  assert.equal(chatParsed.historyCount, 2);
  assert.equal(chatParsed.newText, '');
  assert.deepEqual(chatParsed.toolResults, [{ name: 'read_file', output: '{"port":8080}' }]);

  // 4. Legacy summary cleaner strips N msgs and N msgs | Last:
  assert.equal(cleanPromptSummary('3 msgs | Last: [Tool Result: run_command]'), '[Tool Result: run_command]');
  assert.equal(cleanPromptSummary('2 msgs'), '');
});

test('history preserves OpenAI assistant content, reasoning and complete tool calls', () => {
  const { parseRequestTurnPayload, extractMsgText } = require('../dist/shared/protocol');
  const messages = [
    { role: 'user', content: 'Earlier user' },
    { role: 'assistant', content: [{type: 'text', text: 'Assistant text'}], reasoning: 'Reasoning text', tool_calls: [
      { id: 'call-a', type: 'function', function: { name: 'first', arguments: '{"count":1}' } },
      { id: 'call-b', type: 'function', function: { name: 'second', arguments: { nested: 2 } } }
    ] },
    { role: 'tool', tool_call_id: 'call-a', content: 'Tool output' }
  ];
  const raw = JSON.stringify({ messages });
  const original = JSON.parse(raw);
  const parsed = parseRequestTurnPayload(raw);
  assert.equal(parsed.historyCount, 2);
  const history = parsed.historyMessages[1].text;
  for (const expected of ['Assistant text', 'Reasoning text', 'call-a', 'call-b', 'first', 'second', 'count', 'nested']) assert.ok(history.includes(expected), expected);
  assert.equal(parsed.newText, '');
  assert.deepEqual(parsed.toolResults, [{ name: 'first', output: 'Tool output' }]);
  assert.deepEqual(JSON.parse(raw), original, 'presentation leaves original request unchanged');
  const missing = parseRequestTurnPayload(JSON.stringify({ messages: [
    {role:'assistant', tool_calls:[{id:'call-c', type:'function', function:{name:'third', arguments:null}}]},
    {role:'tool', tool_call_id:'call-c', content:'Result'}
  ]}));
  assert.match(missing.historyMessages[0].text, /call-c/);
  assert.match(missing.historyMessages[0].text, /third/);
  assert.match(missing.historyMessages[0].text, /null/);
  const unusual = parseRequestTurnPayload(JSON.stringify({ messages: [
    {role:'assistant', content:[{type:'image_ref', image_ref:{id:'img-synthetic'}}], reasoning:{kind:'synthetic'}, tool_calls:null},
    {role:'user', content:'Next question'}
  ]}));
  for (const expected of ['image_ref', 'img-synthetic', 'kind', 'synthetic', 'null']) assert.ok(unusual.historyMessages[0].text.includes(expected));
  assert.equal(unusual.newText, 'Next question');
  const otherProtocol = parseRequestTurnPayload(JSON.stringify({contents:[
    {role:'model', parts:[{text:'Ordinary model output'}]},
    {role:'user', parts:[{text:'Next question'}]}
  ]}));
  assert.equal(otherProtocol.historyMessages[0].text, 'Ordinary model output');
  assert.equal(extractMsgText({role:'user',content:'ordinary'}), 'ordinary');
  assert.equal(extractMsgText({role:'assistant',content:'ordinary'}), 'ordinary');
});
