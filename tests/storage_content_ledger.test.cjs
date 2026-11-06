const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { StorageEngine, decompressBody } = require('../dist/main/storage');
const { CHUNK_V1, chunkContent } = require('../dist/main/content-store');
const { WebServer } = require('../dist/main/web');
const { createSanitizedFixture } = require('../dist/main/sanitizer');
const { getCachedSessionClusters } = require('../dist/main/session');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-content-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'lens.db');
}
function record(event_id, extra = {}) {
  return { event_id, session_id: `session-${event_id}`, agent_name: 'Pi Agent', provider: 'openai', model: 'synthetic-model',
    url_path: '/v1/responses', input_tokens: 100, output_tokens: 20, cached_tokens: 40,
    thinking_tokens: 5, total_tokens: 120, duration_ms: 50, token_source: 'reported',
    prompt_summary: '搜索摘要', user_prompt: '查找这个请求', response_preview: '摘要预览', ...extra };
}
function snapshot(storage) {
  const day = storage.db.prepare("SELECT date('now', 'localtime') day").get().day;
  return { stats: storage.getStats(), heatmap: storage.getDailyTokenActivity('all'), models: storage.getDayModelUsage(day, 'all') };
}
function migrate(storage) { while (storage.migrateContentBatch(10)) {} }
function pseudoRandomText(length) {
  let value = 12345;
  return Array.from({ length }, () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return String.fromCharCode(32 + ((value >>> 0) % 90)); }).join('');
}

test('content defined chunks reuse unchanged regions after insertion and restore UTF-8 byte boundaries', t => {
  const storage = new StorageEngine(fixture(t));
  try {
    const context = pseudoRandomText(500_000) + '中文🙂\u0000'.repeat(100);
    const edit = context.slice(0, 200_000) + 'local insertion 局部增加' + context.slice(200_000);
    const ids = [context, context, edit].map((request_body, i) => storage.insertRecord(record(`chunk-${i}`, {
      request_body, response_body: request_body, system_prompt: context, response_text: edit, thinking_text: '思考🙂'.repeat(1000)
    })));
    migrate(storage);
    const unique = storage.db.prepare('SELECT COUNT(*) c FROM content_blocks').get().c;
    const refs = storage.db.prepare('SELECT COUNT(*) c FROM content_refs').get().c;
    assert.ok(unique < refs / 3, 'identical fields and unchanged regions reuse blocks');
    const hashes = id => storage.db.prepare("SELECT hash FROM content_refs WHERE record_id = ? AND field = 'request_body'").all(id).map(r => r.hash);
    const first = hashes(ids[0]), edited = new Set(hashes(ids[2]));
    assert.ok(first.filter(hash => edited.has(hash)).length >= first.length - 3, 'local insertion changes only adjacent chunks');
    for (let i = 0; i < ids.length; i++) {
      const read = storage.getRecordById(ids[i]);
      assert.deepEqual(Buffer.from(read.request_body), Buffer.from([context, context, edit][i]));
      assert.equal(read.response_text, edit);
      assert.equal(read.system_prompt, context);
      assert.equal(read.thinking_text, '思考🙂'.repeat(1000));
    }
    const before = snapshot(storage);
    storage.db.prepare('DELETE FROM records WHERE id = ?').run(ids[0]);
    storage.compactDatabase();
    assert.equal(storage.getRecordById(ids[1]).request_body, context);
    assert.deepEqual(snapshot(storage), before, 'record deletion does not remove usage');
    assert.equal(storage.insertRecord(record('chunk-0')), ids[0]);
    assert.equal(storage.getRecordById(ids[0]), null, 'replay does not resurrect deleted content');
    assert.deepEqual(snapshot(storage), before);
  } finally { storage.close(); }
});

