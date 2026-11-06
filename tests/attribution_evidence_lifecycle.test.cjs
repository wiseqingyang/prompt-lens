const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { StorageEngine } = require('../dist/main/storage');
const { AttributionRepository } = require('../dist/main/attribution/repository');
const { AttributionService } = require('../dist/main/attribution/service');
const { AdapterRegistry } = require('../dist/main/attribution/registry');
const { antigravityAdapter } = require('../dist/main/attribution/adapters/antigravity');
const A = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-durable-evidence-'));
  const file = path.join(root, 'lens.db');
  const source = path.join(root, 'native');
  const storage = new StorageEngine(file);
  const stores = [storage];
  t.after(async () => { for (const store of stores) { await store.stopAttributionCollection(); store.close(); } fs.rmSync(root, { recursive: true, force: true }); });
  const reopen = () => { const store = new StorageEngine(file); stores.push(store); return store; };
  return { root, file, source, storage, reopen };
}
function log(source, title = '用户原始输入', extra = {}) {
  fs.mkdirSync(path.join(source, 'conversations'), { recursive: true });
  const db = new Database(path.join(source, 'conversations', A + '.db'));
  db.exec('CREATE TABLE IF NOT EXISTS trajectory_meta(cascade_id TEXT, trajectory_id TEXT); DELETE FROM trajectory_meta');
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run(A, T); db.close();
  const file = path.join(source, 'brain', A, '.system_generated/logs/transcript.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2025-01-01T00:00:00Z', content: title, ...extra }) + '\n';
  fs.writeFileSync(file, raw);
  return raw;
}
function insert(storage, index = 0) {
  return storage.insertRecord({ agent_name: 'Antigravity', provider: 'gemini', model: 'fixture', request_body: JSON.stringify({ requestId: `agent/${A}/123/${T}/${index + 1}`, request: { labels: { cascade_id: A } } }) });
}
const turn = sessions => sessions[0].tasks[0].turns[0].assignment.turn;
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'background collection did not finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('source deletion cannot erase an already established turn', async t => {
  const { storage, source } = fixture(t);
  log(source); insert(storage);
  await storage.collectAttributionEvidence(source);
  const before = await storage.getAttributedSessions();
  assert.equal(turn(before).status, 'resolved');
  fs.rmSync(source, { recursive: true });
  await storage.collectAttributionEvidence(source);
  assert.deepEqual(await storage.getAttributedSessions(), before);
});

test('background collection persists exact raw evidence without a page query, retries and resumes after reopen', async t => {
  const { storage, source, reopen } = fixture(t);
  storage.startAttributionCollection(() => source, { retryBaseMs: 10, pollMs: 10 });
  const id = insert(storage);
  await until(() => storage.db.prepare('SELECT attempts FROM attribution_jobs WHERE record_id = ?').get(id)?.attempts > 0);
  await storage.stopAttributionCollection();
  storage.close();
  const raw = log(source, 'x'.repeat(5000), { future_field: { opaque: 'must survive' } });
  const reopened = reopen();
  const notifications = [];
  reopened.startAttributionCollection(() => source, { retryBaseMs: 10, pollMs: 10, onCollected: ids => notifications.push(...ids) });
  const repository = new AttributionRepository(reopened.db);
  await until(() => repository.readObservations().some(row => row.native.raw?.transcript === raw));
  await reopened.stopAttributionCollection();
  assert.ok(notifications.includes(id), 'late evidence completion notifies the desktop refresh path');
  const before = await reopened.getAttributedSessions();
  assert.equal(turn(before).status, 'resolved');
  fs.rmSync(source, { recursive: true });
  assert.deepEqual(await reopened.getAttributedSessions(), before);
  const upgraded = { ...antigravityAdapter, version: 'fixture-v2' };
  const service = new AttributionService(reopened, repository, new AdapterRegistry([upgraded]), () => { throw new Error('query must never read source'); });
  assert.equal(turn(await service.sessions()).status, 'resolved');
  assert.ok(repository.readObservations().some(row => row.native.raw.transcript === raw));
});

