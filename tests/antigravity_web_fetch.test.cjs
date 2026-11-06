const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { extractRequestInfo, extractResponseInfo } = require('../dist/main/parser');
const { CoreManager } = require('../dist/main/core');
const { StorageEngine } = require('../dist/main/storage');
const { clusterRecordsIntoTasks } = require('../dist/main/session');

const fetchPath = '/v1internal:fetchFromTrawlerCache';
const generatePath = '/v1internal:streamGenerateContent?alt=sse';
const html = '<!doctype html><html><body>' + 'page content '.repeat(100) + '</body></html>';
const page = JSON.stringify({ content: html });
const notFound = JSON.stringify({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } });
const usageMetadata = { promptTokenCount: 120, candidatesTokenCount: 8, cachedContentTokenCount: 50,
  thoughtsTokenCount: 7, totalTokenCount: 135 };
const stream = [
  { response: { candidates: [{ content: { role: 'model', parts: [{ thought: true, text: 'Reasoning' }] } }] } },
  { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Fetching a page.' },
    { functionCall: { id: 'call_1', name: 'read_url_content', args: { Url: 'https://example.com/' } } }] }, finishReason: 'STOP' }], usageMetadata } }
].map(c => `data: ${JSON.stringify(c)}\r\n\r\n`).join('');

test('page cache RPCs preserve their result without estimating LLM usage', () => {
  for (const urlPath of [fetchPath, fetchPath + '?alt=json', 'https://example.com' + fetchPath]) {
    const request = extractRequestInfo('gemini', '{"url":"https://example.com/","liveFetch":true}', urlPath);
    assert.equal(request.model, 'web-fetch');
    assert.deepEqual(request.messages, []);
    for (const body of [page, notFound, '', '{broken']) {
      const parsed = extractResponseInfo('gemini', body, urlPath);
      assert.equal(parsed.usage.total_tokens, 0);
      assert.equal(parsed.usage.output_tokens, 0);
      assert.notEqual(parsed.usage.token_source, 'estimated');
      assert.deepEqual(parsed.toolCalls, []);
      assert.ok(!parsed.responseText.includes('<html>'));
    }
  }
  assert.match(extractResponseInfo('gemini', page, fetchPath).responseText, /网页抓取成功/);
  assert.equal(extractResponseInfo('gemini', notFound, fetchPath).finishReason, 'NOT_FOUND');
  // A lookalike endpoint must continue using its ordinary protocol parser.
  assert.equal(extractResponseInfo('unknown', '{"content":"hello"}', fetchPath + 'Extra').responseText, 'hello');
});

test('real Gemini calls retain reported usage, reasoning, tools and wrapped metadata', () => {
  const parsed = extractResponseInfo('gemini', stream, generatePath);
  assert.deepEqual(parsed.usage.raw_details, usageMetadata);
  assert.equal(parsed.usage.token_source, 'reported');
  assert.equal(parsed.usage.total_tokens, 135);
  assert.equal(parsed.responseText, 'Fetching a page.');
  assert.equal(parsed.thinkingText, 'Reasoning');
  assert.equal(parsed.toolCalls[0].name, 'read_url_content');
  assert.equal(parsed.finishReason, 'STOP');
  const request = extractRequestInfo('gemini', JSON.stringify({ request: { contents: [
    { role: 'model', parts: [{ functionResponse: { name: 'read_url_content', response: { output: 'Fetched content' } } }] }
  ] } }), generatePath);
  assert.equal(request.messages[0].role, 'tool');
  assert.equal(request.messages[0].text, 'Fetched content');
});

test('capture keeps raw page fetches and labels cache hits and misses as tool operations', () => {
  const records = [];
  const core = new CoreManager({ insertRecord: r => { records.push(r); return records.length; } });
  for (const [body, status_code, liveFetch] of [[page, 200, true], [notFound, 404, false]]) {
    assert.ok(core.handleCapturePayload({ url_path: fetchPath, status_code,
      request_body: JSON.stringify({ url: 'https://example.com/', liveFetch }), response_body: body,
      request_headers: { 'user-agent': 'antigravity/fixture' } }));
  }
  assert.match(records[0].prompt_summary, /实时.*example.com/);
  assert.match(records[1].prompt_summary, /缓存.*example.com/);
  for (const record of records) {
    assert.equal(record.total_tokens, 0);
    assert.equal(record.user_prompt, '');
    assert.equal(record.model, 'web-fetch');
    assert.equal(record.token_source, 'unavailable');
    assert.ok(record.response_body);
  }
  assert.deepEqual(clusterRecordsIntoTasks(records), []);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-web-fetch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'lens.db');
}

