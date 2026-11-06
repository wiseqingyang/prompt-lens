// Reproducible synthetic benchmark. Uses only mkdtemp databases; never opens user data.
// Run after build:main: node --expose-gc scripts/storage-benchmark.cjs
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const { StorageEngine } = require('../dist/main/storage');
const { chunkContent, CHUNK_V1 } = require('../dist/main/content-store');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-storage-benchmark-'));
let seed = 123;
function text(bytes) {
  const words = ['function', 'return', 'await', 'context', 'message', 'token', 'implementation', 'SQLite', 'session', '中文🙂'];
  let output = '';
  for (let i = 0; output.length < bytes; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    output += `${words[(seed >>> 0) % words.length]} ${((seed >>> 0) % 100000).toString(16)} ${i % 2 ? '\n' : ' '}`;
  }
  return output;
}
function elapsed(start) { return +(performance.now() - start).toFixed(2); }
function size(file) { return [file, file + '-wal'].reduce((sum, f) => sum + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0); }
const payloads = [];
const shared = Array.from({ length: 6 }, () => text(192 * 1024));
for (let i = 0; i < 120; i++) {
  const base = i % 5 === 0 ? text(192 * 1024) : shared[i % shared.length];
  payloads.push({ event_id: `bench-${i}`, session_id: `session-${i % 12}`, agent_name: 'Pi Agent', provider: 'openai', model: 'synthetic',
    input_tokens: 100, output_tokens: 20, total_tokens: 120, user_prompt: `Synthetic question ${i}`, prompt_summary: `Question ${i}`,
    request_body: JSON.stringify({ instructions: base, input: text(16 * 1024) }), system_prompt: base,
    response_body: JSON.stringify({ reply: text(32 * 1024) }), response_text: text(32 * 1024), thinking_text: text(8 * 1024) });
}
async function run() {
  const file = path.join(root, 'legacy.db');
  let storage = new StorageEngine(file);
  let start = performance.now();
  for (const row of payloads) storage.insertRecord(row);
  const stagedWriteMs = elapsed(start);
  const stagedBytes = size(file);
  // Materialize v10 storage: Deflate per request/response, plain other heavy columns, no ledger/blocks.
  for (const row of storage.db.prepare('SELECT id, request_body, response_body FROM records').all()) {
    storage.db.prepare('UPDATE records SET request_body = ?, response_body = ? WHERE id = ?').run(
      zlib.deflateRawSync(Buffer.from(row.request_body)), zlib.deflateRawSync(Buffer.from(row.response_body)), row.id);
  }
  for (const { name } of storage.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()) storage.db.exec(`DROP TRIGGER ${name}`);
  storage.db.exec('DROP VIEW usage_events; DROP TABLE usage_ledger; DROP TABLE storage_metadata; DROP TABLE content_refs; DROP TABLE content_fields; DROP TABLE content_blocks; DROP INDEX idx_records_content_pending; ALTER TABLE records DROP COLUMN content_expired;');
  storage.db.pragma('user_version = 10');
  storage.db.exec('VACUUM'); storage.checkpoint(); storage.close();
  const legacyBytes = size(file);
  storage = new StorageEngine(file);
  global.gc?.();
  const rssBefore = process.memoryUsage().rss;
  let peakRss = rssBefore;
  start = performance.now();
  storage.startMaintenance({ retentionDays: 0, rawPayloadRetentionDays: 0 });
  const pending = storage.db.prepare("SELECT COUNT(*) c FROM records WHERE LENGTH(request_body) > 0 OR LENGTH(response_body) > 0 OR LENGTH(system_prompt) > 0 OR LENGTH(response_text) > 0 OR LENGTH(thinking_text) > 0");
  const deadline = Date.now() + 120_000;
  while (pending.get().c) {
    if (Date.now() > deadline) throw new Error('background migration timeout');
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await storage.stopMaintenance();
  const migrationMs = elapsed(start);
  start = performance.now();
  for (let n = 0; n < payloads.length; n++) {
    const read = storage.getRecordById(n + 1);
    for (const field of ['request_body', 'response_body', 'system_prompt', 'response_text', 'thinking_text']) {
      if (!Buffer.from(read[field]).equals(Buffer.from(payloads[n][field]))) throw new Error(`byte mismatch ${n}/${field}`);
    }
  }
  const detailsMs = elapsed(start);
  const beforeReclaimBytes = size(file);
  await storage.reclaimSpace();
  const newBytes = size(file);
  const info = storage.getDbInfo();
  start = performance.now();
  for (let n = 0; n < 100; n++) storage.getRecords({ lightweight: true, limit: 50 });
  const listsMs = elapsed(start);
  start = performance.now();
  for (let n = 0; n < 100; n++) storage.getStats();
  const statsMs = elapsed(start);
  storage.close();
  const configurations = [];
  // Actual SQLite parameter evaluation includes ordered refs and field manifests, not just Buffer lengths.
  for (const target of [16 * 1024, 32 * 1024, 64 * 1024]) {
    const dbFile = path.join(root, `chunks-${target}.db`);
    const db = new Database(dbFile);
    db.exec(`CREATE TABLE blocks(hash TEXT PRIMARY KEY, version INTEGER, codec TEXT, raw_length INTEGER, data BLOB) WITHOUT ROWID;
      CREATE TABLE refs(record_id INTEGER, field TEXT, ordinal INTEGER, hash TEXT, PRIMARY KEY(record_id, field, ordinal)) WITHOUT ROWID;
      CREATE INDEX idx_refs_hash ON refs(hash);
      CREATE TABLE fields(record_id INTEGER, field TEXT, version INTEGER, encoding TEXT, raw_length INTEGER, digest TEXT, chunk_count INTEGER, PRIMARY KEY(record_id, field)) WITHOUT ROWID;`);
    let blockCount = 0, refCount = 0;
    const config = { ...CHUNK_V1, min: target / 4, target, max: target * 4 };
    start = performance.now();
    db.transaction(() => payloads.forEach((row, id) => {
      for (const field of ['request_body', 'response_body', 'system_prompt', 'response_text', 'thinking_text']) {
        const bytes = Buffer.from(row[field]);
        const chunks = chunkContent(bytes, config);
        chunks.forEach((chunk, ordinal) => {
          const hash = crypto.createHash('sha256').update(chunk).digest('hex');
          if (!db.prepare('SELECT 1 FROM blocks WHERE hash = ?').get(hash)) {
            const br = zlib.brotliCompressSync(chunk, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } });
            db.prepare('INSERT INTO blocks VALUES (?, 1, ?, ?, ?)').run(hash, br.length < chunk.length ? 'br9' : 'raw', chunk.length, br.length < chunk.length ? br : chunk);
            blockCount++;
          }
          db.prepare('INSERT INTO refs VALUES (?, ?, ?, ?)').run(id, field, ordinal, hash); refCount++;
        });
        db.prepare('INSERT INTO fields VALUES (?, ?, 1, ?, ?, ?, ?)').run(id, field, 'utf8', bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'), chunks.length);
      }
    }))();
    const durationMs = elapsed(start);
    db.exec('VACUUM'); db.close();
    configurations.push({ min: config.min, target, max: config.max, sqliteBytes: size(dbFile), durationMs, blockCount, refCount });
  }
  console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, arch: process.arch },
    dataset: { records: payloads.length, fields: payloads.length * 5, logicalBytes: info.logicalBytes, independentContextFraction: 0.2, sharedContexts: 6 },
    legacyBytes, stagedBytes, beforeReclaimBytes, newBytes, savedPercent: +((1 - newBytes / legacyBytes) * 100).toFixed(2),
    stagedWriteMs, stagedWritePerRecordMs: stagedWriteMs / payloads.length, migrationMs, migrationPerRecordMs: migrationMs / payloads.length,
    detailsMs, detailPerRecordMs: detailsMs / payloads.length, lists100Ms: listsMs, stats100Ms: statsMs,
    rssBefore, peakRss, rssIncrease: peakRss - rssBefore, processMaxRssBytes: process.resourceUsage().maxRSS * 1024,
    blocks: info.uniqueBytes, storedPayloadBytes: info.storedBytes, configurations,
    limits: 'Synthetic corpus, not a prediction for real history. Migration measurement uses the actual production worker with its idle/batch delays. RSS includes the parent-held synthetic corpus and worker; it is not an application memory forecast. New writes are staged durably and compressed asynchronously. Size after explicit reclaim includes SQLite indexes/ledger/manifests; no Buffer-only savings claim.' }, null, 2));
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
