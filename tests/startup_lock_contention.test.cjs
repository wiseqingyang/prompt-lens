const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { StorageEngine } = require('../dist/main/storage');
const { getAgentCategory } = require('../dist/shared/agent');
const { AttributionRepository } = require('../dist/main/attribution/repository');
const { decodeAntigravityArchive } = require('../dist/main/attribution/adapters/antigravityArchive');
const { fixture, SID, TRAJ } = require('./fixtures/antigravity-search.cjs');

function tempDb(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-startup-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'lens.db');
}

/** Inserts synthetic rows directly; `daysAgo` controls created_at. Returns ids in insertion order. */
function seed(storage, rows) {
  const insert = storage.db.prepare(`INSERT INTO records (session_id, agent_name, request_body, created_at)
    VALUES (?, ?, 'synthetic', datetime('now', '-' || ? || ' days'))`);
  return storage.db.transaction(() => rows.map(([session, agent, daysAgo]) => Number(insert.run(session, agent, daysAgo).lastInsertRowid)))();
}

function withLock(file) {
  const blocker = new Database(file);
  blocker.exec('BEGIN IMMEDIATE');
  return () => { blocker.exec('ROLLBACK'); blocker.close(); };
}

test('AC-1 retention keeps sessions active in the same Agent category and expires everything else in id order', t => {
  const storage = new StorageEngine(tempDb(t));
  try {
    const [activeOld, activeNew, otherCategoryOld, blankOld, unknownOld, coldOld, coldOld2, recent] = seed(storage, [
      ['shared', 'Codex Desktop', 30], ['shared', 'Codex CLI', 1], ['shared', 'Antigravity', 30],
      ['', 'Codex Desktop', 30], ['unknown', 'Codex Desktop', 30], ['cold', 'Codex Desktop', 30], ['cold', 'Codex Desktop', 20],
      ['fresh', 'Synthetic Client', 1]
    ]);
    const live = () => storage.db.prepare('SELECT id FROM records ORDER BY id').all().map(row => row.id);
    assert.equal(storage.pruneHistoricalPayloads(7).pruned, 5);
    assert.deepEqual(storage.db.prepare('SELECT id FROM records WHERE content_expired = 1 ORDER BY id').all().map(row => row.id),
      [otherCategoryOld, blankOld, unknownOld, coldOld, coldOld2]);
    assert.equal(storage.pruneHistoricalPayloads(7).pruned, 0, 'content-only expiry skips already expired rows');
    assert.equal(storage.pruneOldRecords(7).deleted, 5);
    assert.deepEqual(live(), [activeOld, activeNew, recent]);
  } finally { storage.close(); }
});

test('AC-2 retention work stays linear for a long session that is still active', t => {
  const storage = new StorageEngine(tempDb(t));
  try {
    // Old rows first so a correlated per-row scan visits every old row before an active one.
    const rows = [...Array.from({ length: 800 }, () => ['long', 'Codex Desktop', 30]), ...Array.from({ length: 400 }, () => ['long', 'Codex Desktop', 1])];
    seed(storage, rows);
    // Each category evaluation reads a stored row, which is what held the maintenance write lock
    // for seconds on real databases; wall time on tiny synthetic rows is not a stable signal.
    let evaluations = 0;
    storage.db.function('agent_category', { deterministic: true }, name => { evaluations++; return getAgentCategory(name); });
    assert.equal(storage.pruneOldRecords(7).deleted, 0);
    assert.ok(evaluations <= rows.length * 2, `retention evaluated agent_category ${evaluations} times for ${rows.length} rows`);
  } finally { storage.close(); }
});

