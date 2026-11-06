const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveSessionIdentity,
  resolveRequestParents,
  clusterRecordsIntoSessions,
  clusterRecordsIntoTasks,
  paginateSessions
} = require('../dist/main/session');
const { StorageEngine } = require('../dist/main/storage');
const { WebServer } = require('../dist/main/web');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const codexContext = { agent_name: 'Codex', schemaVersion: '2.0.0', transport: 'https' };
const codexUA = { 'user-agent': 'Codex Desktop/0.162.0-alpha.17.2' };

// 回归场景 1: 同一 thread_id、不同 turn_id：归入同一 session
test('regression: same thread_id with different turn_id clusters into same session', () => {
  const records = [
    { id: 1, session_id: 'thread-alpha', thread_id: 'thread-alpha', turn_id: 'turn-001', user_prompt: 'step 1', agent_name: 'Codex', model: 'gpt-5', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, session_id: 'thread-alpha', thread_id: 'thread-alpha', turn_id: 'turn-002', user_prompt: 'step 2', agent_name: 'Codex', model: 'gpt-5', created_at: '2026-01-01T00:00:10Z' }
  ];
  const sessions = clusterRecordsIntoSessions(records);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].session_id, 'thread-alpha');
  assert.equal(sessions[0].turns_count, 2);
  assert.equal(sessions[0].tasks_count, 2);
});

// 回归场景 2: 不同 thread_id、相同 Prompt：归入不同 session
test('regression: different thread_id with identical prompt clusters into different sessions', () => {
  const records = [
    { id: 1, session_id: 'thread-1', thread_id: 'thread-1', user_prompt: '继续执行', agent_name: 'Codex', model: 'gpt-5', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, session_id: 'thread-2', thread_id: 'thread-2', user_prompt: '继续执行', agent_name: 'Codex', model: 'gpt-5', created_at: '2026-01-01T00:00:01Z' }
  ];
  const sessions = clusterRecordsIntoSessions(records);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].session_id !== sessions[1].session_id, true);
});

// 回归场景 3: 相同 prompt_cache_key、不同 thread：不能合并
test('regression: same prompt_cache_key across different threads or requests cannot merge', () => {
  const ident1 = resolveSessionIdentity({}, { prompt_cache_key: 'shared-cache-key-123' }, 'openai', 'gpt-5', { request_id: 'req-cache-1' });
  const ident2 = resolveSessionIdentity({}, { prompt_cache_key: 'shared-cache-key-123' }, 'openai', 'gpt-5', { request_id: 'req-cache-2' });
  assert.equal(ident1.confidence, 'heuristic');
  assert.equal(ident2.confidence, 'heuristic');
  assert.equal(ident1.id, 'unknown:req-cache-1');
  assert.equal(ident2.id, 'unknown:req-cache-2');
  assert.notEqual(ident1.id, ident2.id);

  const sessions = clusterRecordsIntoSessions([
    { id: 1, session_id: ident1.id, session_confidence: 'heuristic', request_id: 'req-cache-1', user_prompt: 'test prompt', agent_name: 'Agent', model: 'gpt-5', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, session_id: ident2.id, session_confidence: 'heuristic', request_id: 'req-cache-2', user_prompt: 'test prompt', agent_name: 'Agent', model: 'gpt-5', created_at: '2026-01-01T00:00:01Z' }
  ]);
  assert.equal(sessions.length, 2);
});

// 回归场景 4: 两个无 ID 的并发请求：不能自动合并
test('regression: two concurrent requests without any ID cannot merge', () => {
  const ident1 = resolveSessionIdentity({}, null, 'openai', 'gpt-5', { request_id: 'req-anonymous-1' });
  const ident2 = resolveSessionIdentity({}, null, 'openai', 'gpt-5', { request_id: 'req-anonymous-2' });
  assert.equal(ident1.id, 'unknown:req-anonymous-1');
  assert.equal(ident2.id, 'unknown:req-anonymous-2');
  assert.notEqual(ident1.id, ident2.id);

  // 若数据库中两条记录完全缺失 session_id 与 request_id
  const tasks = clusterRecordsIntoTasks([
    { id: 101, user_prompt: '并发提问 A', agent_name: 'Agent', created_at: '2026-01-01T00:00:00Z' },
    { id: 102, user_prompt: '并发提问 B', agent_name: 'Agent', created_at: '2026-01-01T00:00:00Z' }
  ]);
  assert.equal(tasks.length, 2);
  assert.notEqual(tasks[0].session_id, tasks[1].session_id);
});