test('raw codec preserves incompressible blocks; legacy Deflate and block corruption report errors', t => {
  const storage = new StorageEngine(fixture(t));
  try {
    const raw = pseudoRandomText(200_000);
    const id = storage.insertRecord(record('random', { request_body: raw }));
    // Raw fallback is tested using a valid UTF-8 field too short for Brotli to save bytes.
    const tiny = storage.insertRecord(record('tiny', { thinking_text: '🙂' }));
    migrate(storage);
    assert.equal(storage.getRecordById(id).request_body, raw);
    assert.equal(storage.getRecordById(tiny).thinking_text, '🙂');
    assert.ok(storage.db.prepare("SELECT COUNT(*) c FROM content_blocks WHERE codec = 'raw'").get().c > 0);
    assert.equal(decompressBody(zlib.deflateRawSync(Buffer.from('旧格式🙂'))), '旧格式🙂');
    assert.throws(() => decompressBody(Buffer.from('invalid deflate')), /损坏/);
    storage.db.prepare("UPDATE content_blocks SET data = ? WHERE hash IN (SELECT hash FROM content_refs WHERE record_id = ?)").run(Buffer.from('broken'), id);
    assert.throws(() => storage.getRecordById(id), /损坏|校验/);
    const light = storage.getRecords({ lightweight: true, search: '查找' });
    assert.equal(light.length, 2, 'search/list does not decompress corrupt body');
    assert.equal(storage.getStats().total_tokens, 240, 'statistics do not decompress content');
  } finally { storage.close(); }
});

test('ledger survives content clearing and retention; token/identity updates and three deletion operations stay distinct', t => {
  const storage = new StorageEngine(fixture(t));
  try {
    const id = storage.insertRecord(record('three', { request_body: 'original', response_text: 'complete response' }));
    migrate(storage);
    storage.db.prepare("UPDATE records SET total_tokens = 777, agent_name = 'Codex', token_source = 'estimated' WHERE id = ?").run(id);
    assert.equal(storage.getStats().total_tokens, 777);
    assert.equal(storage.getDailyTokenActivity('Codex').total_tokens, 777);
    const before = snapshot(storage);
    storage.clearRecords();
    assert.equal(storage.getRecordById(id).request_body, '');
    assert.equal(storage.getRecordById(id).response_text, '');
    assert.equal(storage.getRecordById(id).raw_pruned, true);
    assert.equal(storage.getRecords({ lightweight: true }).length, 1);
    assert.deepEqual(snapshot(storage), before);
    const day = storage.db.prepare("SELECT date('now', 'localtime') day").get().day;
    assert.equal(storage.getDayTokenDetails(day)[0].token_source, 'estimated');
    storage.resetUsage();
    assert.equal(storage.getStats().total_tokens, 0);
    assert.equal(storage.getDailyTokenActivity().days.length, 0);
    assert.equal(storage.getDayModelUsage(day).length, 0);
    assert.equal(storage.getRecords().length, 1);
    storage.insertRecord(record('three'));
    assert.equal(storage.getStats().total_tokens, 0);
    storage.db.prepare('UPDATE records SET total_tokens = 999 WHERE id = ?').run(id);
    assert.equal(storage.getStats().total_tokens, 0, 'correction must not undo explicit reset');
    storage.insertRecord(record('new'));
    assert.equal(storage.getStats().total_tokens, 120);
    storage.deleteAllData();
    assert.equal(storage.getRecords().length, 0);
    assert.equal(storage.getStats().total_tokens, 0);
    assert.equal(storage.db.prepare('SELECT COUNT(*) c FROM content_blocks').get().c, 0);
    assert.equal(storage.db.prepare('SELECT COUNT(*) c FROM usage_ledger').get().c, 0);
  } finally { storage.close(); }
});