test('raw observations survive rewrites and evidence cleanup follows application retention', async t => {
  const { storage, source } = fixture(t);
  const first = log(source); const id = insert(storage);
  await storage.collectAttributionEvidence(source);
  const second = log(source, '改写后的输入');
  await storage.collectAttributionEvidence(source);
  assert.equal(turn(await storage.getAttributedSessions()).reason, 'source_changed');
  log(source);
  await storage.collectAttributionEvidence(source);
  assert.equal(turn(await storage.getAttributedSessions()).reason, 'source_changed', 'restoring old text must not erase a conflict');
  fs.rmSync(source, { recursive: true });
  const repository = new AttributionRepository(storage.db);
  const raw = repository.readObservations().map(row => row.native.raw?.transcript);
  assert.ok(raw.includes(first)); assert.ok(raw.includes(second));
  storage.db.prepare('UPDATE records SET content_expired = 1 WHERE id = ?').run(id);
  assert.equal(repository.readObservations().length, 0);
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM attribution_evidence').get().n, 0);
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM attribution_jobs').get().n, 0);
});

test('stored original fields can be decoded under a new rule version without source files or old projections', async t => {
  const { storage, source } = fixture(t);
  log(source, '原文标题', { new_rule_field: 'kept' }); insert(storage);
  await storage.collectAttributionEvidence(source);
  fs.rmSync(source, { recursive: true });
  const repository = new AttributionRepository(storage.db);
  const original = repository.readObservations()[0];
  // Simulate an older decoder with an incorrect derived field. Its raw record remains unchanged.
  repository.saveObservations([{ ...original, native: { ...original.native, steps: [] } }]);
  storage.db.exec('DELETE FROM request_attributions');
  const upgraded = { ...antigravityAdapter, version: 'fixture-v2', resolve(snapshot) {
    const decision = antigravityAdapter.resolve(snapshot);
    if (decision.turn.status === 'resolved') {
      decision.turn.value.title += ':' + JSON.parse(snapshot.native.raw.transcript).new_rule_field;
    }
    return { ...decision, ruleVersion: 'fixture-v2' };
  } };
  const service = new AttributionService(storage, repository, new AdapterRegistry([upgraded]), () => { throw new Error('native I/O is forbidden'); });
  const result = turn(await service.sessions());
  assert.equal(result.status, 'resolved'); assert.equal(result.value.title, '原文标题:kept');
});

test('new captures continue the observed user turn from saved evidence without inventing steps', async t => {
  const { storage, source } = fixture(t);
  log(source); const first = insert(storage);
  await storage.collectAttributionEvidence(source);
  fs.rmSync(source, { recursive: true });
  const second = insert(storage);
  await storage.collectAttributionEvidence(source, [second]);
  storage.db.prepare('DELETE FROM records WHERE id = ?').run(first);
  assert.equal(turn(await storage.getAttributedSessions()).status, 'resolved', 'shared evidence needs a surviving reference');
  insert(storage, 1);
  await storage.collectAttributionEvidence(source);
  const requests = (await storage.getAttributedSessions())[0].tasks.flatMap(task => task.turns);
  assert.equal(requests.filter(request => request.assignment.turn.status === 'resolved').length, 2);
  assert.equal(requests.find(request => request.record_id !== second).assignment.turn.value.inputIndex, 0);
  assert.equal(new AttributionRepository(storage.db).readObservations()[0].native.steps.length, 1, 'continuation does not invent native events');
});

test('truncated source and a moved source with unchanged events preserve historical decisions', async t => {
  const { storage, source, root } = fixture(t);
  log(source); insert(storage); await storage.collectAttributionEvidence(source);
  const before = await storage.getAttributedSessions();
  const transcript = path.join(source, 'brain', A, '.system_generated/logs/transcript.jsonl');
  fs.writeFileSync(transcript, '');
  await storage.collectAttributionEvidence(source);
  assert.deepEqual(await storage.getAttributedSessions(), before);
  const moved = path.join(root, 'moved'); log(moved);
  await storage.collectAttributionEvidence(moved);
  assert.deepEqual(await storage.getAttributedSessions(), before);
});

