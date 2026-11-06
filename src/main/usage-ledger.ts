import Database from 'better-sqlite3';

// No foreign key: deletion of records must never delete usage or the event tombstone.
const columns = ['id', 'event_id', 'created_at', 'session_id', 'agent_name', 'provider', 'model', 'url_path',
  'input_tokens', 'output_tokens', 'cached_tokens', 'thinking_tokens', 'total_tokens', 'cache_ratio',
  'token_source', 'duration_ms', 'status_code', 'capture_status', 'user_prompt', 'prompt_summary'];
const key = (prefix: string) => `CASE WHEN ${prefix}event_id IS NOT NULL AND ${prefix}event_id != '' THEN 'event:' || ${prefix}event_id ELSE 'record:' || ${prefix}id END`;
const values = (prefix: string) => columns.map(c => ['user_prompt', 'prompt_summary'].includes(c)
  ? `substr(${prefix}${c}, 1, 200)` : `${prefix}${c}`).join(', ');

export function createUsageLedger(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS usage_ledger (
    event_key TEXT PRIMARY KEY, id INTEGER NOT NULL, event_id TEXT, created_at TEXT,
    session_id TEXT, agent_name TEXT, provider TEXT, model TEXT, url_path TEXT,
    input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, thinking_tokens INTEGER,
    total_tokens INTEGER, cache_ratio REAL, token_source TEXT, duration_ms INTEGER,
    status_code INTEGER, capture_status TEXT, user_prompt TEXT, prompt_summary TEXT,
    counted INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_usage_record_id ON usage_ledger(id);
  CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_ledger(created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage_ledger(agent_name);
  CREATE TABLE IF NOT EXISTS storage_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT OR IGNORE INTO storage_metadata VALUES ('usage_backfill_cursor', '0');
  INSERT OR IGNORE INTO storage_metadata VALUES ('usage_coverage_start',
    COALESCE((SELECT MIN(datetime(created_at)) FROM records), datetime('now')));
  CREATE TRIGGER IF NOT EXISTS usage_insert AFTER INSERT ON records BEGIN
    INSERT OR IGNORE INTO usage_ledger (event_key, ${columns.join(', ')}) VALUES (${key('NEW.')}, ${values('NEW.')});
  END;
  CREATE TRIGGER IF NOT EXISTS usage_update AFTER UPDATE OF ${columns.filter(c => c !== 'id').join(', ')} ON records BEGIN
    INSERT INTO usage_ledger (event_key, ${columns.join(', ')}) VALUES (${key('NEW.')}, ${values('NEW.')})
      ON CONFLICT(event_key) DO UPDATE SET ${columns.filter(c => c !== 'id' && c !== 'event_id').map(c => `${c} = excluded.${c}`).join(', ')};
  END;
  CREATE TRIGGER IF NOT EXISTS usage_before_delete BEFORE DELETE ON records BEGIN
    INSERT OR IGNORE INTO usage_ledger (event_key, ${columns.join(', ')}) VALUES (${key('OLD.')}, ${values('OLD.')});
  END;
  CREATE VIEW IF NOT EXISTS usage_events AS
    SELECT ${columns.join(', ')} FROM usage_ledger WHERE counted = 1
    UNION ALL SELECT ${values('r.')} FROM records r
      WHERE r.id > CAST((SELECT value FROM storage_metadata WHERE key = 'usage_backfill_cursor') AS INTEGER)
        AND NOT EXISTS (SELECT 1 FROM usage_ledger u WHERE u.event_key = ${key('r.')});
  `);
}

export function backfillUsageBatch(db: Database.Database, limit = 500): number {
  return db.transaction(() => {
    const cursor = Number((db.prepare("SELECT value FROM storage_metadata WHERE key = 'usage_backfill_cursor'").get() as any).value);
    const end = (db.prepare('SELECT MAX(id) id FROM (SELECT id FROM records WHERE id > ? ORDER BY id LIMIT ?)').get(cursor, limit) as any).id;
    if (end === null) return 0;
    const result = db.prepare(`INSERT OR IGNORE INTO usage_ledger (event_key, ${columns.join(', ')})
      SELECT ${key('r.')}, ${values('r.')} FROM records r WHERE id > ? AND id <= ?`).run(cursor, end);
    db.prepare("UPDATE storage_metadata SET value = ? WHERE key = 'usage_backfill_cursor'").run(String(end));
    // A captured row can already have a ledger entry, but advancing the cursor still counts as work.
    return Math.max(1, result.changes);
  }).immediate();
}
