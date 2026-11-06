import { readCapture } from './capture';
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { deflateRawSync, inflateRawSync } from 'zlib';
import type { AttributionDecision } from '../../shared/attribution';
import type { AgentAdapter, CaptureFacts, NativeEvidence } from './contracts';

export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
export const evidenceScope = (adapterId: string, facts: CaptureFacts): string | undefined => facts.locator
  ? facts.locator.kind === 'pi' ? JSON.stringify([adapterId, facts.locator.api, facts.locator.responseId])
    : JSON.stringify([adapterId, facts.locator.conversationId, facts.locator.trajectoryId]) : undefined;

export interface StoredAttribution {
  recordId: number;
  adapterId: string;
  version: string;
  facts: CaptureFacts;
  capturedAt: string;
  captureDigest: string;
  observationDigest?: string;
  /** Transient concurrency proof, never persisted. */
  captureRevision?: string;
  native: NativeEvidence;
  decision: AttributionDecision;
}
export interface EvidenceObservation {
  recordId: number;
  adapterId: string;
  scope: string;
  native: NativeEvidence;
  observedAt: string;
}

/** Evidence observations outlive projections and are independent of rule versions. */
export class AttributionRepository {
  private liveStatement?: Database.Statement;
  private evidenceExistsStatement?: Database.Statement;
  private insertEvidenceStatement?: Database.Statement;
  constructor(private readonly db: Database.Database) {}