// 回归场景 5: 合法和非法 x-codex-turn-metadata 都能安全处理
test('regression: valid and invalid x-codex-turn-metadata are handled safely', () => {
  const valid = resolveSessionIdentity({
    ...codexUA, 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'thread-valid', turn_id: 'turn-valid' })
  }, null, 'openai', 'gpt-5', codexContext);
  assert.equal(valid.id, 'thread-valid');
  assert.equal(valid.turn_id, 'turn-valid');
  assert.equal(valid.confidence, 'exact');

  const invalid = resolveSessionIdentity({
    ...codexUA, 'x-codex-turn-metadata': '{"broken_json'
  }, null, 'openai', 'gpt-5', { ...codexContext, request_id: 'req-safe' });
  assert.equal(invalid.id, 'unknown:req-safe');
  assert.equal(invalid.confidence, 'unknown');
});

// 首版契约：未经证实的别名不提供轮次，更不能作为会话兜底。
test('regression: unsupported turn header cannot manufacture a session or indexed turn', () => {
  const ident = resolveSessionIdentity({
    ...codexUA, 'x-codex-turn-id': 'turn-only-value'
  }, null, 'openai', 'gpt-5', { ...codexContext, request_id: 'req-turn-test' });
  assert.equal(ident.turn_id, undefined);
  assert.equal(ident.id, 'unknown:req-turn-test');
  assert.notEqual(ident.id, 'turn-only-value');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-turn-id-'));
  const storage = new StorageEngine(path.join(dir, 'turn.db'));
  try {
    const id = storage.insertRecord({
      session_id: ident.id,
      turn_id: ident.turn_id,
      request_id: 'req-turn-test',
      user_prompt: 'test'
    });
    const record = storage.getRecordById(id);
    assert.ok(record);
    assert.equal(record.session_id, 'unknown:req-turn-test');
    assert.equal(record.turn_id, '');
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 回归场景 7: 同一 session 重复输入相同 Prompt：形成不同任务
test('regression: duplicate prompt in same session creates different tasks', () => {
  const records = [
    { id: 1, session_id: 'thread-loop', thread_id: 'thread-loop', turn_id: 'turn-1', user_prompt: '重试', agent_name: 'Codex', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, session_id: 'thread-loop', thread_id: 'thread-loop', turn_id: 'turn-2', user_prompt: '重试', agent_name: 'Codex', created_at: '2026-01-01T00:00:10Z' }
  ];
  const tasks = clusterRecordsIntoTasks(records);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].session_id, 'thread-loop');
  assert.equal(tasks[1].session_id, 'thread-loop');
  assert.notEqual(tasks[0].id, tasks[1].id);
});

// 回归场景 8: 两个交错 session 的子 Agent 不能跨会话挂载
test('regression: subagents from interleaved sessions never attach across sessions', () => {
  const records = [
    { id: 1, session_id: 'session-A', thread_id: 'session-A', request_id: 'parent-A', user_prompt: 'query A', agent_name: 'Codex', response_preview: '[Tool Call] search' },
    { id: 2, session_id: 'session-B', thread_id: 'session-B', request_id: 'parent-B', user_prompt: 'query B', agent_name: 'Codex', response_preview: '[Tool Call] search' },
    { id: 3, session_id: 'session-B', thread_id: 'session-B', parent_request_id: 'parent-A', is_subagent: 1, subagent_type: 'search', agent_name: 'WebSearch', user_prompt: 'query A' }
  ];
  const tasks = clusterRecordsIntoTasks(records);
  // 子 Agent 带有 parent-A (来自 session-A)，但其 session_id 为 session-B，必须严禁挂载到 session-A 或 session-B
  const allSubagents = tasks.flatMap((t) => t.turns.flatMap((turn) => turn.subagents || []));
  assert.equal(allSubagents.length, 0);
});

// 回归场景 9: 重复 event_id 不产生重复记录
test('regression: duplicate event_id is deduplicated without duplicate rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-event-dedup-'));
  const storage = new StorageEngine(path.join(dir, 'dedup.db'));
  try {
    const id1 = storage.insertRecord({
      event_id: 'evt-unique-12345',
      session_id: 'sess-1',
      user_prompt: 'first insertion',
      agent_name: 'Agent'
    });
    const id2 = storage.insertRecord({
      event_id: 'evt-unique-12345',
      session_id: 'sess-1',
      user_prompt: 'second duplicate insertion',
      agent_name: 'Agent'
    });
    assert.equal(id1, id2);
    const records = storage.getRecords({ limit: 10 });
    assert.equal(records.length, 1);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 回归场景 10: 旧 legacy 数据仍能正常读取
test('regression: historical records without identity evidence are refreshed to isolated identities', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-legacy-schema-'));
  const dbPath = path.join(dir, 'legacy.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY,
      session_id TEXT DEFAULT '',
      agent_name TEXT DEFAULT 'Agent',
      user_prompt TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO records (session_id, user_prompt) VALUES (?, ?)').run('legacy-session-999', 'old prompt');
  db.close();

  const storage = new StorageEngine(dbPath);
  try {
    const records = storage.getRecords({ limit: 10 });
    assert.equal(records.length, 1);
    const row = records[0];
    assert.equal(row.session_id, 'unknown:record:1');
    assert.equal(row.session_id_source, 'unknown');
    assert.equal(row.session_confidence, 'unknown');
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex metadata groups by thread and preserves turn id', () => {
  const a = resolveSessionIdentity({
    ...codexUA, 'X-Codex-Turn-Metadata': JSON.stringify({ thread_id: 'thread-a', session_id: 'window-1', turn_id: 'turn-1' }),
    'X-Codex-Turn-Id': 'turn-1'
  }, null, 'openai', 'gpt-5', codexContext);
  assert.equal(a.id, 'thread-a');
  assert.equal(a.turn_id, 'turn-1');
  assert.equal(a.confidence, 'exact');
  assert.equal(resolveSessionIdentity({ 'x-codex-turn-id': 'turn-2' }, null, 'openai', 'gpt-5').id, 'unknown');
});

test('Codex session metadata without a thread stays unassigned', () => {
  const identity = resolveSessionIdentity({
    ...codexUA, 'x-codex-turn-metadata': JSON.stringify({ session_id: 'window-only' })
  }, null, 'openai', 'gpt-5', codexContext);
  assert.equal(identity.id, 'unknown');
  assert.equal(identity.source, 'unknown');
  assert.equal(identity.confidence, 'unknown');
  assert.equal(identity.thread_id, undefined);
});

test('parent request and event ids are read case-insensitively', () => {
  const parents = resolveRequestParents({ 'X-Parent-Request-Id': 'req-parent' }, { metadata: { parent_event_id: 'evt-parent' } });
  assert.equal(parents.parent_request_id, 'req-parent');
  assert.equal(parents.parent_event_id, 'evt-parent');
});

test('regression: explicit parent_request_id links an异名 subagent without heuristic gating', () => {
  const tasks = clusterRecordsIntoTasks([
    {
      id: 1,
      session_id: 'session-parent',
      thread_id: 'thread-parent',
      request_id: 'parent-req',
      user_prompt: '查资料',
      agent_name: 'Antigravity',
      response_preview: '[Tool Call] web_search',
      created_at: '2026-01-01T00:00:00Z'
    },
    {
      id: 2,
      session_id: 'session-parent',
      thread_id: 'thread-parent',
      parent_request_id: 'parent-req',
      is_subagent: 1,
      subagent_type: 'web_search',
      user_prompt: '查资料',
      agent_name: 'WebSearch',
      created_at: '2026-01-01T01:00:00Z',
      response_preview: 'result'
    }
  ]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].turns[0].subagents.length, 1);
  assert.equal(tasks[0].turns[0].subagents[0].agent_name, 'WebSearch');
});

test('regression: ReAct request ids remain in one task until the final response', () => {
  const tasks = clusterRecordsIntoTasks([
    { id: 1, session_id: 'react-session', request_id: 'req-1', user_prompt: '修复测试', agent_name: 'Codex', response_preview: '[Tool Call] read_file', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, session_id: 'react-session', request_id: 'req-2', user_prompt: '修复测试', agent_name: 'Codex', response_preview: '已修复', created_at: '2026-01-01T00:00:01Z' }
  ]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].turns_count, 2);
});

