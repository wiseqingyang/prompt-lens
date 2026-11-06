import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';
import { AttributionRepository } from './attribution/repository';
import { ContentStore } from './content-store';
import { backfillUsageBatch } from './usage-ledger';
import { expiredRecordIds } from './retention';
import { getAgentCategory } from '../shared/agent';

const db = new Database(workerData.dbPath);
db.pragma('busy_timeout = 5000');
const store = new ContentStore(db);
let policy = workerData.policy;
let stopped = false;
let nextCleanup = 0;
let lastActivity = 0;
let lastMaintenance = 0;
parentPort?.on('message', message => {
  if (message.stop) { stopped = true; db.close(); parentPort?.close(); }
  else if (message.policy) { policy = message.policy; nextCleanup = 0; }
  else if (message.activity) lastActivity = message.activity;
});

function cleanup(): number {
  let changes = 0;
  const expired = (days: number, contentOnly = false) => expiredRecordIds(db, days, { contentOnly });
  // Definitions are identical to the main connection; every worker connection needs these UDFs.
  if (policy.retentionDays > 0) db.transaction(() => {
    for (const id of expired(policy.retentionDays)) changes += db.prepare('DELETE FROM records WHERE id = ?').run(id).changes;
  }).immediate();
  if (policy.rawPayloadRetentionDays > 0) db.transaction(() => {
    for (const id of expired(policy.rawPayloadRetentionDays, true)) {
      changes += db.prepare(`UPDATE records SET request_body = '', response_body = '', system_prompt = '',
        response_text = '', thinking_text = '', content_expired = 1 WHERE id = ? AND content_expired = 0`).run(id).changes;
      db.prepare('DELETE FROM content_refs WHERE record_id = ?').run(id);
      db.prepare('DELETE FROM content_fields WHERE record_id = ?').run(id);
    }
    if (changes) new AttributionRepository(db).clearExpiredIdentityIndexes();
  }).immediate();
  return changes;
}
db.function('agent_category', { deterministic: true }, getAgentCategory);
function tick(): void {
  if (stopped) return;
  try {
    // Prefer 250 ms of quiet after capture bursts; allow one bounded step every 5 s to prevent starvation.
    if (Date.now() - lastActivity < 250 && Date.now() - lastMaintenance < 5000) { setTimeout(tick, 250); return; }
    lastMaintenance = Date.now();
    const backfilled = backfillUsageBatch(db);
    const migrated = store.migrateOne();
    let changed = 0;
    if (Date.now() >= nextCleanup) {
      changed = cleanup();
      nextCleanup = Date.now() + (changed ? 1000 : 60_000);
      store.collectGarbage();
      db.pragma('wal_checkpoint(PASSIVE)');
      if (Number(db.pragma('auto_vacuum', { simple: true })) === 2) db.pragma('incremental_vacuum(128)');
    }
    if (migrated || changed || backfilled) parentPort?.postMessage({ changed: true });
    setTimeout(tick, migrated || backfilled ? 25 : 1000);
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
    setTimeout(tick, 30_000);
  }
}
tick();