  static createSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS attribution_evidence (hash TEXT PRIMARY KEY, snapshot BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS request_attributions (
        record_id INTEGER NOT NULL, adapter_id TEXT NOT NULL, rule_version TEXT NOT NULL,
        capture_digest TEXT NOT NULL, captured_at TEXT NOT NULL, facts TEXT NOT NULL,
        evidence_hash TEXT NOT NULL, decision TEXT NOT NULL,
        PRIMARY KEY(record_id, adapter_id, rule_version)
      );
      CREATE TABLE IF NOT EXISTS attribution_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, adapter_id TEXT NOT NULL,
        scope TEXT NOT NULL, evidence_hash TEXT NOT NULL, observed_at TEXT NOT NULL,
        UNIQUE(scope, evidence_hash)
      );
      CREATE INDEX IF NOT EXISTS attribution_observations_scope ON attribution_observations(scope);
      CREATE INDEX IF NOT EXISTS idx_request_attributions_evidence_hash ON request_attributions(evidence_hash);
      CREATE INDEX IF NOT EXISTS idx_attribution_observations_evidence_hash ON attribution_observations(evidence_hash);
      CREATE TABLE IF NOT EXISTS attribution_scope_records (
        record_id INTEGER NOT NULL, adapter_id TEXT NOT NULL, scope TEXT NOT NULL,
        PRIMARY KEY(record_id, adapter_id)
      );
      CREATE INDEX IF NOT EXISTS attribution_scope_records_scope ON attribution_scope_records(scope);
      CREATE TABLE IF NOT EXISTS attribution_jobs (
        record_id INTEGER PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0
      );
      DROP TRIGGER IF EXISTS delete_record_attribution;
      DROP TRIGGER IF EXISTS expire_record_attribution;
      CREATE TRIGGER delete_record_attribution AFTER DELETE ON records BEGIN
        DELETE FROM request_attributions WHERE record_id = OLD.id;
        DELETE FROM attribution_scope_records WHERE record_id = OLD.id;
        DELETE FROM attribution_observations WHERE scope NOT IN (SELECT scope FROM attribution_scope_records);
        DELETE FROM attribution_jobs WHERE record_id = OLD.id;
        DELETE FROM attribution_evidence WHERE hash NOT IN
          (SELECT evidence_hash FROM request_attributions UNION SELECT evidence_hash FROM attribution_observations);
      END;
      CREATE TRIGGER expire_record_attribution AFTER UPDATE OF content_expired ON records
      WHEN NEW.content_expired = 1 BEGIN
        DELETE FROM request_attributions WHERE record_id = NEW.id;
        DELETE FROM attribution_scope_records WHERE record_id = NEW.id;
        DELETE FROM attribution_observations WHERE scope NOT IN (SELECT scope FROM attribution_scope_records);
        DELETE FROM attribution_jobs WHERE record_id = NEW.id;
        DELETE FROM attribution_evidence WHERE hash NOT IN
          (SELECT evidence_hash FROM request_attributions UNION SELECT evidence_hash FROM attribution_observations);
      END;
      CREATE TRIGGER IF NOT EXISTS queue_record_attribution AFTER INSERT ON records
      WHEN NEW.content_expired = 0 BEGIN
        INSERT OR IGNORE INTO attribution_jobs(record_id) VALUES (NEW.id);
      END;
    `);
    const repository = new AttributionRepository(db);
    // v13 retained parsed snapshots, sometimes nested under an unavailable observation.
    // Preserve their actual fidelity; never manufacture raw source records during migration.
    repository.saveObservations(repository.readAll().flatMap(row => {
      const scope = evidenceScope(row.adapterId, row.facts);
      const native = row.native.status === 'available' ? row.native : row.native.previous;
      return scope && native ? [{ recordId: row.recordId, adapterId: row.adapterId, scope, native,
        observedAt: '' }] : []; // v13 did not record observation time.
    }));
    repository.queueExisting();
  }

  /** v15: a changed capture cannot reuse facts from an older input snapshot. */
  static installCaptureInvalidation(db: Database.Database): void {
    const fields = ['request_body', 'request_headers', 'agent_name', 'schema_version', 'transport',
      'attribution', 'method', 'status_code', 'created_at'];
    db.exec(`DROP TRIGGER IF EXISTS invalidate_capture_attribution;
      CREATE TRIGGER invalidate_capture_attribution AFTER UPDATE OF ${fields.join(', ')} ON records
      WHEN NEW.content_expired = 0 AND (${fields.map(field => `OLD.${field} IS NOT NEW.${field}`).join(' OR ')}) BEGIN
        UPDATE request_attributions SET capture_digest = '' WHERE record_id = NEW.id;
        INSERT INTO attribution_jobs(record_id) VALUES (NEW.id)
          ON CONFLICT(record_id) DO UPDATE SET attempts=0, next_attempt=0;
      END;
      UPDATE request_attributions SET capture_digest = '';
      INSERT OR IGNORE INTO attribution_jobs(record_id) SELECT id FROM records WHERE content_expired=0;`);
  }

  revision(): string {
    const row = this.db.prepare('SELECT total_changes() AS changes').get() as { changes: number };
    return `${row.changes}:${this.db.pragma('data_version', { simple: true })}`;
  }

  /** Query projections are reconstructible; a busy writer must not block session reads. */
  tryProjectionWrite(write: () => void): boolean {
    const timeout = this.db.pragma('busy_timeout', { simple: true }) as number;
    let entered = false;
    try {
      this.db.pragma('busy_timeout = 0');
      this.db.transaction(() => { entered = true; write(); }).immediate();
      return true;
    } catch (error) {
      // Only failure to reserve the write lock is optional. Never hide a failed write,
      // corrupt evidence or another database error inside the transaction.
      if (!entered && (error as { code?: string }).code === 'SQLITE_BUSY') return false;
      throw error;
    } finally {
      this.db.pragma(`busy_timeout = ${timeout}`);
    }
  }

  /** v16: connection-event classification also depends on response and capture state. */
  static installConnectionInvalidation(db: Database.Database): void {
    const fields = ['response_body', 'capture_status', 'truncated_reason'];
    db.exec(`DROP TRIGGER IF EXISTS invalidate_connection_attribution;
      CREATE TRIGGER invalidate_connection_attribution AFTER UPDATE OF ${fields.join(', ')} ON records
      WHEN NEW.content_expired = 0 AND (OLD.attribution = 'connection' OR NEW.attribution = 'connection')
        AND (${fields.map(field => `OLD.${field} IS NOT NEW.${field}`).join(' OR ')}) BEGIN
        UPDATE request_attributions SET capture_digest = '' WHERE record_id = NEW.id;
        INSERT INTO attribution_jobs(record_id) VALUES (NEW.id)
          ON CONFLICT(record_id) DO UPDATE SET attempts=0, next_attempt=0;
      END;
      UPDATE request_attributions SET capture_digest = '' WHERE record_id IN
        (SELECT id FROM records WHERE attribution = 'connection' AND content_expired=0);
      INSERT OR IGNORE INTO attribution_jobs(record_id)
        SELECT id FROM records WHERE attribution = 'connection' AND content_expired=0;`);
  }

  /** v17: Antigravity search relations depend on response contents and completion state. */
  static installSearchInvalidation(db: Database.Database): void {
    const fields = ['response_body', 'capture_status', 'truncated_reason'];
    db.exec(`CREATE TRIGGER IF NOT EXISTS invalidate_search_attribution AFTER UPDATE OF ${fields.join(', ')} ON records
      WHEN NEW.content_expired = 0 AND agent_category(NEW.agent_name) = 'Antigravity'
        AND (${fields.map(field => `OLD.${field} IS NOT NEW.${field}`).join(' OR ')}) BEGIN
        UPDATE request_attributions SET capture_digest = '' WHERE record_id = NEW.id;
        INSERT INTO attribution_jobs(record_id) VALUES (NEW.id)
          ON CONFLICT(record_id) DO UPDATE SET attempts=0, next_attempt=0;
      END;
      UPDATE request_attributions SET capture_digest = '' WHERE adapter_id = 'antigravity';
      INSERT OR IGNORE INTO attribution_jobs(record_id)
        SELECT id FROM records WHERE agent_category(agent_name) = 'Antigravity' AND content_expired=0;`);
  }

  /** v19: Pi session matching depends on response IDs, completion and capture state. */
  static installPiInvalidation(db: Database.Database): void {
    db.exec(`CREATE TRIGGER IF NOT EXISTS invalidate_pi_attribution
      AFTER UPDATE OF response_body, capture_status, truncated_reason ON records
      WHEN NEW.content_expired=0 AND agent_category(NEW.agent_name)='Pi'
        AND (OLD.response_body IS NOT NEW.response_body OR OLD.capture_status IS NOT NEW.capture_status
          OR OLD.truncated_reason IS NOT NEW.truncated_reason) BEGIN
        UPDATE request_attributions SET capture_digest='' WHERE record_id=NEW.id;
        INSERT INTO attribution_jobs(record_id) VALUES(NEW.id)
          ON CONFLICT(record_id) DO UPDATE SET attempts=0, next_attempt=0;
      END;`);
  }

  static installProjectionCache(db: Database.Database): void {
    const columns = db.pragma('table_info(request_attributions)') as { name: string }[];
    if (!columns.some(column => column.name === 'observation_digest')) {
      db.exec("ALTER TABLE request_attributions ADD COLUMN observation_digest TEXT NOT NULL DEFAULT ''");
    }
  }

  observationDigests(): Map<string, string> {
    const groups = new Map<string, string[]>();
    for (const row of this.db.prepare('SELECT scope, evidence_hash FROM attribution_observations ORDER BY id').all() as {scope: string; evidence_hash: string}[]) {
      const hashes = groups.get(row.scope) || []; hashes.push(row.evidence_hash); groups.set(row.scope, hashes);
    }
    return new Map([...groups].map(([scope, hashes]) => [scope, digest(JSON.stringify(hashes))]));
  }

  queueExisting(): void {
    this.db.exec('INSERT OR IGNORE INTO attribution_jobs(record_id) SELECT id FROM records WHERE content_expired = 0');
  }

  dueJobs(now: number, limit: number): number[] {
    return (this.db.prepare('SELECT record_id FROM attribution_jobs WHERE next_attempt <= ? ORDER BY next_attempt, record_id DESC LIMIT ?')
      .all(now, limit) as { record_id: number }[]).map(row => row.record_id);
  }

  finishJobs(ids: number[], retry: Set<number>, retryBaseMs: number): void {
    const remove = this.db.prepare('DELETE FROM attribution_jobs WHERE record_id = ?');
    const defer = this.db.prepare('UPDATE attribution_jobs SET next_attempt = ? + MIN(60000, ? * (1 << MIN(attempts, 10))), attempts = attempts + 1 WHERE record_id = ?');
    this.db.transaction(() => {
      for (const id of ids) if (retry.has(id)) defer.run(Date.now(), retryBaseMs, id); else remove.run(id);
    })();
  }

  private readEvidence(hash: string, cache: Map<string, NativeEvidence>): NativeEvidence {
    if (!cache.has(hash)) {
      const row = this.db.prepare('SELECT snapshot FROM attribution_evidence WHERE hash = ?').get(hash) as { snapshot: string | Buffer } | undefined;
      if (!row) throw new Error('Attribution evidence snapshot is missing');
      const text = Buffer.isBuffer(row.snapshot) ? inflateRawSync(row.snapshot, { maxOutputLength: 128 * 1024 * 1024 }).toString('utf8') : row.snapshot;
      cache.set(hash, JSON.parse(text));
    }
    return cache.get(hash)!;
  }

  private saveEvidence(native: NativeEvidence): string {
    const snapshot = JSON.stringify(native), hash = digest(snapshot);
    const exists = this.evidenceExistsStatement ??= this.db.prepare('SELECT 1 FROM attribution_evidence WHERE hash = ?');
    if (!exists.get(hash)) {
      (this.insertEvidenceStatement ??= this.db.prepare('INSERT INTO attribution_evidence(hash, snapshot) VALUES (?, ?)'))
        .run(hash, snapshot.length > 4096 ? deflateRawSync(Buffer.from(snapshot)) : snapshot);
    }
    return hash;
  }

  readAll(ids?: number[], adapters?: readonly AgentAdapter[]): StoredAttribution[] {
    if (ids && !ids.length || adapters && !adapters.length) return [];
    const versionFilter = adapters ? ` AND (${adapters.map(() => '(adapter_id=? AND rule_version=?)').join(' OR ')})` : '';
    const versions = adapters?.flatMap(adapter => [adapter.id, adapter.version]) || [];
    const cache = new Map<string, NativeEvidence>();
    const rows: Record<string, string | number>[] = [];
    if (ids) {
      for (let offset = 0; offset < ids.length; offset += 500) {
        const batch = ids.slice(offset, offset + 500);
        rows.push(...this.db.prepare(`SELECT * FROM request_attributions WHERE record_id IN (${batch.map(() => '?').join(',')})${versionFilter}`)
          .all(...batch, ...versions) as Record<string, string | number>[]);
      }
    } else rows.push(...this.db.prepare('SELECT * FROM request_attributions WHERE 1=1' + versionFilter).all(...versions) as Record<string, string | number>[]);
    const self = this;
    return rows.map(row => {
      const hash = String(row.evidence_hash);
      let loaded: NativeEvidence | undefined;
      return {
        recordId: Number(row.record_id), adapterId: String(row.adapter_id), version: String(row.rule_version),
        facts: JSON.parse(String(row.facts)), capturedAt: String(row.captured_at), captureDigest: String(row.capture_digest), observationDigest: String(row.observation_digest || ''),
        get native(): NativeEvidence { return loaded ??= self.readEvidence(hash, cache); },
        set native(value: NativeEvidence) { loaded = value; },
        decision: JSON.parse(String(row.decision))
      };
    });
  }

  readObservations(scope?: string): EvidenceObservation[] {
    const cache = new Map<string, NativeEvidence>();
    const query = 'SELECT *, (SELECT MIN(record_id) FROM attribution_scope_records r WHERE r.scope = attribution_observations.scope) AS record_id FROM attribution_observations' + (scope ? ' WHERE scope = ?' : '') + ' ORDER BY id';
    const rows = this.db.prepare(query).all(...(scope ? [scope] : [])) as Record<string, string | number>[];
    return rows.map(row => ({ recordId: Number(row.record_id), adapterId: String(row.adapter_id), scope: String(row.scope),
      observedAt: String(row.observed_at), native: this.readEvidence(String(row.evidence_hash), cache) }));
  }

  saveObservations(rows: EvidenceObservation[]): void {
    const hasScope = this.db.prepare('SELECT 1 FROM attribution_scope_records WHERE record_id = ? AND adapter_id = ? AND scope = ?');
    const hasObservation = this.db.prepare('SELECT 1 FROM attribution_observations WHERE scope = ? AND evidence_hash = ?');
    const save = this.db.prepare('INSERT OR IGNORE INTO attribution_observations(adapter_id, scope, evidence_hash, observed_at) VALUES (?, ?, ?, ?)');
    this.db.transaction(() => {
      for (const row of rows) {
        if (!this.live(row.recordId)) continue;
        if (!hasScope.get(row.recordId, row.adapterId, row.scope)) this.linkScope(row.recordId, row.adapterId, row.scope);
        const hash = this.saveEvidence(row.native);
        // AUTOINCREMENT touches sqlite_sequence before checking UNIQUE(scope, evidence_hash),
        // which would write a WAL frame and bump data_version even when the observation is unchanged.
        if (!hasObservation.get(row.scope, hash)) save.run(row.adapterId, row.scope, hash, row.observedAt);
      }
    }).immediate();
  }

  linkScope(recordId: number, adapterId: string, scope: string): void {
    if (!this.live(recordId)) return;
    this.db.prepare('INSERT OR IGNORE INTO attribution_scope_records(record_id, adapter_id, scope) VALUES (?, ?, ?)')
      .run(recordId, adapterId, scope);
  }

  private live(id: number): boolean {
    const statement = this.liveStatement ??= this.db.prepare('SELECT content_expired FROM records WHERE id = ?');
    const row = statement.get(id) as { content_expired: number } | undefined;
    return !!row && !row.content_expired;
  }

  clearExpiredIdentityIndexes(): void {
    this.db.exec(`UPDATE records SET session_id='unknown:record:' || id, thread_id='', turn_id='',
      session_namespace='', session_confidence='unknown', session_id_source='unknown'
      WHERE agent_category(agent_name) IN ('Codex', 'Pi', 'WorkBuddy') AND content_expired=1 AND
        (thread_id != '' OR turn_id != '' OR session_confidence != 'unknown' OR session_namespace != '')`);
  }

  saveBatch(rows: StoredAttribution[]): boolean {
    const save = this.db.prepare(`INSERT INTO request_attributions
      (record_id, adapter_id, rule_version, capture_digest, captured_at, facts, evidence_hash, decision, observation_digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id, adapter_id, rule_version) DO UPDATE SET
        capture_digest=excluded.capture_digest, captured_at=excluded.captured_at, facts=excluded.facts,
        evidence_hash=excluded.evidence_hash, decision=excluded.decision, observation_digest=excluded.observation_digest
      WHERE capture_digest != excluded.capture_digest OR captured_at != excluded.captured_at
        OR facts != excluded.facts OR evidence_hash != excluded.evidence_hash OR decision != excluded.decision OR observation_digest != excluded.observation_digest`);
    const queryDigest = this.db.prepare('SELECT capture_digest FROM request_attributions WHERE record_id=? AND adapter_id=? AND rule_version=?');
    const updateIdentity = this.db.prepare(`UPDATE records SET session_id=@session, thread_id=@thread, turn_id=@turn,
      session_namespace='', session_confidence=@confidence, session_id_source=@source WHERE id=@id AND
      (session_id != @session OR thread_id != @thread OR turn_id != @turn OR session_namespace != ''
      OR session_confidence != @confidence OR session_id_source != @source)`);
    return this.db.transaction(() => {
      let changed = false;
      const revision = this.revision();
      for (const row of rows) {
        if (!this.live(row.recordId)) continue;
        // A valid stored digest proves these capture facts have not been invalidated.
        // Changed/new inputs are checked under the write transaction for every adapter.
        const current = queryDigest.get(row.recordId, row.adapterId, row.version) as { capture_digest: string } | undefined;
        if (row.captureRevision !== revision && (!current?.capture_digest || current.capture_digest !== row.captureDigest) &&
            digest(JSON.stringify(readCapture(this.db, row.recordId))) !== row.captureDigest) continue;
        const write = save.run(row.recordId, row.adapterId, row.version, row.captureDigest, row.capturedAt,
          JSON.stringify(row.facts), this.saveEvidence(row.native), JSON.stringify(row.decision), row.observationDigest || '');
        changed ||= write.changes > 0;
        if (row.decision.identitySource || row.adapterId === 'codex') {
          const session = row.decision.session.status === 'resolved' ? row.decision.session.value : '';
          const turn = session && row.decision.turn.status === 'resolved' ? row.decision.turn.value.id : '';
          const identity = { id: row.recordId, session: session || `unknown:record:${row.recordId}`, thread: session, turn,
            confidence: session ? 'exact' : 'unknown', source: session ? row.decision.identitySource || 'codex_metadata' : 'unknown' };
          const update = updateIdentity.run(identity);
          changed ||= update.changes > 0;
        }
      }
      return changed;
    }).immediate();
  }
}