test('legacy schema migration resumes after rollback and reopen without duplicate usage or references', t => {
  const file = fixture(t);
  let storage = new StorageEngine(file);
  const body = '旧内容🙂'.repeat(10_000);
  const ids = [0, 1, 2].map(i => storage.insertRecord(record(`legacy-${i}`, { request_body: body, response_text: body })));
  // Build an actual version 10 legacy schema, without the new ledger or content tables.
  const triggers = storage.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all();
  triggers.forEach(({ name }) => storage.db.exec(`DROP TRIGGER ${name}`));
  storage.db.exec('DROP VIEW usage_events; DROP TABLE usage_ledger; DROP TABLE storage_metadata; DROP TABLE content_refs; DROP TABLE content_fields; DROP TABLE content_blocks; DROP INDEX idx_records_content_pending;');
  storage.db.prepare('UPDATE records SET request_body = ?').run(zlib.deflateRawSync(Buffer.from(body)));
  storage.db.pragma('user_version = 10');
  storage.close();
  storage = new StorageEngine(file);
  try {
    assert.equal(storage.db.pragma('user_version', { simple: true }), 19);
    assert.equal(storage.getStats().total_tokens, 360, 'pending backfill visible exactly once');
    storage.db.exec("CREATE TRIGGER fail_release BEFORE UPDATE OF request_body ON records WHEN NEW.request_body = '' BEGIN SELECT RAISE(ABORT, 'injected interruption'); END");
    assert.throws(() => storage.migrateContentBatch(), /injected interruption/);
    assert.equal(storage.getRecordById(ids[0]).request_body, body);
    assert.equal(storage.db.prepare('SELECT COUNT(*) c FROM content_refs').get().c, 0, 'failed release rolls back refs and blocks');
    assert.equal(storage.db.prepare('SELECT COUNT(*) c FROM content_blocks').get().c, 0);
    storage.db.exec('DROP TRIGGER fail_release');
    assert.equal(storage.migrateContentBatch(), 1);
    storage.close();
    storage = new StorageEngine(file);
    migrate(storage);
    const refs = storage.db.prepare('SELECT COUNT(*) c FROM content_refs').get().c;
    storage.close();
    storage = new StorageEngine(file);
    assert.equal(storage.migrateContentBatch(), 0);
    assert.equal(storage.db.prepare('SELECT COUNT(*) c FROM content_refs').get().c, refs);
    assert.equal(storage.getStats().total_tokens, 360);
    assert.equal(storage.db.prepare('SELECT COUNT(*) c FROM usage_ledger').get().c, 3);
    for (const id of ids) assert.equal(storage.getRecordById(id).request_body, body);
  } finally { storage.close(); }
});

test('bounded session maintenance preserves active sessions and drains more than one batch', t => {
  const storage = new StorageEngine(fixture(t));
  try {
    const old = storage.insertRecord(record('active-old', { agent_name: 'Synthetic Client', session_id: 'active', request_body: 'keep' }));
    const fresh = storage.insertRecord(record('active-new', { agent_name: 'Synthetic Client', session_id: 'active', request_body: 'keep new' }));
    storage.db.prepare("UPDATE records SET created_at = datetime('now', '-200 days') WHERE id = ?").run(old);
    for (let n = 0; n < 205; n++) {
      const id = storage.insertRecord(record(`cold-${n}`, { request_body: 'cold' }));
      storage.db.prepare("UPDATE records SET created_at = datetime('now', '-200 days') WHERE id = ?").run(id);
    }
    const before = snapshot(storage);
    assert.equal(storage.pruneHistoricalPayloads(90).pruned, 100);
    assert.equal(storage.pruneHistoricalPayloads(90).pruned, 100);
    assert.equal(storage.pruneHistoricalPayloads(90).pruned, 5);
    assert.equal(storage.pruneHistoricalPayloads(90).pruned, 0);
    assert.equal(storage.getRecordById(old).request_body, 'keep');
    assert.equal(storage.getRecordById(fresh).request_body, 'keep new');
    assert.deepEqual(snapshot(storage), before);
    assert.equal(storage.pruneOldRecords(180).deleted, 100);
    assert.equal(storage.pruneOldRecords(180).deleted, 100);
    assert.equal(storage.pruneOldRecords(180).deleted, 5);
    assert.deepEqual(snapshot(storage), before);
  } finally { storage.close(); }
});

