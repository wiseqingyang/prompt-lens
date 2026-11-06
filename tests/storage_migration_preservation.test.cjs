const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { StorageEngine } = require('../dist/main/storage');
const { CONTENT_FIELDS } = require('../dist/main/content-store');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-preserve-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'lens.db');
}
function migrate(storage) { while (storage.migrateContentBatch(10)) {} }
function assertContent(row, expected) {
  for (const field of CONTENT_FIELDS) assert.deepEqual(Buffer.from(row[field]), Buffer.from(expected[field] || ''), `${field} must preserve stored bytes`);
}
function legacy9(storage) {
  for (const { name } of storage.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) storage.db.exec(`DROP TRIGGER ${name}`);
  storage.db.exec('DROP VIEW usage_events; DROP TABLE usage_ledger; DROP TABLE storage_metadata; DROP TABLE content_refs; DROP TABLE content_fields; DROP TABLE content_blocks; DROP INDEX idx_records_content_pending; ALTER TABLE records DROP COLUMN content_expired;');
  storage.db.pragma('user_version = 9');
}

test('schema 9 upgrade preserves Gemini and Web Fetch content while repairing usage; explicit repair still works', t => {
  const file = fixture(t);
  let storage = new StorageEngine(file);
  const model = {
    request_body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Synthetic request 中文🙂' }] }] }),
    response_body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Reparsed answer' }, { thought: true, text: 'Reparsed thought' }] } }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 8, thoughtsTokenCount: 7, totalTokenCount: 135 } }),
    system_prompt: '旧系统🙂\u0000', response_text: '旧的已存回复🙂\u0000', thinking_text: '旧的已存思考🙂'
  };
  const fetch = { request_body: '{"url":"https://example.com/","liveFetch":true}', response_body: '{"content":"<html>synthetic page</html>"}',
    system_prompt: '旧抓取上下文', response_text: '<html>旧已存正文</html>', thinking_text: '旧抓取备注' };
  const modelId = storage.insertRecord({ event_id: 'preserve-model', provider: 'gemini', model: 'synthetic-gemini',
    url_path: '/v1internal:streamGenerateContent?alt=sse', total_tokens: 1, token_source: 'estimated', ...model });
  const fetchId = storage.insertRecord({ event_id: 'preserve-fetch', provider: 'gemini', url_path: '/v1internal:fetchFromTrawlerCache',
    total_tokens: 500, token_source: 'estimated', ...fetch });
  legacy9(storage);
  for (const [id, values] of [[modelId, model], [fetchId, fetch]]) storage.db.prepare('UPDATE records SET request_body=?, response_body=? WHERE id=?').run(
    zlib.deflateRawSync(Buffer.from(values.request_body)), zlib.deflateRawSync(Buffer.from(values.response_body)), id);
  storage.close();
  try {
    storage = new StorageEngine(file);
    assertContent(storage.getRecordById(modelId), model);
    assertContent(storage.getRecordById(fetchId), fetch);
    assert.equal(storage.getRecordById(modelId).total_tokens, 135);
    assert.equal(storage.getRecordById(modelId).token_source, 'reported');
    assert.equal(storage.getRecordById(fetchId).total_tokens, 0);
    assert.equal(storage.getRecordById(fetchId).model, 'web-fetch');
    assert.equal(storage.getStats().total_tokens, 135);
    storage.migrateContentBatch(2);
    storage.close(); storage = new StorageEngine(file);
    migrate(storage);
    const refs = storage.db.prepare('SELECT COUNT(*) c FROM content_refs').get().c;
    storage.close(); storage = new StorageEngine(file);
    assertContent(storage.getRecordById(modelId), model);
    assertContent(storage.getRecordById(fetchId), fetch);
    assert.equal(storage.db.prepare('SELECT COUNT(*) c FROM content_refs').get().c, refs);
    assert.equal(storage.db.prepare('SELECT COUNT(*) c FROM usage_ledger').get().c, 2);
    assert.equal(storage.getStats().total_tokens, 135);
    storage.db.prepare("UPDATE records SET total_tokens=9, token_source='estimated' WHERE id=?").run(modelId);
    assert.equal(storage.getStats().total_tokens, 9, 'correction is reflected in the ledger');
    storage.repairAntigravityRecords();
    assert.equal(storage.getRecordById(modelId).response_text, 'Reparsed answer');
    assert.equal(storage.getRecordById(modelId).thinking_text, 'Reparsed thought');
    assert.match(storage.getRecordById(fetchId).response_text, /网页抓取成功/);
    assert.equal(storage.getRecordById(modelId).request_body, model.request_body);
    assert.equal(storage.getRecordById(modelId).response_body, model.response_body);
    migrate(storage);
    assert.equal(storage.getRecordById(modelId).response_text, 'Reparsed answer');
    assert.equal(storage.getStats().total_tokens, 135);
  } finally { storage.close(); }
});

