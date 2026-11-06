const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { StorageEngine } = require('../dist/main/storage');

test('StorageEngine insertRecord is idempotent with event_id deduplication', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-storage-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  try {
    const storage = new StorageEngine(dbPath);

    const record = {
      event_id: 'evt_unique_1001',
      request_id: 'req_1001',
      sequence: 1,
      core_instance_id: 'core_inst_1',
      capture_status: 'complete',
      session_id: 'sess_1',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-1.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 500,
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 20,
      thinking_tokens: 0,
      total_tokens: 150,
      cache_ratio: 20.0,
      system_prompt: '',
      prompt_summary: 'test prompt',
      user_prompt: 'hello',
      response_preview: 'hi',
      request_headers: {},
      request_body: '',
      response_body: '',
      raw_usage: {}
    };

    // First insert
    const id1 = storage.insertRecord(record);
    assert.ok(id1 > 0);

    // Duplicate insert with same event_id
    const id2 = storage.insertRecord(record);
    assert.equal(id2, id1, 'Duplicate event_id must return existing record ID');

    // Verify record count is exactly 1, not 2
    const allRecords = storage.getRecords();
    assert.equal(allRecords.length, 1);

    // Verify token stats are not double counted
    const stats = storage.getStats();
    assert.equal(stats.total_requests, 1);
    assert.equal(stats.total_tokens, 150);
    assert.equal(stats.total_input_tokens, 100);
    assert.equal(stats.total_output_tokens, 50);

    storage.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('StorageEngine safely migrates old schema where agent_name is missing without index error', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-migration-test-'));
  const dbPath = path.join(tmpDir, 'old.db');
  try {
    // 1. Create old database lacking agent_name, thinking_tokens, event_id
    const rawDb = new Database(dbPath);
    rawDb.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, session_id TEXT, created_at TIMESTAMP)');
    rawDb.close();

    // 2. Open with StorageEngine: must not throw "no such column: agent_name"
    const storage = new StorageEngine(dbPath);

    // 3. Verify that all columns now exist
    const insertedId = storage.insertRecord({
      session_id: 's1',
      agent_name: 'Claude Code',
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      method: 'POST',
      url_path: '/v1/messages',
      status_code: 200,
      duration_ms: 100,
      input_tokens: 10,
      output_tokens: 10,
      cached_tokens: 0,
      thinking_tokens: 0,
      total_tokens: 20,
      cache_ratio: 0,
      system_prompt: '',
      prompt_summary: '',
      user_prompt: 'test',
      response_preview: '',
      request_headers: {},
      request_body: '',
      response_body: '',
      raw_usage: {}
    });
    assert.ok(insertedId > 0);

    const fetched = storage.getRecordById(insertedId);
    assert.equal(fetched.agent_name, 'Claude Code');

    storage.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