test('background worker performs compression/maintenance while writes and details remain available', async t => {
  const file = fixture(t);
  const storage = new StorageEngine(file);
  try {
    const body = 'background 中文🙂 '.repeat(3000);
    const id = storage.insertRecord(record('background', { request_body: body }));
    storage.startMaintenance({ retentionDays: 0, rawPayloadRetentionDays: 0 });
    const deadline = Date.now() + 10_000;
    while (storage.db.prepare('SELECT request_body FROM records WHERE id = ?').get(id).request_body !== '') {
      assert.ok(Date.now() < deadline, 'worker migration must finish');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(storage.getRecordById(id).request_body, body);
    const next = storage.insertRecord(record('while-worker', { request_body: body }));
    assert.equal(storage.getRecordById(next).request_body, body);
    assert.equal(storage.getStats().total_tokens, 240);
    assert.equal(storage.getDbInfo().maintenanceError, '');
  } finally { await storage.stopMaintenance(); storage.close(); }
});

test('Web detail, export, session analysis, lightweight search and all deletion endpoints use new storage', async t => {
  const storage = new StorageEngine(fixture(t));
  const web = new WebServer(storage, {}, 0);
  try {
    const id = storage.insertRecord(record('web', { request_headers: { 'user-agent': 'pi/1', 'x-pi-session-id': 'identified' },
      request_body: JSON.stringify({ input: 'searchable context', instructions: 'system' }), response_text: 'complete reply' }));
    migrate(storage);
    storage.rebuildRecordIdentities();
    assert.equal(storage.getDayTokenDetails(storage.db.prepare("SELECT date('now', 'localtime') d").get().d)[0].agent_name, 'Pi Agent');
    assert.equal(storage.getRecordById(id).session_id, `unknown:record:${id}`, 'unverified x-pi header cannot establish native session identity');
    assert.equal(storage.getRecordById(id).session_confidence, 'unknown');
    assert.equal(createSanitizedFixture(storage.getRecordById(id)).extracted_meta.total_tokens, 120);
    assert.equal(getCachedSessionClusters(storage).length, 1);
    const invoke = async (url, method = 'GET', payload) => {
      const response = await web.app.inject({ url, method, payload });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    assert.equal((await invoke(`/api/records/${id}`)).response_text, 'complete reply');
    assert.equal((await invoke(`/api/records/${id}/fixture`)).extracted_meta.total_tokens, 120);
    assert.equal((await invoke('/api/records?search=查找')).records.length, 1);
    const lightBatch = (await invoke('/api/records/batch', 'POST', { ids: [id], includeRawBody: false, lightweight: true })).records[0];
    assert.equal(lightBatch.raw_loaded, false);
    assert.equal(lightBatch.response_text, 'complete reply');
    assert.equal(lightBatch.parsed_question.newText, 'searchable context');
    assert.equal((await invoke('/api/records/batch', 'POST', { ids: [id], includeRawBody: true })).records[0].raw_loaded, true);
    assert.equal((await invoke('/api/db-info')).recordsCount, 1);
    await invoke('/api/clear', 'POST');
    assert.equal((await invoke(`/api/records/${id}`)).raw_pruned, true);
    assert.equal((await invoke('/api/stats')).total_tokens, 120);
    await invoke('/api/reset-usage', 'POST');
    assert.equal((await invoke('/api/stats')).total_tokens, 0);
    assert.equal((await invoke('/api/records')).records.length, 1);
    await invoke('/api/delete-all-data', 'POST');
    assert.equal((await invoke('/api/records')).records.length, 0);
  } finally { await web.stop(); storage.close(); }
});

test('record and ledger writes roll back together; offset timestamps group on the same local date', t => {
  const storage = new StorageEngine(fixture(t));
  try {
    storage.db.exec("CREATE TRIGGER reject_ledger BEFORE INSERT ON usage_ledger BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END;");
    assert.throws(() => storage.insertRecord(record('atomic')), /ledger unavailable/);
    assert.equal(storage.getRecords().length, 0);
    assert.equal(storage.getStats().total_tokens, 0);
    storage.db.exec('DROP TRIGGER reject_ledger');
    const id = storage.insertRecord(record('atomic'));
    storage.db.exec("CREATE TRIGGER reject_correction BEFORE UPDATE ON usage_ledger BEGIN SELECT RAISE(ABORT, 'correction failed'); END;");
    assert.throws(() => storage.db.prepare('UPDATE records SET total_tokens = 500 WHERE id = ?').run(id), /correction failed/);
    assert.equal(storage.getRecordById(id).total_tokens, 120);
    assert.equal(storage.getStats().total_tokens, 120);
    storage.db.exec('DROP TRIGGER reject_correction');
    const ids = [id, storage.insertRecord(record('offset'))];
    storage.db.prepare('UPDATE records SET created_at = ? WHERE id = ?').run('2026-10-01T23:30:00Z', ids[0]);
    storage.db.prepare('UPDATE records SET created_at = ? WHERE id = ?').run('2026-10-02T07:30:00+08:00', ids[1]);
    const day = storage.db.prepare("SELECT date('2026-10-01T23:30:00Z', 'localtime') day").get().day;
    assert.equal(storage.getDayModelUsage(day)[0].total_tokens, 240);
    assert.equal(storage.getDayTokenDetails(day).length, 2);
  } finally { storage.close(); }
});

test('Electron preload bridge sends detail, statistics and destructive operations through matching IPC handlers', async t => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  let api;
  const calls = [];
  const resolved = require.resolve('../dist/preload/index.js');
  delete require.cache[resolved];
  Module._load = function (name, ...args) {
    if (name === 'electron') return {
      contextBridge: { exposeInMainWorld: (_name, bridge) => { api = bridge; } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return {}; } }
    };
    return originalLoad.call(this, name, ...args);
  };
  try { require(resolved); } finally { Module._load = originalLoad; delete require.cache[resolved]; }
  await api.clearRecords(); await api.resetUsage(); await api.deleteAllData(); await api.compactDatabase();
  await api.getDbInfo(); await api.getRecordDetail(5); await api.getRecordHistory(5); await api.getStats();
  assert.deepEqual(calls.map(c => c[0]), ['api:clear-records', 'api:reset-usage', 'api:delete-all-data', 'api:compact-database', 'api:get-db-info', 'api:get-record-detail', 'api:get-record-history', 'api:get-stats']);
  assert.deepEqual(calls[6], ['api:get-record-history', 5]);
  // Exercise the actual main handlers in a VM without booting Electron, CA, proxy or user's database.
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../dist/main/index.js'), 'utf8');
  const storage = new StorageEngine(fixture(t));
  const handlers = new Map();
  const frame = { url: 'http://127.0.0.1:8088/' };
  const event = { sender: { id: 1, mainFrame: frame }, senderFrame: frame };
  const context = { desktop_security_1: require('../dist/main/desktop-security'), mainWindow: { webContents: { id: 1 } }, DASHBOARD_ORIGIN: 'http://127.0.0.1:8088', ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, storage,
    storage_1: { default: undefined }, electron_1: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
    session_1: require('../dist/main/session'), sanitizer_1: require('../dist/main/sanitizer') };
  const start = source.indexOf('function setupIpc()');
  const end = source.indexOf('function findMacApp', start);
  assert.ok(start >= 0 && end > start, 'main handler section must be present');
  try {
    vm.runInNewContext(source.slice(start, end) + '\n}\nsetupIpc();', context);
    assert.throws(() => handlers.get('api:get-stats')({ sender: { id: 2 } }), /Untrusted/);
    const id = storage.insertRecord(record('ipc', { request_body: 'IPC original', response_text: 'IPC reply' }));
    migrate(storage);
    assert.equal((await handlers.get('api:get-record-detail')(event, id)).response_text, 'IPC reply');
    assert.deepEqual(await handlers.get('api:get-record-history')(event, id), storage.getRelatedHistory(id));
    await handlers.get('api:clear-records')(event);
    assert.equal((await handlers.get('api:get-stats')(event)).total_tokens, 120);
    assert.equal((await handlers.get('api:get-record-detail')(event, id)).raw_pruned, true);
    await handlers.get('api:reset-usage')(event);
    assert.equal((await handlers.get('api:get-stats')(event)).total_tokens, 0);
    await handlers.get('api:delete-all-data')(event);
    assert.equal(storage.getRecords().length, 0);
  } finally { storage.close(); }
});

test('legacy non-autoincrement record IDs cannot collide with permanent usage after deletion', t => {
  const file = fixture(t);
  const old = new Database(file);
  old.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, session_id TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  old.close();
  const storage = new StorageEngine(file);
  try {
    const first = storage.insertRecord({ total_tokens: 10 });
    storage.db.prepare('DELETE FROM records WHERE id = ?').run(first);
    const second = storage.insertRecord({ total_tokens: 20 });
    assert.ok(second > first);
    assert.equal(storage.getStats().total_tokens, 30);
    assert.equal(storage.getStats().total_requests, 2);
  } finally { storage.close(); }
});