test('reply stored in blocks is not treated as missing when a raw response is staged later', t => {
  const file = fixture(t);
  let storage = new StorageEngine(file);
  const id = storage.insertRecord({ event_id: 'preserve-block-reply', provider: 'openai', response_text: 'Stored reply 中文🙂', thinking_text: 'Stored thought' });
  migrate(storage);
  storage.db.prepare('UPDATE records SET response_body=? WHERE id=?').run(JSON.stringify({ choices: [{ message: { content: 'Different parsed reply' } }] }), id);
  storage.close();
  try {
    storage = new StorageEngine(file);
    assert.equal(storage.getRecordById(id).response_text, 'Stored reply 中文🙂');
    assert.equal(storage.getRecordById(id).thinking_text, 'Stored thought');
    assert.equal(storage.db.prepare("SELECT COUNT(*) c FROM content_fields WHERE record_id=? AND field='response_text'").get(id).c, 1);
  } finally { storage.close(); }
});

test('reopening a database never automatically shortens a nonempty Codex reply with raw proof', t => {
  const file = fixture(t);
  let storage = new StorageEngine(file);
  const short = 'Confirmed short reply 中文🙂';
  const content = { request_body: '{"input":"synthetic question"}', response_body: JSON.stringify({ output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: short }] }
  ] }), response_text: short + short, thinking_text: 'Original stored thought', system_prompt: 'Original system' };
  const id = storage.insertRecord({ event_id: 'preserve-codex', agent_name: 'Codex', provider: 'openai', response_preview: content.response_text, ...content });
  storage.close();
  try {
    storage = new StorageEngine(file);
    assertContent(storage.getRecordById(id), content);
    assert.equal(storage.getRecordById(id).response_preview, content.response_text);
    migrate(storage);
    storage.close(); storage = new StorageEngine(file);
    assertContent(storage.getRecordById(id), content);
  } finally { storage.close(); }
});

test('missing reply backfill preserves previously stored thinking in legacy and migrated formats', async t => {
  for (const migrated of [false, true]) await t.test(migrated ? 'thinking already stored in shared blocks' : 'thinking still stored as text', t => {
    const file = fixture(t);
    let storage = new StorageEngine(file);
    const thinking = 'Existing thinking 中文🙂\u0000';
    const id = storage.insertRecord({ event_id: 'preserve-thinking', provider: 'openai', thinking_text: thinking });
    if (migrated) migrate(storage);
    const raw = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Recovered reply', reasoning_content: 'Newly reparsed thinking' } }] });
    storage.db.prepare('UPDATE records SET response_body=? WHERE id=?').run(zlib.deflateRawSync(Buffer.from(raw)), id);
    storage.close();
    try {
      storage = new StorageEngine(file);
      assert.equal(storage.getRecordById(id).response_text, 'Recovered reply');
      assert.equal(storage.getRecordById(id).thinking_text, thinking);
      if (migrated) assert.equal(storage.db.prepare("SELECT COUNT(*) c FROM content_fields WHERE record_id=? AND field='thinking_text'").get(id).c, 1);
    } finally { storage.close(); }
  });
});