test('AC-3 background maintenance worker applies the same retention rule', async t => {
  const file = tempDb(t);
  const storage = new StorageEngine(file);
  try {
    const [keepOld, keepNew, dropA, dropB] = seed(storage, [['live', 'Pi', 30], ['live', 'Pi', 1], ['gone', 'Pi', 30], ['', 'Pi', 30]]);
    storage.startMaintenance({ retentionDays: 7, rawPayloadRetentionDays: 0 });
    const ids = () => storage.db.prepare('SELECT id FROM records ORDER BY id').all().map(row => row.id);
    const deadline = Date.now() + 10_000;
    while (ids().includes(dropA) || ids().includes(dropB)) {
      assert.ok(Date.now() < deadline, 'maintenance worker must expire old sessions');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.deepEqual(ids(), [keepOld, keepNew]);
  } finally { await storage.stopMaintenance(); storage.close(); }
});

test('AC-4 secondary connections open without the write lock and reject a schema they do not own', t => {
  const file = tempDb(t);
  new StorageEngine(file).close();
  const release = withLock(file);
  try {
    const started = Date.now();
    const secondary = new StorageEngine(file, { migrate: false });
    secondary.close();
    assert.ok(Date.now() - started < 2000, 'opening must not wait for busy_timeout');
  } finally { release(); }
  const db = new Database(file); db.pragma('user_version = 18'); db.close();
  assert.throws(() => new StorageEngine(file, { migrate: false }), /schema 18 does not match/);
  const empty = tempDb(t);
  assert.throws(() => new StorageEngine(empty, { migrate: false }), /schema 0 does not match/);
});

test('AC-5 attribution worker serves sessions while another connection holds the write lock', async t => {
  const file = tempDb(t);
  const host = new StorageEngine(file);
  seed(host, [['s1', 'Synthetic Client', 0], ['s1', 'Synthetic Client', 0]]);
  const expected = await host.getAttributedSessions();
  host.close();
  const background = new StorageEngine(file, { backgroundAttribution: true });
  const release = withLock(file);
  try {
    const started = Date.now();
    assert.deepEqual(await background.getAttributedSessions(), expected);
    assert.ok(Date.now() - started < 4000, 'worker startup must not wait for the write lock');
  } finally { release(); await background.stopAttributionCollection(); background.close(); }
});

test('AC-6 a failed attribution worker is replaced for later requests', async t => {
  const file = tempDb(t);
  const storage = new StorageEngine(file, { backgroundAttribution: true });
  try {
    seed(storage, [['s1', 'Synthetic Client', 0]]);
    assert.equal((await storage.getAttributedSessions()).length, 1);
    await storage.attributionWorker.worker.terminate();
    seed(storage, [['s2', 'Synthetic Client', 0]]);
    assert.equal((await storage.getAttributedSessions()).length, 2);
  } finally { await storage.stopAttributionCollection(); storage.close(); }
});

for (const backgroundAttribution of [false, true]) {
  test(`session projections remain available under a write lock and persist after rollback (worker=${backgroundAttribution})`, async t => {
    const file = tempDb(t);
    const storage = new StorageEngine(file, { backgroundAttribution });
    let release;
    try {
      const f = fixture();
      // More than one projection batch, with both capture-only and native-evidence adapters.
      const ids = [];
      for (let i = 0; i < 10; i++) ids.push(storage.insertRecord({
        agent_name: i % 2 ? 'Codex' : 'Antigravity', status_code: 200, capture_status: 'complete',
        schema_version: '2.0.0', transport: 'https', attribution: 'request', method: 'POST',
        request_headers: i % 2 ? { 'user-agent': 'Codex Desktop/0.162.0', 'thread-id': 'thread-a',
          'x-codex-turn-metadata': JSON.stringify({ thread_id: 'thread-a', turn_id: 'turn-a', request_kind: 'turn' }) } : {},
        request_body: JSON.stringify(i % 2 ? { client_metadata: { thread_id: 'thread-a', turn_id: 'turn-a' }, input: [] } : f.origin),
        response_body: JSON.stringify(f.originResponse), token_source: 'reported', total_tokens: 7
      }));
      new AttributionRepository(storage.db).saveObservations([{ recordId: ids[0], adapterId: 'antigravity',
        scope: JSON.stringify(['antigravity', SID, TRAJ]), native: decodeAntigravityArchive(f.native, 'synthetic-source'),
        observedAt: '2026-01-02T00:00:00Z' }]);
      const expected = await storage.getAttributedSessions();
      assert.ok(expected.some(session => session.session_id === 'thread-a'), 'fixture must resolve a native session');
      storage.db.exec('DELETE FROM request_attributions; DELETE FROM attribution_scope_records');
      const before = storage.db.prepare('SELECT * FROM records ORDER BY id').all();
      release = withLock(file);
      const started = Date.now();
      assert.deepEqual(await storage.getAttributedSessions(), expected);
      assert.ok(Date.now() - started < 2000, 'session reads must not wait for the write lock');
      assert.equal(storage.db.prepare('SELECT count(*) n FROM request_attributions').get().n, 0);
      assert.deepEqual(storage.db.prepare('SELECT * FROM records ORDER BY id').all(), before);
      const revision = new AttributionRepository(storage.db).revision();
      release(); release = undefined;
      assert.equal(new AttributionRepository(storage.db).revision(), revision, 'rollback does not invalidate caches');
      assert.deepEqual(await storage.getAttributedSessions(), expected);
      assert.equal(storage.db.prepare('SELECT count(*) n FROM request_attributions').get().n, 10, 'deferred projections must be retried');
      assert.equal(storage.db.prepare('SELECT count(*) n FROM attribution_scope_records').get().n, 5, 'deferred scope links must be retried');
    } finally { release?.(); await storage.stopAttributionCollection(); storage.close(); }
  });
}

test('invalidated sessions recompute under contention; non-lock projection failures remain visible and recoverable', async t => {
  const file = tempDb(t);
  const storage = new StorageEngine(file);
  let release;
  try {
    const body = thread => JSON.stringify({ type: 'response.create', client_metadata: { thread_id: thread, turn_id: 'turn-a' }, input: [] });
    const id = storage.insertRecord({ agent_name: 'Codex', request_body: body('thread-old'),
      schema_version: '2.0.0', transport: 'wss', attribution: 'request', method: 'GET', status_code: 101,
      request_headers: { 'user-agent': 'Codex Desktop/0.162.0' } });
    assert.equal((await storage.getAttributedSessions())[0].session_id, 'thread-old');
    storage.db.prepare('UPDATE records SET request_body=? WHERE id=?').run(body('thread-new'), id);
    storage.db.pragma('busy_timeout=137');
    release = withLock(file);
    assert.equal((await storage.getAttributedSessions())[0].session_id, 'thread-new');
    assert.equal(storage.db.pragma('busy_timeout', { simple: true }), 137);
    assert.equal(storage.db.prepare('SELECT capture_digest FROM request_attributions WHERE record_id=?').get(id).capture_digest, '');
    release(); release = undefined;
    storage.db.exec("CREATE TRIGGER reject_projection BEFORE INSERT ON request_attributions BEGIN SELECT RAISE(ABORT, 'synthetic projection failure'); END");
    await assert.rejects(storage.getAttributedSessions(), /synthetic projection failure/);
    assert.equal(storage.db.inTransaction, false);
    assert.equal(storage.db.pragma('busy_timeout', { simple: true }), 137);
    storage.db.exec('DROP TRIGGER reject_projection');
    assert.equal((await storage.getAttributedSessions())[0].session_id, 'thread-new');
    assert.equal(storage.getRecordById(id).session_id, 'thread-new');
    assert.ok(storage.db.prepare('SELECT capture_digest FROM request_attributions WHERE record_id=?').get(id).capture_digest);
  } finally { release?.(); storage.close(); }
});

test('AC-7 reusable session queries skip evidence decompression, cache self-flushed projections and ignore unchanged observations', async t => {
  const file = tempDb(t);
  const storage = new StorageEngine(file);
  const peer = new StorageEngine(file, { migrate: false });
  try {
    const f = fixture();
    const id = storage.insertRecord({
      agent_name: 'Antigravity', status_code: 200, capture_status: 'complete',
      request_body: JSON.stringify(f.origin), response_body: JSON.stringify(f.originResponse),
      token_source: 'reported', total_tokens: 7
    });
    const repo = new AttributionRepository(storage.db);
    const peerRepo = new AttributionRepository(peer.db);
    const obs = [{ recordId: id, adapterId: 'antigravity', scope: JSON.stringify(['antigravity', SID, TRAJ]),
      native: decodeAntigravityArchive(f.native, 'synthetic-source'), observedAt: '2026-01-02T00:00:00Z' }];
    repo.saveObservations(obs);
    const revBeforeDuplicate = peerRepo.revision();
    repo.saveObservations(obs);
    assert.equal(peerRepo.revision(), revBeforeDuplicate, 'unchanged observation must not write WAL or bump data_version');

    // First sessions() projects and flushes request_attributions; its own flush must still populate sessionCache.
    const first = await storage.getAttributedSessions();
    let getRecordsCalls = 0;
    const origGetRecords = storage.getRecords.bind(storage);
    storage.getRecords = (...args) => { getRecordsCalls++; return origGetRecords(...args); };
    assert.deepEqual(await storage.getAttributedSessions(), first);
    assert.equal(getRecordsCalls, 0, 'immediate second sessions() must hit sessionCache after self-flushed projection');
    storage.getRecords = origGetRecords;

    // Reopen cold: reusable projection must not decompress stored attribution_evidence blobs.
    const reopened = new StorageEngine(file, { migrate: false });
    try {
      let evidenceReads = 0;
      const origReadEvidence = AttributionRepository.prototype.readEvidence;
      AttributionRepository.prototype.readEvidence = function (...args) { evidenceReads++; return origReadEvidence.apply(this, args); };
      t.after(() => { AttributionRepository.prototype.readEvidence = origReadEvidence; });
      assert.deepEqual(await reopened.getAttributedSessions(), first);
      assert.equal(evidenceReads, 0, 'reusable session query must not decompress attribution_evidence snapshots');
    } finally { reopened.close(); }
  } finally { peer.close(); storage.close(); }
});

test('AC-8 attribution worker prioritizes queued sessions over collect batches and renderer fetches stats/sessions in parallel', async t => {
  const file = tempDb(t);
  const storage = new StorageEngine(file, { backgroundAttribution: true });
  try {
    // Warm worker thread, then insert 10 records so collect() yields after 8 records and sessions() misses host cache.
    await storage.getAttributedSessions();
    const ids = seed(storage, Array.from({ length: 10 }, (_, i) => [`s-${i}`, 'Synthetic Client', 0]));
    const order = [];
    const c1 = storage.collectAttributionEvidence('', ids).then(() => order.push('collect-1'));
    const c2 = storage.collectAttributionEvidence('', ids).then(() => order.push('collect-2'));
    const s = storage.getAttributedSessions().then(() => order.push('sessions'));
    await Promise.all([c1, c2, s]);
    assert.ok(order.indexOf('sessions') < order.indexOf('collect-2'), `expected sessions before collect-2, got ${order.join(' -> ')}`);
  } finally { await storage.stopAttributionCollection(); storage.close(); }

  const { createServer } = await import('vite');
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const originalWindow = global.window;
  try {
    const { useSessions } = await server.ssrLoadModule('/src/renderer/composables/useSessions.ts');
    let resolveStats;
    const statsGate = new Promise(r => { resolveStats = r; });
    const callOrder = [];
    global.window = {
      electronAPI: {
        getStats: () => { callOrder.push('getStats'); return statsGate; },
        getSessions: async () => { callOrder.push('getSessions'); return { sessions: [{ id: 's1', tasks: [] }] }; }
      }
    };
    const state = useSessions();
    const fetching = state.fetchData();
    assert.deepEqual(callOrder, ['getStats', 'getSessions'], 'getSessions must start without waiting for getStats');
    resolveStats({ total_requests: 9 });
    await fetching;
    assert.equal(state.sessions.value.length, 1);
    assert.equal(state.stats.value.total_requests, 9);
  } finally {
    global.window = originalWindow;
    await server.close();
  }
});