test('v13 snapshots migrate without source logs, and failed v14 migration rolls back', async t => {
  const { storage, source, file, reopen } = fixture(t);
  log(source); insert(storage); await storage.collectAttributionEvidence(source);
  const repository = new AttributionRepository(storage.db);
  const row = repository.readAll()[0];
  const parsed = { ...row.native }; delete parsed.raw;
  storage.db.exec('DELETE FROM request_attributions');
  repository.saveBatch([{ ...row, version: '1', decision: { ...row.decision, ruleVersion: '1' }, native: { status: 'unavailable', reason: 'source_missing', previous: parsed } }]);
  storage.db.exec('DROP TABLE attribution_observations; DROP TABLE attribution_scope_records; DROP TABLE attribution_jobs; DROP TRIGGER queue_record_attribution; PRAGMA user_version = 13');
  storage.close(); fs.rmSync(source, { recursive: true });
  const create = AttributionRepository.createSchema;
  try {
    AttributionRepository.createSchema = db => { create(db); throw new Error('migration fault'); };
    assert.throws(reopen, /migration fault/);
  } finally { AttributionRepository.createSchema = create; }
  const check = new Database(file);
  assert.equal(check.pragma('user_version', { simple: true }), 13);
  assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name = 'attribution_observations'").get(), undefined);
  check.close();
  const migrated = reopen();
  assert.equal(migrated.db.pragma('user_version', { simple: true }), 19);
  assert.equal(turn(await migrated.getAttributedSessions()).status, 'resolved');
  const migratedObservation = new AttributionRepository(migrated.db).readObservations()[0];
  assert.equal(migratedObservation.native.raw, undefined, 'migration must not fabricate raw logs');
  assert.equal(migratedObservation.observedAt, '', 'migration must not invent the original observation time');
  migrated.close();
  assert.equal(turn(await reopen().getAttributedSessions()).status, 'resolved');
});