test('regression: parent_event_id is persisted and returned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-parent-event-'));
  const storage = new StorageEngine(path.join(dir, 'lineage.db'));
  try {
    const id = storage.insertRecord({
      event_id: 'child-event',
      parent_event_id: 'parent-event',
      session_id: 'session-lineage',
      agent_name: 'WebSearch',
      user_prompt: 'child'
    });
    assert.equal(storage.getRecordById(id).parent_event_id, 'parent-event');
    assert.equal(storage.getRecords({ limit: 10 })[0].parent_event_id, 'parent-event');
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Session aggregation groups Tasks without merging different sessions', () => {
  const sessions = clusterRecordsIntoSessions([
    { id: 1, session_id: 'thread-a', thread_id: 'thread-a', turn_id: 'turn-1', request_id: 'r1', user_prompt: 'a', agent_name: 'Codex', model: 'gpt', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, session_id: 'thread-a', thread_id: 'thread-a', turn_id: 'turn-2', request_id: 'r2', user_prompt: 'b', agent_name: 'Codex', model: 'gpt', created_at: '2026-01-01T00:00:01Z' },
    { id: 3, session_id: 'thread-b', thread_id: 'thread-b', turn_id: 'turn-3', request_id: 'r3', user_prompt: 'a', agent_name: 'Codex', model: 'gpt', created_at: '2026-01-01T00:00:02Z' }
  ]);
  assert.equal(sessions.length, 2);
  const threadA = sessions.find((s) => s.session_id === 'thread-a');
  assert.equal(threadA.tasks_count, 2);
  assert.equal(threadA.turns_count, 2);
  assert.equal(paginateSessions(sessions, { limit: 1 }).has_more, true);
});

