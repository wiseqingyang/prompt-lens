// Explicitly supplied consistent backup only. Never opens a default user database.
// node --expose-gc scripts/storage-copy-check.cjs <backup.db> <new-report.json>
// Product StorageEngine and all maintenance/deletion operate only on our temporary copy.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const { StorageEngine } = require('../dist/main/storage');
const { ContentStore, CONTENT_FIELDS } = require('../dist/main/content-store');
const { getAgentCategory } = require('../dist/shared/agent');
const { isWebFetchRequest } = require('../dist/shared/protocol');
const args = process.argv.slice(2);
if (args.length !== 2) throw new Error('Usage: storage-copy-check.cjs <consistent-backup.db> <new-report.json>');
const sourceCopy = path.resolve(args[0]), reportPath = path.resolve(args[1]);
if (sourceCopy === reportPath || fs.existsSync(reportPath)) throw new Error('Report must be a new file distinct from the backup');
process.umask(0o077);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-check-storage-copy-'));
const working = path.join(root, 'working.db');
const report = { status: 'running', startedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } };
const ensure = (condition, reason) => { if (!condition) throw new Error(reason); };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const signature = value => digest(Buffer.from(JSON.stringify(value)));
const elapsed = start => +(performance.now() - start).toFixed(2);
const size = file => [file, file + '-wal'].reduce((sum, f) => sum + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 128 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}
function fingerprint(db) {
  const version = db.pragma('user_version', { simple: true });
  const store = version >= 11 ? new ContentStore(db) : null;
  const ids = db.prepare('SELECT id FROM records ORDER BY id').all().map(row => row.id);
  const get = db.prepare(`SELECT ${CONTENT_FIELDS.join(',')} FROM records WHERE id=?`);
  const result = new Map();
  let nonempty = 0, logicalBytes = 0;
  for (const id of ids) {
    const row = get.get(id), fields = {};
    for (const field of CONTENT_FIELDS) {
      const value = row[field];
      const bytes = store ? Buffer.from(store.read(id, field, value)) : Buffer.isBuffer(value) ? zlib.inflateRawSync(value) : Buffer.from(value || '');
      fields[field] = { length: bytes.length, digest: digest(bytes) };
      if (bytes.length) nonempty++;
      logicalBytes += bytes.length;
    }
    result.set(id, fields);
  }
  return { result, nonempty, logicalBytes };
}
function compareContent(expected, actual, deleted = new Set()) {
  let checks = 0;
  for (const [id, fields] of expected.result) {
    if (deleted.has(id)) continue;
    ensure(actual.result.has(id), 'Record missing after migration');
    for (const field of CONTENT_FIELDS) {
      ensure(signature(fields[field]) === signature(actual.result.get(id)[field]), `Stored content changed in ${field}`);
      checks++;
    }
  }
  return checks;
}
function usage(engine) {
  const stats = engine.getStats(); stats.agents.sort();
  const dates = engine.db.prepare("SELECT DISTINCT date(created_at,'localtime') day FROM usage_events WHERE day IS NOT NULL ORDER BY day").all().map(row => row.day);
  return { stats, groups: ['all', 'Codex', 'Antigravity', 'Pi', 'Other'].map(group => ({ group,
    daily: engine.getDailyTokenActivity(group), models: dates.map(day => ({ day, models: engine.getDayModelUsage(day, group).sort((a, b) => a.model.localeCompare(b.model)) })) })) };
}
let baseline, storage;
async function run() {
  const sourceHash = await hashFile(sourceCopy);
  baseline = new Database(sourceCopy, { readonly: true, fileMustExist: true });
  report.sourceSchema = baseline.pragma('user_version', { simple: true });
  ensure(baseline.pragma('integrity_check', { simple: true }) === 'ok', 'Backup integrity check failed');
  baseline.function('agent_category', { deterministic: true }, getAgentCategory);
  baseline.function('is_model_request', { deterministic: true }, value => isWebFetchRequest(String(value || '')) ? 0 : 1);
  if (report.sourceSchema < 11) baseline.exec('CREATE TEMP VIEW usage_events AS SELECT * FROM records');
  const reader = Object.create(StorageEngine.prototype); reader.db = baseline;
  const before = fingerprint(baseline), beforeUsage = usage(reader);
  report.records = before.result.size; report.nonemptyFields = before.nonempty; report.logicalBytes = before.logicalBytes;
  report.legacyBytes = size(sourceCopy);
  let start = performance.now(); await baseline.backup(working, { progress: () => 256 }); report.copyMs = elapsed(start);
  baseline.close(); baseline = null;
  start = performance.now(); storage = new StorageEngine(working); report.schemaUpgradeMs = elapsed(start);
  report.startupContentChecks = compareContent(before, fingerprint(storage.db));
  report.startupUsageEqual = signature(beforeUsage) === signature(usage(storage));
  ensure(report.startupUsageEqual, 'Usage changed during schema upgrade');
  global.gc?.(); report.rssBefore = process.memoryUsage().rss; report.peakRss = report.rssBefore;
  const pending = () => storage.db.prepare(`SELECT COUNT(*) c FROM records WHERE content_expired=0 AND (${CONTENT_FIELDS.map(f => `LENGTH(${f})>0`).join(' OR ')})`).get().c;
  const counts = () => ['content_fields', 'content_refs', 'usage_ledger'].map(table => storage.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c);
  start = performance.now(); const deadline = Date.now() + 20 * 60_000;
  storage.startMaintenance({ retentionDays: 0, rawPayloadRetentionDays: 0 });
  let restarted = false, lastLog = 0;
  while (pending()) {
    ensure(Date.now() < deadline, 'Migration timed out');
    ensure(!storage.maintenanceError, 'Background migration failed');
    report.peakRss = Math.max(report.peakRss, process.memoryUsage().rss);
    const migrated = counts()[0];
    if (!restarted && migrated >= 100) {
      await storage.stopMaintenance(); const prior = counts();
      storage.close(); storage = new StorageEngine(working);
      ensure(signature(prior) === signature(counts()), 'Restart duplicated or lost entries');
      ensure(signature(usage(storage)) === signature(beforeUsage), 'Restart changed usage');
      report.interruptedAfterFields = prior[0]; restarted = true;
      storage.startMaintenance({ retentionDays: 0, rawPayloadRetentionDays: 0 });
    }
    if (Date.now() - lastLog >= 15_000) { lastLog = Date.now(); console.log(JSON.stringify({ stage: 'migration', fields: migrated, remainingRecords: pending(), elapsedMs: elapsed(start) })); }
    await pause();
  }
  await storage.stopMaintenance(); report.migrationMs = elapsed(start); report.rssIncrease = report.peakRss - report.rssBefore;
  start = performance.now(); report.finalContentChecks = compareContent(before, fingerprint(storage.db)); report.restoreCheckMs = elapsed(start);
  ensure(signature(usage(storage)) === signature(beforeUsage), 'Migration changed usage'); report.migrationUsageEqual = true;
  report.beforeReclaimBytes = size(working);
  start = performance.now(); await storage.reclaimSpace(); report.reclaimMs = elapsed(start);
  report.newBytes = size(working); report.savedPercent = +((1 - report.newBytes / report.legacyBytes) * 100).toFixed(2);
  ensure(storage.db.pragma('integrity_check', { simple: true }) === 'ok', 'Migrated integrity check failed');
  const prior = counts(); storage.close(); storage = new StorageEngine(working);
  ensure(signature(prior) === signature(counts()), 'Repeated open changed manifests or ledger');
  report.reopenContentChecks = compareContent(before, fingerprint(storage.db));
  ensure(signature(usage(storage)) === signature(beforeUsage), 'Repeated open changed usage');
  const shared = storage.db.prepare(`SELECT c.hash FROM content_refs c JOIN records r ON r.id=c.record_id WHERE r.session_id NOT IN ('','unknown')
    GROUP BY c.hash HAVING COUNT(DISTINCT r.session_id)>1 LIMIT 1`).get();
  ensure(shared, 'Dataset has no cross-session shared block');
  const selected = storage.db.prepare('SELECT r.session_id,r.agent_name FROM content_refs c JOIN records r ON r.id=c.record_id WHERE c.hash=? LIMIT 1').get(shared.hash);
  const deleted = new Set(storage.db.prepare('SELECT id FROM records WHERE session_id=? AND agent_name=?').all(selected.session_id, selected.agent_name).map(row => row.id));
  storage.db.transaction(() => storage.db.prepare('DELETE FROM records WHERE session_id=? AND agent_name=?').run(selected.session_id, selected.agent_name)).immediate();
  const store = new ContentStore(storage.db); while (store.collectGarbage()) {}
  report.deletionContentChecks = compareContent(before, fingerprint(storage.db), deleted); report.deletedRecords = deleted.size;
  ensure(signature(usage(storage)) === signature(beforeUsage), 'Session deletion changed usage');
  storage.clearRecords(); ensure(signature(usage(storage)) === signature(beforeUsage), 'Content clearing changed usage'); report.clearContentUsageEqual = true;
  storage.close(); storage = null;
  ensure(await hashFile(sourceCopy) === sourceHash, 'Source backup changed'); report.sourceBackupUnchanged = true;
  report.limits = 'Single consistent snapshot; whole-process RSS includes SQLite, validation and worker/restart. File hashing uses bounded streams. No Electron or live proxy restart and no real model requests. Missing-content backfill may populate previously absent fields in other datasets; this checker requires exact equality to this supplied backup.';
  report.status = 'passed';
}
run().catch(error => { report.status = 'failed'; report.error = error.message; process.exitCode = 1; }).finally(async () => {
  if (storage) { await storage.stopMaintenance(); storage.close(); }
  if (baseline) baseline.close();
  fs.rmSync(root, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ stage: 'complete', status: report.status, savedPercent: report.savedPercent, contentChecks: report.finalContentChecks, error: report.error }));
});