test('migration repairs compressed history, preserves captures and excludes fetches from model statistics', t => {
  const file = fixture(t);
  let storage = new StorageEngine(file);
  const fetchId = storage.insertRecord({ provider: 'gemini', url_path: fetchPath,
    request_body: '{"url":"https://example.com/","liveFetch":true}', response_body: page,
    output_tokens: 500, total_tokens: 500, token_source: 'estimated', response_text: html });
  const modelId = storage.insertRecord({ provider: 'gemini', url_path: generatePath, model: 'gemini-fixture',
    request_body: '{"request":{"contents":[{"role":"user","parts":[{"text":"research"}]}]}}', response_body: stream,
    input_tokens: 120, output_tokens: 8, total_tokens: 135, response_text: 'Fetching a page.' });
  const prunedId = storage.insertRecord({ provider: 'gemini', url_path: generatePath, total_tokens: 1000,
    response_text: 'Prior answer', response_body: '' });
  const before = storage.db.prepare('SELECT id, request_body, response_body FROM records').all();
  storage.db.pragma('user_version = 9');
  storage.close();
  storage = new StorageEngine(file);
  try {
    const fetch = storage.getRecordById(fetchId);
    assert.equal(fetch.total_tokens, 0);
    assert.equal(fetch.model, 'web-fetch');
    assert.match(fetch.prompt_summary, /example.com/);
    assert.equal(fetch.response_text, html, 'schema upgrade preserves the saved content');
    assert.deepEqual(storage.getRecordById(modelId).raw_usage, usageMetadata);
    assert.equal(storage.getRecordById(modelId).total_tokens, 135);
    assert.equal(storage.getRecordById(prunedId).total_tokens, 1000);
    assert.equal(storage.getRecordById(prunedId).response_text, 'Prior answer');
    assert.deepEqual(storage.db.prepare('SELECT id, request_body, response_body FROM records').all(), before);
    assert.equal(storage.getRecords({ limit: -1 }).length, 3, 'raw records remain inspectable');
    assert.equal(storage.getStats().total_requests, 2);
    assert.equal(storage.getStats().total_tokens, 1135);
    const day = storage.db.prepare("SELECT date('now', 'localtime') day").get().day;
    assert.equal(storage.getDailyTokenActivity().days[0].request_count, 2);
    assert.ok(storage.getDayModelUsage(day).every(r => r.model !== 'web-fetch'));
    assert.ok(storage.getDayTokenDetails(day).every(r => r.id !== fetchId));
    // Content reinterpretation is explicit; retain the existing repair behavior and its assertions.
    storage.repairAntigravityRecords();
    assert.match(storage.getRecordById(fetchId).response_text, /网页抓取成功/);
    const repaired = storage.getRecords({ limit: -1 });
    storage.repairAntigravityRecords();
    assert.deepEqual(storage.getRecords({ limit: -1 }), repaired, 'repair is idempotent');
  } finally { storage.close(); }
});

test('failed history repair rolls back updates and does not mark the migration complete', t => {
  const file = fixture(t);
  const storage = new StorageEngine(file);
  for (let i = 0; i < 2; i++) storage.insertRecord({ provider: 'gemini', url_path: fetchPath,
    response_body: page, total_tokens: 500, response_text: html });
  storage.db.exec("CREATE TRIGGER reject_second BEFORE UPDATE ON records WHEN OLD.id = 2 BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;");
  storage.db.pragma('user_version = 9');
  storage.close();
  assert.throws(() => new StorageEngine(file), /synthetic write failure/);
  const db = new Database(file);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 9);
    assert.deepEqual(db.prepare('SELECT total_tokens FROM records').all(), [{ total_tokens: 500 }, { total_tokens: 500 }]);
  } finally { db.close(); }
});