test('capture and collection job commit together; expiry during a read cannot resurrect evidence', async t => {
  const { storage, source } = fixture(t);
  log(source);
  assert.throws(() => storage.db.transaction(() => { insert(storage); throw new Error('rollback'); })(), /rollback/);
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM attribution_jobs').get().n, 0);
  const id = insert(storage);
  let release;
  const read = new Promise(resolve => { release = resolve; });
  const service = new AttributionService(storage, new AttributionRepository(storage.db), new AdapterRegistry(), () => ({ read: () => read }));
  const collecting = service.collect(source);
  storage.clearRecords();
  release({ status: 'available', sourceId: source, trajectoryId: T, steps: [{ index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', createdAt: '2025-01-01T00:00:00Z' }] });
  await collecting;
  assert.equal(new AttributionRepository(storage.db).readObservations().length, 0);
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM attribution_jobs WHERE record_id = ?').get(id).n, 0);
});

test('shutdown during native I/O stops writes and leaves the job available on restart', async t => {
  const { storage, source, reopen } = fixture(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const read = new Promise(resolve => { release = resolve; });
  const repository = new AttributionRepository(storage.db);
  storage.attributionService = new AttributionService(storage, repository, new AdapterRegistry(), () => ({ read() { entered(); return read; } }));
  storage.startAttributionCollection(() => source, { pollMs: 10 });
  const id = insert(storage);
  assert.ok(repository.dueJobs(Date.now(), 32).includes(id), 'insert returns with its durable job before native I/O finishes');
  // The collector timer is intentionally unref'ed; keep this isolated test alive until it enters.
  const hold = setTimeout(() => {}, 5000);
  await started;
  const collector = storage.evidenceCollector;
  storage.close();
  release({ status: 'unavailable', reason: 'source_missing' });
  await collector.stop(); clearTimeout(hold);
  const restarted = reopen();
  assert.ok(new AttributionRepository(restarted.db).dueJobs(Date.now(), 32).includes(id));
  assert.equal(new AttributionRepository(restarted.db).readObservations().length, 0);
});

test('a source setting changed during collection is retried against the new source', async t => {
  const { storage } = fixture(t);
  let currentRoot = '/synthetic/first', release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pause = new Promise(resolve => { release = resolve; });
  const seen = [];
  const repository = new AttributionRepository(storage.db);
  storage.attributionService = new AttributionService(storage, repository, new AdapterRegistry(), root => ({ async read() {
    seen.push(root);
    if (root === '/synthetic/first') { entered(); await pause; }
    return { status: 'available', sourceId: root, trajectoryId: T,
      steps: [{ index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', createdAt: '2025-01-01T00:00:00Z', input: root }] };
  } }));
  storage.startAttributionCollection(() => currentRoot, { retryBaseMs: 10, pollMs: 10 });
  insert(storage);
  const hold = setTimeout(() => {}, 5000);
  await started;
  currentRoot = '/synthetic/second'; storage.refreshAttributionCollection(); release();
  await until(() => seen.includes('/synthetic/second'));
  await storage.stopAttributionCollection(); clearTimeout(hold);
  assert.equal(turn(await storage.getAttributedSessions()).reason, 'source_changed');
});

test('persisted queries skip unchanged archives without sharing per-request decisions', async t => {
  const { storage, source } = fixture(t);
  const firstLine = log(source, '第一轮');
  const transcript = path.join(source, 'brain', A, '.system_generated/logs/transcript.jsonl');
  const secondLine = JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT',
    created_at: '2025-01-02T00:00:00Z', content: '第二轮' }) + '\n';
  fs.appendFileSync(transcript, secondLine);
  const ids = Array.from({ length: 24 }, (_, index) => insert(storage, index % 3));
  storage.db.prepare('UPDATE records SET created_at = ? WHERE id = ?').run('2024-12-31 00:00:00', ids[0]);
  // One native observation serves all captures; seed valid projections before the cold query.
  await storage.collectAttributionEvidence(source, [ids[1]]);
  const expected = await storage.getAttributedSessions();
  fs.rmSync(source, { recursive: true });
  const repository = new AttributionRepository(storage.db);
  let decodes = 0, serializations = 0;
  const watched = new WeakSet();
  const watch = native => {
    if (!watched.has(native)) {
      watched.add(native);
      const snapshot = { ...native };
      Object.defineProperty(native, 'toJSON', { value() { serializations++; return snapshot; } });
    }
    return native;
  };
  const readAll = repository.readAll.bind(repository);
  repository.readAll = ids => readAll(ids).map(row => ({ ...row, native: watch(row.native) }));
  const measured = { ...antigravityAdapter, decodeEvidence(native) {
    decodes++;
    return watch(antigravityAdapter.decodeEvidence(native));
  } };
  const service = new AttributionService(storage, repository, new AdapterRegistry([measured]),
    () => { throw new Error('query must not read native files'); });
  t.after(() => service.close());
  const actual = await service.sessions();
  assert.deepEqual(actual, expected);
  const requests = actual.flatMap(session => session.tasks.flatMap(task => task.turns));
  const decision = id => requests.find(request => request.record_id === id).assignment.turn;
  assert.equal(decision(ids[0]).reason, 'source_changed', 'capture time remains request-specific');
  assert.equal(decision(ids[1]).value.title, '第二轮');
  assert.equal(decision(ids[2]).value.title, '第二轮', 'missing later steps preserve the active observed turn');
  assert.equal(decision(ids[3]).value.title, '第一轮');
  assert.equal(decodes, 0, 'persisted observation proof avoids decoding unchanged archives');
  assert.equal(serializations, 0, 'unchanged projections do not fingerprint native snapshots again');
  assert.deepEqual(await service.sessions(), actual);
  assert.equal(decodes, 0, 'unchanged session cache avoids replay');
  // A new observation must invalidate the list, and retain source conflicts.
  const observation = repository.readObservations()[0];
  const raw = { ...observation.native.raw, transcript: firstLine.replace('第一轮', '被改写的第一轮') + secondLine };
  repository.saveObservations([{ ...observation, native: antigravityAdapter.decodeEvidence({ ...observation.native, raw }), observedAt: new Date().toISOString() }]);
  decodes = 0;
  const changed = await service.sessions();
  assert.equal(decodes, 2, 'each distinct observation is decoded anew after evidence changes');
  assert.ok(changed.flatMap(session => session.tasks.flatMap(task => task.turns))
    .every(request => request.assignment.turn.reason === 'source_changed'));
});