test('WebServer exposes the /api/sessions contract', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-session-api-'));
  const storage = new StorageEngine(path.join(dir, 'sessions.db'));
  storage.insertRecord({ transport: 'https', schema_version: '2.0.0', request_headers: codexUA, request_body: JSON.stringify({ client_metadata: { thread_id: 'thread-api', turn_id: 'turn-api' } }), session_id: 'thread-api', session_id_source: 'thread_id', session_confidence: 'exact', thread_id: 'thread-api', request_id: 'req-api', agent_name: 'Codex', provider: 'openai', model: 'gpt', method: 'POST', url_path: '/v1/responses', status_code: 200, duration_ms: 10, user_prompt: 'hello', response_preview: 'done' });
  const cert = { getCertPaths: () => ({ caCertPath: '', exists: false }), prepareAgentCaBundle: () => '', getFingerprint: () => '' };
  const web = new WebServer(storage, cert);
  try {
    const response = await web.app.inject({ method: 'GET', url: '/api/sessions?limit=10', headers: { host: '127.0.0.1' } });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.total, 1);
    assert.equal(body.sessions[0].session_id, 'thread-api');
    assert.equal(body.sessions[0].tasks_count, 1);
  } finally {
    await web.stop();
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Session API contract returns one normalized session shape', () => {
  const { clusterTasksIntoSessions } = require('../dist/main/session.js');
  const tasks = [
    { id: 't1', session_id: 'sess-contract', user_prompt: 'task 1', created_at: '2026-01-01T00:00:00Z', model: 'gpt', agent_name: 'Codex', turns: [{ record_id: 1 }], turns_count: 1, total_duration_ms: 10, total_input_tokens: 100, total_cached_tokens: 10, total_thinking_tokens: 0, total_output_tokens: 20 },
    { id: 't2', session_id: 'sess-contract', user_prompt: 'task 2', created_at: '2026-01-01T00:01:00Z', model: 'gpt', agent_name: 'Codex', turns: [{ record_id: 2 }], turns_count: 1, total_duration_ms: 20, total_input_tokens: 200, total_cached_tokens: 20, total_thinking_tokens: 0, total_output_tokens: 40 }
  ];
  const [session] = clusterTasksIntoSessions(tasks);
  assert.equal(session.id, 'session:sess-contract:Codex');
  assert.equal(session.tasks_count, 2);
  assert.equal(session.turns_count, 2);
  assert.equal(session.total_input_tokens, 300);
  assert.ok(Array.isArray(session.tasks));
});

test('same raw session id from different Agent families remains visible in separate groups', () => {
  const { clusterRecordsIntoSessions } = require('../dist/main/session.js');
  const sessions = clusterRecordsIntoSessions([
    { id: 1, session_id: 'shared-id', user_prompt: 'pi', created_at: '2026-01-01T00:00:00Z', model: 'm', agent_name: 'Pi Agent' },
    { id: 2, session_id: 'shared-id', user_prompt: 'other', created_at: '2026-01-01T00:01:00Z', model: 'm', agent_name: 'Copilot' }
  ]);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((session) => session.agent_name).sort(), ['Copilot', 'Pi Agent']);
});
