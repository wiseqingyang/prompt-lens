const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { StorageEngine } = require('../dist/main/storage');
const { getAgentCategory } = require('../dist/shared/agent');
const { clusterRecordsIntoSessions } = require('../dist/main/session');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-refresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'lens.db');
}

test('refresh batches compressed records, isolates missing evidence and preserves raw data', (t) => {
  const file = fixture(t);
  let storage = new StorageEngine(file);
  const body = JSON.stringify({ metadata: { thread_id: 'thread', parent_request_id: 'parent' }, input: 'x'.repeat(800) });
  for (let i = 0; i < 205; i++) storage.insertRecord({
    request_id: `req-${i}`, agent_name: 'wrong', session_id: 'obsolete', input_tokens: 10,
    request_headers: { 'user-agent': 'pi/1.0' }, request_body: body
  });
  const missingId = storage.insertRecord({ request_id: 'missing', agent_name: 'wrong', session_id: 'obsolete' });
  const malformedId = storage.insertRecord({ request_id: 'invalid', request_body: '{broken', request_headers: { 'x-pi-session-id': 'pi-session' } });
  storage.db.prepare('UPDATE records SET request_body = ? WHERE id <= 205').run(require('node:zlib').deflateRawSync(Buffer.from(body)));
  const before = storage.db.prepare('SELECT id, request_body, input_tokens FROM records ORDER BY id').all();
  assert.equal(storage.db.prepare('SELECT typeof(request_body) t FROM records LIMIT 1').get().t, 'blob');
  storage.db.pragma('user_version = 8');
  storage.close();
  storage = new StorageEngine(file);
  try {
    assert.equal(storage.db.pragma('user_version', { simple: true }), 19);
    assert.equal(storage.getRecords({ limit: -1, sessionId: 'thread' }).length, 0, 'Pi cannot adopt unverified generic metadata');
    const piRows = storage.getRecords({ limit: -1 }).filter(row => row.agent_name === 'Pi Agent');
    assert.equal(piRows.length, 205);
    assert.ok(piRows.every(row => row.session_confidence === 'unknown'));
    assert.equal(new Set(piRows.map(row => row.session_id)).size, 205, 'missing native evidence keeps every request isolated');
    assert.equal(storage.getRecordById(1).agent_name, 'Pi Agent');
    assert.equal(storage.getRecordById(1).parent_request_id, 'parent');
    assert.equal(storage.getRecordById(missingId).session_id, 'unknown:missing');
    assert.equal(storage.getRecordById(missingId).agent_name, 'Agent');
    assert.equal(storage.getRecordById(malformedId).session_id, 'pi-session');
    assert.deepEqual(storage.db.prepare('SELECT id, request_body, input_tokens FROM records ORDER BY id').all(), before);
    const refreshed = storage.getRecords({ limit: -1 });
    assert.deepEqual(storage.rebuildRecordIdentities(), { processed: 207, unreadableBodies: 1 });
    assert.deepEqual(storage.getRecords({ limit: -1 }), refreshed);
  } finally { storage.close(); }
});

test('failed refresh rolls back every row and leaves schema version unchanged', (t) => {
  const file = fixture(t);
  let storage = new StorageEngine(file);
  for (let i = 0; i < 2; i++) storage.insertRecord({ session_id: 'obsolete', agent_name: 'old', request_headers: { 'user-agent': 'pi/1' } });
  storage.db.exec("CREATE TRIGGER reject_second BEFORE UPDATE ON records WHEN OLD.id = 2 BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;");
  storage.db.pragma('user_version = 8');
  storage.close();
  assert.throws(() => new StorageEngine(file), /synthetic write failure/);
  const db = new Database(file);
  assert.equal(db.pragma('user_version', { simple: true }), 8);
  assert.deepEqual(db.prepare('SELECT DISTINCT agent_name FROM records').all(), [{ agent_name: 'old' }]);
  db.exec('DROP TRIGGER reject_second');
  db.close();
  storage = new StorageEngine(file);
  assert.equal(storage.getRecordById(1).agent_name, 'Pi Agent');
  storage.close();
});

test('all statistics filters and breakdowns share classification including whitespace and precedence', (t) => {
  const storage = new StorageEngine(fixture(t));
  try {
    const names = ['Copilot', 'Pi Agent', ' pi(foo)', 'pi\tcustom', 'Pi custom', 'pi-coding-agent', '@earendil-works/pi', 'pi codex', 'pi antigravity', 'API client', '', 'Claude Code'];
    names.forEach((agent_name, i) => storage.insertRecord({ agent_name, model: `model-${i}`, total_tokens: i + 1 }));
    const day = storage.db.prepare("SELECT date('now', 'localtime') AS day").get().day;
    const all = storage.getDailyTokenActivity('all');
    for (const category of ['Codex', 'Antigravity', 'Pi', 'Other']) {
      const indices = names.flatMap((name, i) => getAgentCategory(name) === category ? [i] : []);
      const total = indices.reduce((sum, i) => sum + i + 1, 0);
      assert.equal(storage.getDailyTokenActivity(category).total_tokens, total);
      assert.equal(all.days[0].agent_breakdown[category], total);
      assert.deepEqual(storage.getDayModelUsage(day, category).map(r => r.model).sort(), indices.map(i => `model-${i}`).sort());
      assert.equal(storage.getDayTokenDetails(day, category).length, indices.length);
    }
  } finally { storage.close(); }
});

test('identical prompts and raw session ids cannot merge tasks across Agent categories', () => {
  const sessions = clusterRecordsIntoSessions([
    { id: 1, session_id: 'shared', user_prompt: 'same', agent_name: 'Pi Agent', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, session_id: 'shared', user_prompt: 'same', agent_name: 'Copilot', created_at: '2026-01-01T00:01:00Z' }
  ]);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map(s => s.turns_count), [1, 1]);
});

test('refresh waits for an active writer before reading its migration snapshot', async (t) => {
  const { Worker } = require('node:worker_threads');
  const file = fixture(t);
  let storage = new StorageEngine(file);
  storage.insertRecord({ agent_name: 'old', request_headers: {} });
  storage.db.pragma('user_version = 8');
  storage.close();
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.module);
    const db = new Database(workerData.file);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE records SET request_headers = ?').run(JSON.stringify({ 'user-agent': 'pi/1' }));
    parentPort.postMessage('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 200);
  `, { eval: true, workerData: { file, module: require.resolve('better-sqlite3') } });
  const done = new Promise((resolve, reject) => { worker.on('exit', resolve); worker.on('error', reject); });
  await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  try {
    storage = new StorageEngine(file);
    assert.equal(storage.db.pragma('user_version', { simple: true }), 19);
    assert.equal(storage.getRecordById(1).agent_name, 'Pi Agent');
  } finally { storage.close(); await done; }
});
