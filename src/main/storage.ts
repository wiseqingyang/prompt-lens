import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import zlib from 'zlib';
import { Worker } from 'worker_threads';
import { ContentStore, ContentReadCache, CONTENT_FIELDS, decodeLegacy } from './content-store';
import { DayModelClient } from './day-model-client';
import { legacyChatDetail } from './legacy-chat-detail';
import { createUsageLedger, backfillUsageBatch } from './usage-ledger';
import { expiredRecordIds } from './retention';
import { AuditRecord, SessionCluster, DailyTokenDayStat, TokenActivitySummary, DayModelUsageItem } from './types';
import { extractResponseInfo, detectAgent } from './parser';
import { clearTaskClustersCache, dissectPromptAnatomy, resolveRequestParents, resolveSessionIdentity } from './session';
import { getAgentCategory } from '../shared/agent';
import type { RelatedHistory } from '../shared/history';
import { isWebFetchRequest, parseRequestTurnPayload } from '../shared/protocol';
import { AttributionRepository, digest } from './attribution/repository';
import { AttributionWorkerClient } from './attribution/workerClient';
import { AttributionService } from './attribution/service';
import { readCapture } from './attribution/capture';
import { AdapterRegistry } from './attribution/registry';
import type { CaptureInput, EvidenceRoots } from './attribution/contracts';
import { EvidenceCollector, type CollectionOptions } from './attribution/collector';

const identityAdapters = new AdapterRegistry().currentAdapters().filter(adapter => adapter.identityIndex);
/** Latest `user_version` written by initDb; update together with a new migration step. */
const SCHEMA_VERSION = 19;

const HEAD_TRUNCATE_BYTES = 500 * 1024; // 头部保留 500KB
const TAIL_TRUNCATE_BYTES = 500 * 1024; // 尾部保留 500KB

export function truncateUtf8ToSafeString(buf: Buffer, headBytes = HEAD_TRUNCATE_BYTES, tailBytes = TAIL_TRUNCATE_BYTES): string {
  let safeHeadEnd = Math.min(buf.length, headBytes);
  while (safeHeadEnd > 0 && (buf[safeHeadEnd] & 0xc0) === 0x80) {
    safeHeadEnd--;
  }
  let safeTailStart = Math.max(0, buf.length - tailBytes);
  while (safeTailStart < buf.length && (buf[safeTailStart] & 0xc0) === 0x80) {
    safeTailStart++;
  }

  const headText = buf.subarray(0, safeHeadEnd).toString('utf8');
  const tailText = buf.subarray(safeTailStart).toString('utf8');
  return `${headText}\n...[PromptLens 报文超出 5MB 安全上限已截断]...\n${tailText}`;
}

export function compressBody(val: any): any {
  if (typeof val === 'string') {
    const text = val;
    if (text.length > 512) {
      try {
        return zlib.deflateRawSync(Buffer.from(text, 'utf8'));
      } catch {
        return text;
      }
    }
    return text;
  }
  return val || '';
}

export function decompressBody(val: any): string { return decodeLegacy(val); }

function stageBody(value: unknown): string {
  return decodeLegacy(value);
}

export class StorageEngine {
  private dayModelClient?: DayModelClient;
  private attributionService?: AttributionService;
  private attributionWorker?: AttributionWorkerClient;
  private backgroundAttribution = false;
  private ownsSchema = true;
  private background(): AttributionWorkerClient {
    // A failed worker rejects its own pending work; later requests get a fresh execution context
    // instead of failing until the application restarts. Work never falls back to the host thread.
    if (this.attributionWorker?.failed) { void this.attributionWorker.close(); this.attributionWorker = undefined; }
    return this.attributionWorker ??= new AttributionWorkerClient(this.dbPath, () => this.attributionChanged());
  }
  private evidenceCollector?: EvidenceCollector;
  private attribution(): AttributionService {
    return this.attributionService ??= new AttributionService(this, new AttributionRepository(this.db));
  }
  public async getAttributedSessions(): Promise<SessionCluster[]> {
    if (!this.backgroundAttribution) return this.attribution().sessions();
    // The worker owns revision validation and caching, including deferred projection writes.
    // A host cache could retain an unpersisted result after a competing writer rolls back.
    return this.background().sessions();
  }
  public collectAttributionEvidence(root: EvidenceRoots, ids?: number[]) { return this.backgroundAttribution ? this.background().collect(root, ids) : this.attribution().collect(root, ids); }
  public startAttributionCollection(root: () => EvidenceRoots, options?: CollectionOptions): void {
    this.evidenceCollector ??= new EvidenceCollector(new AttributionRepository(this.db), { collect: (directory, ids) => this.collectAttributionEvidence(directory, ids) }, root, options);
    this.evidenceCollector.wake();
  }
  public async stopAttributionCollection(): Promise<void> {
    const collector = this.evidenceCollector;
    this.evidenceCollector = undefined;
    await collector?.stop();
    const worker = this.attributionWorker; this.attributionWorker = undefined;
    await worker?.close();
  }
  public refreshAttributionCollection(): void {
    if (!this.evidenceCollector) return;
    new AttributionRepository(this.db).queueExisting();
    this.db.exec('UPDATE attribution_jobs SET next_attempt = 0');
    this.evidenceCollector.wake();
  }

  public getRequestBody(id: number): string {
    const row = this.db.prepare('SELECT id, request_body, content_expired FROM records WHERE id = ?').get(id) as any;
    return row && !row.content_expired ? this.readField(row, 'request_body') : '';
  }
  public getAttributionCapture(id: number, cache?: ContentReadCache): CaptureInput {
    return readCapture(this.db, id, cache);
  }

  public attributionChanged(): void { this.bumpVersion(); clearTaskClustersCache(); }

  private projectImmediateAttribution(id: number, agentName: string): void {
    const adapter = identityAdapters.find(candidate => candidate.matches({ agentName, body: undefined, capturedAt: '' }));
    if (!adapter) return;
    const input = this.getAttributionCapture(id);
    if (!adapter.matches(input) || input.contentExpired) return;
    const facts = adapter.extract(input), native = adapter.evidenceMode === 'capture' ? { status: 'not_required' as const } : { status: 'unavailable' as const, reason: 'source_missing' as const };
    new AttributionRepository(this.db).saveBatch([{ recordId: id, adapterId: adapter.id, version: adapter.version,
      captureDigest: digest(JSON.stringify(input)), observationDigest: digest('[]'), capturedAt: input.capturedAt, facts, native,
      decision: { ...adapter.resolve({ facts, native, capturedAt: input.capturedAt }), identitySource: adapter.identityIndex!.source } }]);
  }

  private attachProtocols<T extends AuditRecord>(records: T[]): T[] {
    const adapters = identityAdapters;
    const eligible = records.filter(record => !record.content_expired && adapters.some(adapter => adapter.matches({ agentName: record.agent_name, body: undefined, capturedAt: '' })));
    const ids = [...new Set(eligible.map(record => record.id!))];
    const protocols = new Map<number, AuditRecord['protocol_family']>();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      const rows = this.db.prepare(`SELECT record_id, decision FROM request_attributions
        WHERE (${adapters.map(() => '(adapter_id=? AND rule_version=?)').join(' OR ')}) AND record_id IN (${batch.map(() => '?').join(',')})`)
        .all(...adapters.flatMap(adapter => [adapter.id, adapter.version]), ...batch) as { record_id: number; decision: string }[];
      for (const row of rows) {
        try { protocols.set(row.record_id, JSON.parse(row.decision).protocol?.family); }
        catch { /* Unsupported projection remains unavailable. */ }
      }
    }
    for (const record of eligible) {
      if (protocols.has(record.id!)) record.protocol_family = protocols.get(record.id!);
    }
    return records;
  }
  private db: Database.Database;
  private dbPath: string;
  private dataVersion: number = 1;
  private worker?: Worker;
  private maintenanceError = '';
  private contentStore?: ContentStore;
  private content(): ContentStore { return this.contentStore ??= new ContentStore(this.db); }
  private readField(row: any, field: string): string { return this.content().read(row.id, field, row[field]); }

  public startMaintenance(policy: { retentionDays: number; rawPayloadRetentionDays?: number }): void {
    if (this.worker) { this.worker.postMessage({ policy }); return; }
    this.worker = new Worker(path.join(__dirname, 'storage-worker.js'), { workerData: { dbPath: this.dbPath, policy } });
    this.worker.on('message', message => {
      if (message.error) { this.maintenanceError = message.error; console.error('[Storage] Background maintenance failed:', message.error); }
      if (message.changed) { this.maintenanceError = ''; this.bumpVersion(); clearTaskClustersCache(); }
    });
    this.worker.on('error', error => { this.maintenanceError = error.message; console.error('[Storage] Worker thread error:', error.message); });
    this.worker.on('exit', () => { this.worker = undefined; });
    this.worker.unref();
  }

  /** Explicit bounded field migration entry for isolated tests. Production compression runs in the worker. */
  public migrateContentBatch(limit = 1): number {
    let count = 0;
    backfillUsageBatch(this.db);
    while (count < Math.min(100, Math.max(1, limit)) && this.content().migrateOne()) count++;
    if (count) this.bumpVersion();
    return count;
  }


  public getDataVersion(): number {
    return this.dataVersion;
  }

  private bumpVersion(): void {
    this.dataVersion++;
  }

  /**
   * `migrate: false` opens a secondary connection (e.g. the attribution worker) to a database whose
   * schema the host connection already owns: no migration or data repair, so opening never competes
   * for the write lock. A schema version other than the current one is rejected explicitly.
   */
  constructor(dbPath?: string, options: { backgroundAttribution?: boolean; migrate?: boolean } = {}) {
    this.backgroundAttribution = options.backgroundAttribution === true;
    this.ownsSchema = options.migrate !== false;
    const defaultUserDb = path.join(os.homedir(), '.prompt-lens', 'lens.db');

    let finalPath: string;
    if (dbPath) {
      finalPath = dbPath;
    } else if (process.env.PROMPT_LENS_DB) {
      finalPath = process.env.PROMPT_LENS_DB;
    } else if (process.env.LLM_LENS_DB) {
      finalPath = process.env.LLM_LENS_DB;
    } else {
      finalPath = defaultUserDb;
    }
    this.dbPath = finalPath;

    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}

    this.db = new Database(finalPath);
    this.db.function('agent_category', { deterministic: true }, getAgentCategory);
    this.db.function('is_model_request', { deterministic: true }, (urlPath: any) => isWebFetchRequest(String(urlPath || '')) ? 0 : 1);
    this.db.pragma('busy_timeout = 5000');
    try {
      if (!this.ownsSchema) {
        const version = Number(this.db.pragma('user_version', { simple: true }) || 0);
        if (version !== SCHEMA_VERSION) throw new Error(`Database schema ${version} does not match ${SCHEMA_VERSION}; the host must migrate first`);
      } else {
        if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get()) this.db.pragma('auto_vacuum = INCREMENTAL');
        this.db.pragma('journal_mode = WAL');
        try {
          if (fs.existsSync(finalPath)) {
            fs.chmodSync(finalPath, 0o600);
          }
        } catch {}
        this.initDb();
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private initDb(): void {
    const migrateTx = this.db.transaction(() => {
      let currentVersion = Number(this.db.pragma('user_version', { simple: true }) || 0);
      // Version 0 -> 1: Create base records table
      if (currentVersion < 1) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT DEFAULT '',
            agent_name TEXT DEFAULT 'Agent',
            provider TEXT DEFAULT 'unknown',
            model TEXT DEFAULT 'unknown',
            method TEXT DEFAULT 'POST',
            url_path TEXT DEFAULT '',
            status_code INTEGER DEFAULT 200,
            duration_ms INTEGER DEFAULT 0,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cached_tokens INTEGER DEFAULT 0,
            thinking_tokens INTEGER DEFAULT 0,
            total_tokens INTEGER DEFAULT 0,
            cache_ratio REAL DEFAULT 0.0,
            system_prompt TEXT DEFAULT '',
            prompt_summary TEXT DEFAULT '',
            user_prompt TEXT DEFAULT '',
            response_preview TEXT DEFAULT '',
            request_headers TEXT DEFAULT '{}',
            request_body TEXT DEFAULT '',
            response_body TEXT DEFAULT '',
            raw_usage TEXT DEFAULT '{}',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `);
        const cols = (this.db.pragma('table_info(records)') as any[]).map((c) => c.name);
        const v1Cols: [string, string][] = [
          ['session_id', "TEXT DEFAULT ''"],
          ['agent_name', "TEXT DEFAULT 'Agent'"],
          ['provider', "TEXT DEFAULT 'unknown'"],
          ['model', "TEXT DEFAULT 'unknown'"],
          ['method', "TEXT DEFAULT 'POST'"],
          ['url_path', "TEXT DEFAULT ''"],
          ['status_code', 'INTEGER DEFAULT 200'],
          ['duration_ms', 'INTEGER DEFAULT 0'],
          ['input_tokens', 'INTEGER DEFAULT 0'],
          ['output_tokens', 'INTEGER DEFAULT 0'],
          ['cached_tokens', 'INTEGER DEFAULT 0'],
          ['thinking_tokens', 'INTEGER DEFAULT 0'],
          ['total_tokens', 'INTEGER DEFAULT 0'],
          ['cache_ratio', 'REAL DEFAULT 0.0'],
          ['system_prompt', "TEXT DEFAULT ''"],
          ['prompt_summary', "TEXT DEFAULT ''"],
          ['user_prompt', "TEXT DEFAULT ''"],
          ['response_preview', "TEXT DEFAULT ''"],
          ['request_headers', "TEXT DEFAULT '{}'"],
          ['request_body', "TEXT DEFAULT ''"],
          ['response_body', "TEXT DEFAULT ''"],
          ['raw_usage', "TEXT DEFAULT '{}'"]
        ];
        for (const [name, def] of v1Cols) {
          if (!cols.includes(name)) {
            this.db.exec(`ALTER TABLE records ADD COLUMN ${name} ${def};`);
          }
        }
        currentVersion = 1;
        this.db.pragma('user_version = 1');
      }

      // Version 1 -> 2: Add reliability and tracing columns
      if (currentVersion < 2) {
        const cols = (this.db.pragma('table_info(records)') as any[]).map((c) => c.name);
        const v2Cols: [string, string][] = [
          ['schema_version', "TEXT DEFAULT '2.0.0'"],
          ['event_id', 'TEXT'],
          ['request_id', 'TEXT'],
          ['sequence', 'INTEGER DEFAULT 1'],
          ['core_instance_id', "TEXT DEFAULT ''"],
          ['capture_status', "TEXT DEFAULT 'complete'"],
          ['bytes_wire', 'INTEGER DEFAULT 0'],
          ['bytes_captured', 'INTEGER DEFAULT 0'],
          ['truncated_reason', "TEXT DEFAULT ''"]
        ];
        for (const [name, def] of v2Cols) {
          if (!cols.includes(name)) {
            this.db.exec(`ALTER TABLE records ADD COLUMN ${name} ${def};`);
          }
        }
        currentVersion = 2;
        this.db.pragma('user_version = 2');
      }

      // Version 2 -> 3: Add token source, finish reason, tool calls json and indexes
      if (currentVersion < 3) {
        const cols = (this.db.pragma('table_info(records)') as any[]).map((c) => c.name);
        const v3Cols: [string, string][] = [
          ['token_source', "TEXT DEFAULT 'reported'"],
          ['finish_reason', "TEXT DEFAULT ''"],
          ['tool_calls_json', "TEXT DEFAULT '[]'"]
        ];
        for (const [name, def] of v3Cols) {
          if (!cols.includes(name)) {
            this.db.exec(`ALTER TABLE records ADD COLUMN ${name} ${def};`);
          }
        }

        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_records_session ON records(session_id);
          CREATE INDEX IF NOT EXISTS idx_records_created ON records(created_at);
          CREATE INDEX IF NOT EXISTS idx_records_agent ON records(agent_name);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_records_event_id ON records(event_id) WHERE event_id IS NOT NULL AND event_id != '';
        `);
        currentVersion = 3;
        this.db.pragma('user_version = 3');
      }

      // Version 3 -> 4: Add complete response_text, thinking_text, is_subagent, subagent_type
      if (currentVersion < 4) {
        const cols = (this.db.pragma('table_info(records)') as any[]).map((c) => c.name);
        const v4Cols: [string, string][] = [
          ['response_text', "TEXT DEFAULT ''"],
          ['thinking_text', "TEXT DEFAULT ''"],
          ['is_subagent', 'INTEGER DEFAULT 0'],
          ['subagent_type', "TEXT DEFAULT ''"]
        ];
        for (const [name, def] of v4Cols) {
          if (!cols.includes(name)) {
            this.db.exec(`ALTER TABLE records ADD COLUMN ${name} ${def};`);
          }
        }
        currentVersion = 4;
        this.db.pragma('user_version = 4');
      }

      // Version 4 -> 5: reserve the schema version; the single historical
      // reclassification pass below owns all data refresh work.
      if (currentVersion < 5) {
        currentVersion = 5;
        this.db.pragma('user_version = 5');
      }

      // Version 5 -> 6: structured session identity and request lineage.
      if (currentVersion < 6) {
        const cols = (this.db.pragma('table_info(records)') as any[]).map((c) => c.name);
        const v6Cols: [string, string][] = [
          ['session_id_source', "TEXT DEFAULT 'legacy'"],
          ['session_confidence', "TEXT DEFAULT 'unknown'"],
          ['session_namespace', "TEXT DEFAULT ''"],
          ['thread_id', "TEXT DEFAULT ''"],
          ['turn_id', "TEXT DEFAULT ''"],
          ['parent_request_id', "TEXT DEFAULT ''"],
          ['parent_event_id', "TEXT DEFAULT ''"]
        ];
        for (const [name, def] of v6Cols) if (!cols.includes(name)) this.db.exec(`ALTER TABLE records ADD COLUMN ${name} ${def};`);
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_records_thread ON records(thread_id);
          CREATE INDEX IF NOT EXISTS idx_records_request ON records(request_id);
          CREATE INDEX IF NOT EXISTS idx_records_parent_request ON records(parent_request_id);
          CREATE INDEX IF NOT EXISTS idx_records_parent_event ON records(parent_event_id);
          CREATE INDEX IF NOT EXISTS idx_records_session_identity ON records(session_id, session_id_source, session_confidence);
        `);
        currentVersion = 6;
        this.db.pragma('user_version = 6');
      }

      // Version 6 -> 7: persist explicit event lineage for subagent topology.
      if (currentVersion < 7) {
        const cols = (this.db.pragma('table_info(records)') as any[]).map((c) => c.name);
        if (!cols.includes('parent_event_id')) {
          this.db.exec("ALTER TABLE records ADD COLUMN parent_event_id TEXT DEFAULT '';");
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_records_parent_event ON records(parent_event_id);');
        currentVersion = 7;
        this.db.pragma('user_version = 7');
      }

      // One current-rule refresh replaces the old classification passes.
      if (currentVersion < 9) {
        this.rebuildRecordIdentities();
        currentVersion = 9;
        this.db.pragma('user_version = 9');
      }
      if (currentVersion < 10) {
        // Schema upgrades correct usage metadata without rewriting saved content.
        // Reinterpreting historical replies remains an explicit repair operation.
        this.repairAntigravityRecords({ preserveStoredContent: true });
        currentVersion = 10;
        this.db.pragma('user_version = 10');
      }
      if (currentVersion < 11) {
        if (!(this.db.pragma('table_info(records)') as any[]).some(c => c.name === 'content_expired')) this.db.exec('ALTER TABLE records ADD COLUMN content_expired INTEGER NOT NULL DEFAULT 0');
        ContentStore.createSchema(this.db);
        createUsageLedger(this.db);
        this.db.pragma('user_version = 11');
      }

      if (currentVersion < 12) {
        const columns = (this.db.pragma('table_info(records)') as any[]).map(c => c.name);
        for (const name of ['transport', 'address', 'body_format', 'body_encoding', 'connection_id', 'stream_id', 'response_id', 'previous_response_id', 'attribution', 'response_headers']) {
          if (!columns.includes(name)) this.db.exec(`ALTER TABLE records ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_records_response_relation ON records(agent_name, session_namespace, session_id, response_id)');
        this.db.pragma('user_version = 12');
        currentVersion = 12;
      }

      if (currentVersion < 14) {
        AttributionRepository.createSchema(this.db);
        this.db.pragma('user_version = 14');
        currentVersion = 14;
      }
      if (currentVersion < 15) {
        AttributionRepository.installCaptureInvalidation(this.db);
        this.db.pragma('user_version = 15');
      }
      if (currentVersion < 16) {
        AttributionRepository.installConnectionInvalidation(this.db);
        this.db.pragma('user_version = 16');
      }
      if (currentVersion < 18) AttributionRepository.installProjectionCache(this.db);
      if (currentVersion < 17) {
        AttributionRepository.installSearchInvalidation(this.db);
        this.db.pragma('user_version = 17');
      }
      if (currentVersion < 18) this.db.pragma('user_version = 18');
      if (currentVersion < 19) {
        AttributionRepository.installPiInvalidation(this.db);
        this.db.pragma('user_version = 19');
      }

    });

    // Take the write reservation before reading: a deferred WAL transaction
    // cannot upgrade a snapshot after another capture writer has committed.
    migrateTx.immediate();
    // Obsolete adapter indexes cannot serve history links before their current projection.
    this.db.transaction(() => {
      for (const adapter of identityAdapters) {
        const category = adapter.identityIndex!.category;
        const pending = `agent_category(agent_name) = ? AND content_expired = 0 AND NOT EXISTS
          (SELECT 1 FROM request_attributions a WHERE a.record_id=records.id AND a.adapter_id=? AND a.rule_version=?)`;
        this.db.prepare(`UPDATE records SET session_id='unknown:record:' || id, thread_id='', turn_id='',
          session_namespace='', session_confidence='unknown', session_id_source='unknown' WHERE ${pending}`)
          .run(category, adapter.id, adapter.version);
        this.db.prepare(`INSERT OR IGNORE INTO attribution_jobs(record_id) SELECT id FROM records WHERE ${pending}`)
          .run(category, adapter.id, adapter.version);
      }
      new AttributionRepository(this.db).clearExpiredIdentityIndexes();
    }).immediate();

    // Safe one-time backfill of response_text / thinking_text for historical records where response_text is empty
    try {
      const emptyRecs = this.db.prepare(`
        SELECT id FROM records WHERE (response_text IS NULL OR response_text = '')
          AND response_body IS NOT NULL AND response_body != '' AND content_expired = 0
          AND NOT EXISTS (SELECT 1 FROM content_fields f WHERE f.record_id = records.id AND f.field = 'response_text')
        LIMIT 1000
      `).all() as { id: number }[];
      if (emptyRecs && emptyRecs.length > 0) {
        const select = this.db.prepare('SELECT id, provider, url_path, body_format, response_body, thinking_text FROM records WHERE id = ?');
        const updateStmt = this.db.prepare("UPDATE records SET response_text = ?, thinking_text = ? WHERE id = ?");
        const updateReply = this.db.prepare('UPDATE records SET response_text = ? WHERE id = ?');
        for (const { id } of emptyRecs) {
          try {
            const r = select.get(id) as any;
            const rawResText = this.readField(r, 'response_body');
            const info = extractResponseInfo(r.provider || 'unknown', rawResText, r.url_path, r.body_format);
            if (info.responseText || info.thinkingText) {
              // A migrated thinking field has an empty legacy column but still owns content.
              if (this.readField(r, 'thinking_text')) updateReply.run(info.responseText, r.id);
              else updateStmt.run(info.responseText, info.thinkingText || '', r.id);
            }
          } catch {}
        }
      }
    } catch {}

  }

  /** Reparse saved Antigravity responses without changing raw captures or record IDs. */
  public repairAntigravityRecords(options: { preserveStoredContent?: boolean } = {}): { processed: number; skipped: number } {
    const result = this.db.transaction(() => {
      const select = this.db.prepare(`
        SELECT id, provider, url_path, model, prompt_summary, user_prompt, request_body, response_body
        FROM records WHERE id > ? AND (is_model_request(url_path) = 0 OR
          (provider = 'gemini' AND LOWER(url_path) LIKE '%generatecontent%'))
        ORDER BY id LIMIT 100
      `);
      const update = this.db.prepare(`
        UPDATE records SET model = @model, prompt_summary = @prompt_summary, user_prompt = @user_prompt,
          input_tokens = @input_tokens, output_tokens = @output_tokens, cached_tokens = @cached_tokens,
          thinking_tokens = @thinking_tokens, total_tokens = @total_tokens, cache_ratio = @cache_ratio,
          token_source = @token_source, raw_usage = @raw_usage
          ${options.preserveStoredContent ? '' : ', response_text = @response_text, thinking_text = @thinking_text, response_preview = @response_preview'},
          finish_reason = @finish_reason, tool_calls_json = @tool_calls_json WHERE id = @id
      `);
      let cursor = 0, processed = 0, skipped = 0;
      while (true) {
        const rows = select.all(cursor) as any[];
        if (!rows.length) break;
        for (const row of rows) {
          cursor = row.id;
          const raw = this.readField(row, 'response_body');
          const info = extractResponseInfo(row.provider || 'unknown', raw, row.url_path);
          const webFetch = isWebFetchRequest(row.url_path);
          // Incomplete or pruned model captures cannot replace existing reported usage.
          if (!webFetch && info.usage.token_source !== 'reported') { skipped++; continue; }
          let promptSummary = row.prompt_summary;
          if (webFetch) {
            let req: any = {};
            const request = this.readField(row, 'request_body');
            try { req = JSON.parse(request); } catch {}
            promptSummary = `网页抓取（${req.liveFetch ? '实时' : '缓存'}） | ${req.url || ''}`;
          }
          const preview = info.responseText || (info.toolCalls.length
            ? `[Tool Call] ${info.toolCalls.map((t: any) => t.name || 'tool').slice(0, 3).join(', ')}` : '');
          if (!options.preserveStoredContent && this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'content_refs'").get()) {
            this.db.prepare("DELETE FROM content_refs WHERE record_id = ? AND field IN ('response_text', 'thinking_text')").run(row.id);
            this.db.prepare("DELETE FROM content_fields WHERE record_id = ? AND field IN ('response_text', 'thinking_text')").run(row.id);
          }
          update.run({ id: row.id, model: webFetch ? 'web-fetch' : row.model,
            prompt_summary: promptSummary, user_prompt: webFetch ? '' : row.user_prompt,
            ...info.usage, raw_usage: JSON.stringify(info.usage.raw_details),
            response_text: info.responseText, thinking_text: info.thinkingText || '',
            response_preview: preview.slice(0, 200).replace(/\n/g, ' '),
            finish_reason: info.finishReason, tool_calls_json: JSON.stringify(info.toolCalls) });
          processed++;
        }
      }
      return { processed, skipped };
    }).immediate();
    if (result.processed) { this.bumpVersion(); clearTaskClustersCache(); }
    return result;
  }

  /** Explicit maintenance operation; raw records and token counts are retained. */
  public rebuildRecordIdentities(): { processed: number; unreadableBodies: number } {
    const started = Date.now();
    const result = this.db.transaction(() => {
      const select = this.db.prepare(`
        SELECT *
        FROM records WHERE id > ? ORDER BY id LIMIT 100
      `);
      const update = this.db.prepare(`
        UPDATE records SET agent_name = ?, session_id = ?, session_id_source = ?,
          session_confidence = ?, session_namespace = ?, thread_id = ?, turn_id = ?,
          parent_request_id = ?, parent_event_id = ? WHERE id = ?
      `);
      let cursor = 0;
      let processed = 0;
      let unreadableBodies = 0;
      const expiredColumn = (this.db.pragma('table_info(records)') as any[]).some(c => c.name === 'content_expired');
      while (true) {
        const rows = select.all(cursor) as any[];
        if (!rows.length) break;
        for (const row of rows) {
          if (expiredColumn && (this.db.prepare('SELECT content_expired FROM records WHERE id = ?').get(row.id) as any)?.content_expired) { cursor = row.id; continue; }
          let headers: Record<string, string> = {};
          try { headers = JSON.parse(row.request_headers || '{}') || {}; } catch {}
          let body: any;
          const raw = this.readField(row, 'request_body');
          if (raw) {
            try {
              body = JSON.parse(raw);
            } catch { unreadableBodies++; }
          }
          const agentName = detectAgent(headers, row.url_path || '', body);
          const identity = resolveSessionIdentity(row.attribution === 'connection' ? {} : headers, row.attribution === 'connection' ? {} : body, row.provider, row.model, {
            request_id: row.request_id, event_id: row.event_id,
            agent_name: agentName, url_path: row.url_path, transport: row.transport, schemaVersion: row.schema_version,
            attribution: row.attribution, method: row.method, statusCode: row.status_code
          });
          const parents = resolveRequestParents(row.attribution === 'connection' ? {} : headers, row.attribution === 'connection' ? {} : body, row);
          // Missing/pruned payloads cannot justify retaining an obsolete inferred
          // identity. Isolate them under a stable record/request identity instead.
          update.run(agentName, identity.id === 'unknown' ? `unknown:record:${row.id}` : identity.id,
            identity.source, identity.confidence, identity.namespace || '',
            identity.thread_id || '', identity.turn_id || '',
            parents.parent_request_id || '', parents.parent_event_id || '', row.id);
          if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='request_attributions'").get()) this.projectImmediateAttribution(row.id, agentName);
          cursor = row.id;
          processed++;
        }
      }
      return { processed, unreadableBodies };
    }).immediate();
    // A database/recognition error aborts the whole transaction; never mark a
    // partial refresh complete. Invalid capture JSON is counted as missing evidence.
    if (result.processed > 0) {
      this.bumpVersion();
      clearTaskClustersCache();
    }
    console.info(`[StorageEngine] Identity recalculated: ${result.processed} processed, ${result.unreadableBodies} unreadable, ${Date.now() - started}ms`);
    return result;
  }

  public insertRecord(record: Omit<AuditRecord, 'id' | 'created_at'>): number {
    if (!this.db || !this.db.open) return -1;

    const id = this.db.transaction(() => this.insertRecordTransaction(record)).immediate();
    this.evidenceCollector?.wake();
    return id;
  }

  private insertRecordTransaction(record: Omit<AuditRecord, 'id' | 'created_at'>): number {
    // Idempotency: duplicate event_id returns existing record id without re-inserting
    if (record.event_id) {
      const existing = this.db.prepare('SELECT id FROM records WHERE event_id = ?').get(record.event_id) as any;
      if (existing) return Number(existing.id);
      const tombstone = this.db.prepare('SELECT id FROM usage_ledger WHERE event_key = ?').get('event:' + record.event_id) as any;
      if (tombstone) return Number(tombstone.id);
    }

    const stmt = this.db.prepare(`
      INSERT INTO records (
        id, schema_version, event_id, request_id, sequence, core_instance_id, capture_status,
        bytes_wire, bytes_captured, truncated_reason,
        transport, address, body_format, body_encoding, connection_id, stream_id, response_id, previous_response_id, attribution, response_headers,
        session_id, session_id_source, session_confidence, session_namespace, thread_id, turn_id, parent_request_id, parent_event_id,
        agent_name, provider, model, method, url_path, status_code, duration_ms,
        input_tokens, output_tokens, cached_tokens, thinking_tokens, total_tokens, cache_ratio,
        system_prompt, prompt_summary, user_prompt, response_preview,
        response_text, thinking_text, is_subagent, subagent_type,
        request_headers, request_body, response_body, raw_usage,
        token_source, finish_reason, tool_calls_json
      ) VALUES (
        @id, @schema_version, @event_id, @request_id, @sequence, @core_instance_id, @capture_status,
        @bytes_wire, @bytes_captured, @truncated_reason,
        @transport, @address, @body_format, @body_encoding, @connection_id, @stream_id, @response_id, @previous_response_id, @attribution, @response_headers,
        @session_id, @session_id_source, @session_confidence, @session_namespace, @thread_id, @turn_id, @parent_request_id, @parent_event_id,
        @agent_name, @provider, @model, @method, @url_path, @status_code, @duration_ms,
        @input_tokens, @output_tokens, @cached_tokens, @thinking_tokens, @total_tokens, @cache_ratio,
        @system_prompt, @prompt_summary, @user_prompt, @response_preview,
        @response_text, @thinking_text, @is_subagent, @subagent_type,
        @request_headers, @request_body, @response_body, @raw_usage,
        @token_source, @finish_reason, @tool_calls_json
      )
    `);

    // Legacy tables may lack AUTOINCREMENT. Never reuse an ID held by the permanent ledger.
    const maxRecordId = Number((this.db.prepare('SELECT COALESCE(MAX(id), 0) id FROM records').get() as any).id);
    const maxUsageId = Number((this.db.prepare('SELECT COALESCE(MAX(id), 0) id FROM usage_ledger').get() as any).id);
    const hasSequence = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get();
    const sequence = hasSequence ? Number((this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'records'").get() as any)?.seq || 0) : 0;
    const info = stmt.run({
      id: Math.max(maxRecordId, maxUsageId, sequence) + 1,
      schema_version: record.schema_version || '2.0.0',
      event_id: record.event_id || null,
      request_id: record.request_id || null,
      sequence: record.sequence || 1,
      core_instance_id: record.core_instance_id || '',
      capture_status: record.capture_status || 'complete',
      bytes_wire: record.bytes_wire || 0,
      bytes_captured: record.bytes_captured || 0,
      truncated_reason: record.truncated_reason || '',
      ...Object.fromEntries(['transport', 'address', 'body_format', 'body_encoding', 'connection_id', 'stream_id', 'response_id', 'previous_response_id', 'attribution'].map(name => [name, (record as any)[name] || ''])),
      response_headers: JSON.stringify(record.response_headers || {}),
      session_id: record.session_id || '',
      session_id_source: record.session_id_source || 'legacy',
      session_confidence: record.session_confidence || 'unknown',
      session_namespace: record.session_namespace || '',
      thread_id: record.thread_id || '',
      turn_id: record.turn_id || '',
      parent_request_id: record.parent_request_id || '',
      parent_event_id: record.parent_event_id || '',
      agent_name: record.agent_name || 'Agent',
      provider: record.provider || 'unknown',
      model: record.model || 'unknown',
      method: record.method || 'POST',
      url_path: record.url_path || '',
      status_code: record.status_code || 200,
      duration_ms: record.duration_ms || 0,
      input_tokens: record.input_tokens || 0,
      output_tokens: record.output_tokens || 0,
      cached_tokens: record.cached_tokens || 0,
      thinking_tokens: record.thinking_tokens || 0,
      total_tokens: record.total_tokens || 0,
      cache_ratio: record.cache_ratio || 0.0,
      system_prompt: record.system_prompt || '',
      prompt_summary: record.prompt_summary || '',
      user_prompt: record.user_prompt || '',
      response_preview: record.response_preview || '',
      response_text: record.response_text || '',
      thinking_text: record.thinking_text || '',
      is_subagent: record.is_subagent || 0,
      subagent_type: record.subagent_type || '',
      request_headers: JSON.stringify(record.request_headers || {}),
      request_body: stageBody(record.request_body),
      response_body: stageBody(record.response_body),
      raw_usage: JSON.stringify(record.raw_usage || {}),
      token_source: record.token_source || 'reported',
      finish_reason: record.finish_reason || '',
      tool_calls_json: record.tool_calls_json || '[]'
    });

    // Keep the event tombstone for delivery idempotency, without treating an
    // unattributed connection diagnostic as another model invocation.
    if (record.attribution === 'connection') {
      this.db.prepare('UPDATE usage_ledger SET counted = 0 WHERE id = ?').run(Number(info.lastInsertRowid));
    }
    this.projectImmediateAttribution(Number(info.lastInsertRowid), record.agent_name || '');
    this.bumpVersion();
    this.worker?.postMessage({ activity: Date.now() });
    return Number(info.lastInsertRowid);
  }


  public getRecords(options: {
    limit?: number;
    offset?: number;
    sessionId?: string;
    search?: string;
    filterType?: string;
    agentName?: string;
    lightweight?: boolean;
    ids?: number[];
    sinceId?: number;
    order?: 'ASC' | 'DESC';
  } = {}): AuditRecord[] {
    if (!this.db || !this.db.open) return [];
    const limit = typeof options.limit === 'number'
      ? (options.limit <= 0 ? -1 : options.limit)
      : 50;
    const offset = Math.max(0, options.offset || 0);

    const whereClauses: string[] = [];
    const params: any = { limit, offset };

    if (typeof options.sinceId === 'number' && options.sinceId > 0) {
      whereClauses.push('id > @sinceId');
      params.sinceId = options.sinceId;
    }

    if (options.sessionId) {
      whereClauses.push('session_id = @sessionId');
      params.sessionId = options.sessionId;
    }

    if (options.agentName && options.agentName !== 'all') {
      whereClauses.push('agent_name = @agentName');
      params.agentName = options.agentName;
    }

    if (options.search && options.search.trim()) {
      whereClauses.push(
        '(model LIKE @kw OR prompt_summary LIKE @kw OR user_prompt LIKE @kw OR response_preview LIKE @kw OR url_path LIKE @kw)'
      );
      params.kw = `%${options.search.trim()}%`;
    }

    if (options.filterType) {
      if (options.filterType === 'slow') whereClauses.push('duration_ms >= 3000');
      else if (options.filterType === 'high_cache') whereClauses.push('cache_ratio >= 50.0');
      else if (options.filterType === 'cache_miss') whereClauses.push('(cached_tokens = 0 OR cached_tokens IS NULL)');
      else if (options.filterType === 'heavy_context') whereClauses.push('input_tokens >= 50000');
    }

    if (options.ids) {
      if (!options.ids.length) return [];
      whereClauses.push('id IN (' + options.ids.map((id, index) => {
        params['recordId' + index] = id;
        return '@recordId' + index;
      }).join(',') + ')');
    }

    const selectColumns = options.lightweight
      ? `id, session_id, session_id_source, session_confidence, session_namespace, thread_id, turn_id, parent_request_id, parent_event_id, request_id, event_id, sequence, transport, address, body_format, body_encoding, connection_id, stream_id, response_id, previous_response_id, attribution, capture_status, truncated_reason, agent_name, provider, model, method, url_path, status_code,
         duration_ms, input_tokens, output_tokens, cached_tokens, thinking_tokens, total_tokens,
         cache_ratio, prompt_summary, user_prompt, response_preview,
         is_subagent, subagent_type, token_source, finish_reason, tool_calls_json, content_expired, created_at`
      : `id, session_id, session_id_source, session_confidence, session_namespace, thread_id, turn_id, parent_request_id, parent_event_id, request_id, event_id, sequence, transport, address, body_format, body_encoding, connection_id, stream_id, response_id, previous_response_id, attribution, capture_status, truncated_reason, agent_name, provider, model, method, url_path, status_code,
         duration_ms, input_tokens, output_tokens, cached_tokens, thinking_tokens, total_tokens,
         cache_ratio, prompt_summary, user_prompt, response_preview, response_text, thinking_text,
         is_subagent, subagent_type, token_source, finish_reason, content_expired, created_at`;

    let sql = `
      SELECT ${selectColumns}
      FROM records
    `;

    if (whereClauses.length) {
      sql += ' WHERE ' + whereClauses.join(' AND ');
    }

    const orderDirection = options.order === 'ASC' ? 'ASC' : 'DESC';
    sql += ` ORDER BY id ${orderDirection} LIMIT @limit OFFSET @offset`;

    const rows = this.db.prepare(sql).all(params);
    if (!options.lightweight) for (const row of rows as any[]) {
      row.response_text = this.readField(row, 'response_text');
      row.thinking_text = this.readField(row, 'thinking_text');
    }
    for (const row of rows as any[]) { row.raw_loaded = false; row.raw_pruned = Boolean(row.content_expired); }
    return this.attachProtocols(rows as AuditRecord[]);
  }

  /** Read an explicit response chain in one snapshot, without scanning/decompressing the library. */
  public getRelatedHistory(id: number): RelatedHistory {
    return this.db.transaction(() => {
      const result: RelatedHistory = { records: [], status: 'none', messageCount: 0 };
      const current = this.db.prepare('SELECT * FROM records WHERE id = ?').get(id) as any;
      if (!current) { result.status = 'missing'; return result; }
      if (!current.previous_response_id) return result;
      if (current.session_confidence !== 'exact') { result.status = 'untrusted'; return result; }
      const seen = new Set<string>(current.response_id ? [current.response_id] : []);
      let parent = current.previous_response_id;
      let remaining = 1024 * 1024;
      const readBounded = (row: any, field: string): string => {
        const manifest = this.db.prepare('SELECT raw_length FROM content_fields WHERE record_id = ? AND field = ?').get(row.id, field) as any;
        if (manifest && manifest.raw_length > remaining) throw new RangeError('history budget');
        const legacy = row[field];
        const text = manifest ? this.readField(row, field) : Buffer.isBuffer(legacy)
          ? zlib.inflateRawSync(legacy, { maxOutputLength: Math.max(1, remaining) }).toString('utf8') : String(legacy || '');
        const bytes = Buffer.byteLength(text);
        if (bytes > remaining) throw new RangeError('history budget');
        remaining -= bytes;
        return text;
      };
      while (parent) {
        if (seen.has(parent)) { result.status = 'cycle'; break; }
        if (result.records.length >= 32) { result.status = 'budget'; break; }
        seen.add(parent);
        const rows = this.db.prepare(`SELECT * FROM records WHERE response_id = ? AND agent_name = ?
          AND session_id = ? AND session_namespace = ? AND session_confidence = 'exact' LIMIT 2`)
          .all(parent, current.agent_name, current.session_id, current.session_namespace) as any[];
        if (!rows.length) { result.status = 'missing'; break; }
        if (rows.length > 1) { result.status = 'ambiguous'; break; }
        const row = rows[0];
        if (row.content_expired) { result.status = 'expired'; break; }
        try {
          const request = readBounded(row, 'request_body');
          if (!request) { result.status = 'expired'; break; }
          const data = JSON.parse(request); const body = data.request || data;
          const input = body.input ?? body.messages ?? body.contents ?? [];
          const items = typeof input === 'string' ? [{ role: 'user', content: input }] : Array.isArray(input) ? input : [];
          const messages = items.map((item: any) => ({ role: item.role || item.type || 'user', text:
            typeof item.content === 'string' ? item.content : typeof item.output === 'string' ? item.output :
            Array.isArray(item.content || item.parts) ? (item.content || item.parts).map((part: any) => part.text || JSON.stringify(part)).join('\n') : JSON.stringify(item) }));
          const response = readBounded(row, 'response_text');
          const thinking = readBounded(row, 'thinking_text');
          if (thinking) messages.push({ role: 'reasoning', text: thinking });
          if (row.tool_calls_json && row.tool_calls_json !== '[]') {
            remaining -= Buffer.byteLength(row.tool_calls_json);
            if (remaining < 0) throw new RangeError('history budget');
            messages.push({ role: 'tool_call', text: row.tool_calls_json });
          }
          if (response) messages.push({ role: 'assistant', text: response });
          result.records.unshift({ record_id: row.id, response_id: row.response_id, messages });
          result.messageCount += messages.length;
          result.status = 'complete';
          parent = row.previous_response_id;
        } catch (error) {
          result.status = error instanceof RangeError || (error as any)?.code === 'ERR_BUFFER_TOO_LARGE' ? 'budget' : 'error'; break;
        }
      }
      return result;
    })();
  }

  public getRecordById(id: number): AuditRecord | null {
    if (!this.db || !this.db.open) return null;
    return this.db.transaction(() => this.readRecordById(id))();
  }

  private readRecordById(id: number): AuditRecord | null {
    const row = this.db.prepare('SELECT * FROM records WHERE id = ?').get(id);
    if (!row) return null;
    const record = row as any;
    for (const field of CONTENT_FIELDS) record[field] = this.readField(record, field);
    record.raw_loaded = true;
    record.raw_pruned = Boolean(record.content_expired ||
      record.request_body === '' &&
      record.response_body === '' &&
      (record.prompt_summary || record.user_prompt || record.input_tokens > 0 || record.output_tokens > 0)
    );
    try {
      record.request_headers = JSON.parse(record.request_headers || '{}');
      record.response_headers = JSON.parse(record.response_headers || '{}');
    } catch {
      record.request_headers = {};
    }
    try {
      record.raw_usage = JSON.parse(record.raw_usage || '{}');
    } catch {
      record.raw_usage = {};
    }
    return this.attachProtocols([legacyChatDetail(record as AuditRecord, record.request_body)])[0];
  }

  /**
   * 批量拉取指定 ID 列表的记录
   * 默认 includeRawBody = false，不拉取庞大的 raw body，极大节省 IPC 与内存开销
   */
  public getRecordsByIds(ids: number[], options: { includeRawBody?: boolean; lightweight?: boolean } = {}): AuditRecord[] {
    if (!this.db || !this.db.open || !ids || !ids.length) return [];
    return this.db.transaction(() => this.readRecordsByIds(ids, options))();
  }

  public attachTimelineDetail(record: AuditRecord): AuditRecord {
    const rawReq = record.request_body || (record.id && !record.content_expired ? this.getRequestBody(record.id) : '');
    if (!record.response_text && !record.thinking_text && record.id && !record.content_expired) {
      const row = this.db.prepare('SELECT response_text, thinking_text FROM records WHERE id = ?').get(record.id) as any;
      if (row) {
        record.response_text = this.readField({ id: record.id, response_text: row.response_text }, 'response_text');
        record.thinking_text = this.readField({ id: record.id, thinking_text: row.thinking_text }, 'thinking_text');
      }
    }
    // Lightweight rows omit stored system_prompt. For this narrow legacy case, load it
    // with a bound before projecting so a saved value always wins over derived evidence.
    if (record.system_prompt === undefined && record.id && record.provider === 'unknown' &&
        record.capture_status === 'complete' && /^\/v2\/chat\/completions(?:\?.*)?$/i.test(record.url_path || '')) {
      const limit = 8 * 1024 * 1024;
      const saved = this.db.prepare(`SELECT LENGTH(CAST(system_prompt AS BLOB)) bytes,
        CASE WHEN LENGTH(CAST(system_prompt AS BLOB)) <= ? THEN system_prompt ELSE NULL END value,
        (SELECT raw_length FROM content_fields WHERE record_id = ? AND field = 'system_prompt') raw_length
        FROM records WHERE id = ?`).get(limit, record.id, record.id) as {bytes: number | null; value: unknown; raw_length: number | null} | undefined;
      if (saved && ((saved.bytes || 0) > limit || (saved.raw_length || 0) > limit)) throw new Error('Stored system prompt exceeds detail budget');
      if (saved?.raw_length != null) record.system_prompt = this.readField({ id: record.id, system_prompt: saved.value }, 'system_prompt');
      else if (Buffer.isBuffer(saved?.value)) record.system_prompt = zlib.inflateRawSync(saved.value, { maxOutputLength: limit }).toString('utf8');
      else if (typeof saved?.value === 'string') record.system_prompt = saved.value;
    }
    const projected = legacyChatDetail(record, rawReq);
    projected.parsed_question = parseRequestTurnPayload(rawReq);
    projected.anatomy = dissectPromptAnatomy({ ...projected, request_body: rawReq });
    return projected;
  }

  private readRecordsByIds(ids: number[], options: { includeRawBody?: boolean; lightweight?: boolean }): AuditRecord[] {
    const validIds = ids.filter((id) => typeof id === 'number' && !isNaN(id));
    if (!validIds.length) return [];

    const includeRaw = Boolean(options.includeRawBody);
    const selectCols = includeRaw
      ? '*'
      : `id, session_id, session_id_source, session_confidence, session_namespace, thread_id, turn_id, parent_request_id, parent_event_id, request_id, event_id, sequence, transport, address, body_format, body_encoding, connection_id, stream_id, response_id, previous_response_id, attribution, capture_status, truncated_reason, agent_name, provider, model, method, url_path, status_code,
         duration_ms, input_tokens, output_tokens, cached_tokens, thinking_tokens, total_tokens,
         cache_ratio, prompt_summary, user_prompt, response_preview, ${options.lightweight ? "'' AS response_text, '' AS thinking_text" : 'response_text, thinking_text'},
         is_subagent, subagent_type, token_source, finish_reason, tool_calls_json, request_headers, raw_usage, content_expired, created_at`;

    const chunkSize = 200;
    const results: AuditRecord[] = [];
    for (let i = 0; i < validIds.length; i += chunkSize) {
      const chunk = validIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(`SELECT ${selectCols} FROM records WHERE id IN (${placeholders})`).all(...chunk);
      for (const row of rows as any[]) {
        if (includeRaw) {
          for (const field of CONTENT_FIELDS) row[field] = this.readField(row, field);
          row.raw_loaded = true;
          row.raw_pruned = Boolean(row.content_expired ||
            row.request_body === '' &&
            row.response_body === '' &&
            (row.prompt_summary || row.user_prompt || row.input_tokens > 0 || row.output_tokens > 0)
          );
        } else {
          row.response_text = options.lightweight ? '' : this.readField(row, 'response_text');
          row.thinking_text = options.lightweight ? '' : this.readField(row, 'thinking_text');
          row.request_body = '';
          row.response_body = '';
          row.raw_loaded = false;
          row.raw_pruned = Boolean(row.content_expired);
        }
        try {
          row.request_headers = JSON.parse(row.request_headers || '{}');
        } catch {
          row.request_headers = {};
        }
        try {
          row.raw_usage = JSON.parse(row.raw_usage || '{}');
        } catch {
          row.raw_usage = {};
        }
        results.push(row as AuditRecord);
      }
    }
    return this.attachProtocols(results);
  }

  public pruneHistoricalPayloads(days: number): { pruned: number } {
    if (!Number.isFinite(days) || days <= 0) return { pruned: 0 };
    const pruned = this.db.transaction(() => {
      let count = 0;
      for (const id of expiredRecordIds(this.db, Math.floor(days), { contentOnly: true })) {
        count += this.db.prepare(`UPDATE records SET request_body = '', response_body = '', system_prompt = '',
          response_text = '', thinking_text = '', content_expired = 1 WHERE id = ? AND content_expired = 0`).run(id).changes;
        this.db.prepare('DELETE FROM content_refs WHERE record_id = ?').run(id);
        this.db.prepare('DELETE FROM content_fields WHERE record_id = ?').run(id);
      }
      new AttributionRepository(this.db).clearExpiredIdentityIndexes();
      this.content().collectGarbage();
      return count;
    }).immediate();
    if (pruned) this.bumpVersion();
    return { pruned };
  }

  /** Space reclamation only. Never expires content or changes usage. */
  public compactDatabase(_options: { prunePayloadsDays?: number; runVacuum?: boolean; maxBatchRows?: number } = {}) {
    const beforeBytes = this.getDbSize();
    this.content().collectGarbage();
    this.db.pragma('wal_checkpoint(PASSIVE)');
    if (Number(this.db.pragma('auto_vacuum', { simple: true })) === 2) this.db.pragma('incremental_vacuum(1024)');
    const afterBytes = this.getDbSize();
    return { beforeBytes, afterBytes, savedBytes: Math.max(0, beforeBytes - afterBytes), compressedCount: 0, prunedPayloadsCount: 0 };
  }

  /** Full VACUUM for old databases is executed in a separate worker on explicit request. */
  public async reclaimSpace(): Promise<any> {
    const beforeBytes = this.getDbSize();
    const worker = new Worker(path.join(__dirname, 'space-worker.js'), { workerData: { dbPath: this.dbPath } });
    await new Promise<void>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', code => code === 0 ? resolve() : reject(new Error('空间回收失败')));
    });
    const afterBytes = this.getDbSize();
    return { beforeBytes, afterBytes, savedBytes: Math.max(0, beforeBytes - afterBytes), compressedCount: 0, prunedPayloadsCount: 0 };
  }

  private dbInfoCache?: { time: number; data: any };

  public getDbInfo() {
    if (this.dbInfoCache && Date.now() - this.dbInfoCache.time < 5000) {
      return this.dbInfoCache.data;
    }
    const data = this.db.transaction(() => this.readDbInfo())();
    this.dbInfoCache = { time: Date.now(), data };
    return data;
  }

  private readDbInfo() {
    const one = (sql: string) => (this.db.prepare(sql).get() as any).value;
    const logicalBytes = Number(one('SELECT COALESCE(SUM(raw_length), 0) value FROM content_fields'));
    const blockStats = this.db.prepare(`
      SELECT
        COALESCE(SUM(raw_length), 0) as uniqueBytes,
        COALESCE(SUM(length(data)), 0) as storedBytes
      FROM content_blocks b
      WHERE EXISTS (SELECT 1 FROM content_refs r WHERE r.hash = b.hash)
    `).get() as { uniqueBytes: number; storedBytes: number };
    const uniqueBytes = Number(blockStats.uniqueBytes);
    const storedBytes = Number(blockStats.storedBytes);
    return { dbPath: this.dbPath, dbSize: this.getDbSize(), recordsCount: one('SELECT COUNT(*) value FROM records'),
      reclaimableBytes: Number(this.db.pragma('freelist_count', { simple: true })) * Number(this.db.pragma('page_size', { simple: true })),
      logicalBytes, uniqueBytes, storedBytes, dedupSavedBytes: logicalBytes - uniqueBytes, compressionSavedBytes: uniqueBytes - storedBytes,
      contentFrom: one('SELECT MIN(datetime(created_at)) value FROM records WHERE content_expired = 0'),
      usageCoverageStart: one("SELECT value FROM storage_metadata WHERE key = 'usage_coverage_start'"),
      maintenanceError: this.maintenanceError };
  }

  public getStats(): Record<string, any> {
    if (!this.db || !this.db.open) {
      return {
        total_requests: 0,
        total_tokens: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cached_tokens: 0,
        total_thinking_tokens: 0,
        avg_latency: 0,
        avg_cache_ratio: 0,
        agents: []
      };
    }

    const agg = this.db
      .prepare(`
      SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens,
        COALESCE(SUM(cached_tokens), 0) as total_cached_tokens,
        COALESCE(SUM(thinking_tokens), 0) as total_thinking_tokens,
        COALESCE(AVG(duration_ms), 0) as avg_latency,
        COALESCE(SUM(cached_tokens) * 100.0 / NULLIF(SUM(input_tokens), 0), 0) as avg_cache_ratio
      FROM usage_events WHERE is_model_request(url_path) = 1
    `)
      .get() as any;

    const agents = (
      this.db
        .prepare(`
      SELECT DISTINCT agent_name FROM usage_events WHERE agent_name IS NOT NULL AND agent_name != '' ORDER BY agent_name
    `)
        .all() as any[]
    ).map((r) => r.agent_name);

    return {
      total_requests: agg?.total_requests || 0,
      total_tokens: agg?.total_tokens || 0,
      total_input_tokens: agg?.total_input_tokens || 0,
      total_output_tokens: agg?.total_output_tokens || 0,
      total_cached_tokens: agg?.total_cached_tokens || 0,
      total_thinking_tokens: agg?.total_thinking_tokens || 0,
      avg_latency: Math.round(agg?.avg_latency || 0),
      avg_cache_ratio: Number((agg?.avg_cache_ratio || 0).toFixed(1)),
      agents
    };
  }

  /**
   * 获取近 365 天的每日 Token 活动热力数据与统计指标
   * 支持按 Agent 类别过滤 ('all' | 'Codex' | 'Antigravity' | 'Pi' | 'Other')
   */
  public getDailyTokenActivity(agentCategory?: string): TokenActivitySummary {
    const emptyResult: TokenActivitySummary = {
      total_tokens: 0,
      peak_tokens: 0,
      peak_date: '',
      max_duration_ms: 0,
      current_streak: 0,
      longest_streak: 0,
      days: []
    };

    if (!this.db || !this.db.open) return emptyResult;

    let agentClause = '';
    const params: Record<string, any> = {};

    if (agentCategory && agentCategory !== 'all') {
      agentClause = 'AND LOWER(agent_category(agent_name)) = @agentCategory';
      params.agentCategory = agentCategory.toLowerCase().trim();
    }

    // 聚合查询最近 365 天，按本地时间转换日期的每日 Token 消耗及 Agent
    const sql = `
      SELECT
        strftime('%Y-%m-%d', created_at, 'localtime') as date_str,
        COALESCE(agent_name, '') as agent_name,
        COUNT(*) as request_count,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cached_tokens), 0) as cached_tokens,
        COALESCE(SUM(thinking_tokens), 0) as thinking_tokens,
        COALESCE(MAX(duration_ms), 0) as max_duration_ms
      FROM usage_events
      WHERE is_model_request(url_path) = 1 AND (
        created_at >= datetime('now', '-365 days')
        OR (created_at LIKE '%T%' AND datetime(created_at) >= datetime('now', '-365 days'))
      )
      ${agentClause}
      GROUP BY date_str, agent_name
      HAVING date_str IS NOT NULL
      ORDER BY date_str ASC
    `;

    const rows = this.db.prepare(sql).all(params) as any[];

    if (!rows.length) return emptyResult;

    const dayMap = new Map<string, DailyTokenDayStat>();
    let totalTokens = 0;
    let maxDurationMs = 0;

    for (const r of rows) {
      const dateKey = r.date_str;
      const cat = getAgentCategory(r.agent_name);
      const rowTokens = Number(r.total_tokens) || 0;
      const rowInput = Number(r.input_tokens) || 0;
      const rowOutput = Number(r.output_tokens) || 0;
      const rowCached = Number(r.cached_tokens) || 0;
      const rowThinking = Number(r.thinking_tokens) || 0;
      const rowCount = Number(r.request_count) || 0;
      const rowDuration = Number(r.max_duration_ms) || 0;

      totalTokens += rowTokens;
      if (rowDuration > maxDurationMs) maxDurationMs = rowDuration;

      let existing = dayMap.get(dateKey);
      if (!existing) {
        existing = {
          date: dateKey,
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          thinking_tokens: 0,
          request_count: 0,
          max_duration_ms: 0,
          agent_breakdown: { Codex: 0, Antigravity: 0, Pi: 0, WorkBuddy: 0, Other: 0 }
        };
        dayMap.set(dateKey, existing);
      }

      existing.total_tokens += rowTokens;
      existing.input_tokens += rowInput;
      existing.output_tokens += rowOutput;
      existing.cached_tokens += rowCached;
      existing.thinking_tokens += rowThinking;
      existing.request_count += rowCount;
      if (rowDuration > existing.max_duration_ms) {
        existing.max_duration_ms = rowDuration;
      }
      if (!existing.agent_breakdown) {
        existing.agent_breakdown = { Codex: 0, Antigravity: 0, Pi: 0, WorkBuddy: 0, Other: 0 };
      }
      existing.agent_breakdown[cat] = (existing.agent_breakdown[cat] || 0) + rowTokens;
    }

    const days = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    let peakTokens = 0;
    let peakDate = '';
    const activeDates: string[] = [];

    for (const d of days) {
      if (d.total_tokens > peakTokens) {
        peakTokens = d.total_tokens;
        peakDate = d.date;
      }
      if (d.total_tokens > 0) {
        activeDates.push(d.date);
      }
    }

    // 计算连续天数 (Streak)
    let longestStreak = 0;
    let currentStreak = 0;

    if (activeDates.length > 0) {
      // 1. 最长连续天数计算
      let tempStreak = 1;
      longestStreak = 1;

      for (let i = 1; i < activeDates.length; i++) {
        const prev = new Date(activeDates[i - 1] + 'T00:00:00');
        const curr = new Date(activeDates[i] + 'T00:00:00');
        const diffDays = Math.round((curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));

        if (diffDays === 1) {
          tempStreak++;
          if (tempStreak > longestStreak) {
            longestStreak = tempStreak;
          }
        } else if (diffDays > 1) {
          tempStreak = 1;
        }
      }

      // 2. 当前连续天数计算 (以本地时间今天/昨天为基准)
      const now = new Date();
      const formatDateKey = (dt: Date) => {
        const y = dt.getFullYear();
        const m = String(dt.getMonth() + 1).padStart(2, '0');
        const d = String(dt.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      };

      const todayStr = formatDateKey(now);
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const yesterdayStr = formatDateKey(yesterday);

      const dateSet = new Set(activeDates);
      let anchorDate: Date | null = null;

      if (dateSet.has(todayStr)) {
        anchorDate = now;
      } else if (dateSet.has(yesterdayStr)) {
        anchorDate = yesterday;
      }

      if (anchorDate) {
        let check = new Date(anchorDate.getTime());
        while (dateSet.has(formatDateKey(check))) {
          currentStreak++;
          check = new Date(check.getTime() - 24 * 60 * 60 * 1000);
        }
      }
    }

    return {
      total_tokens: totalTokens,
      peak_tokens: peakTokens,
      peak_date: peakDate,
      max_duration_ms: maxDurationMs,
      current_streak: currentStreak,
      longest_streak: longestStreak,
      days
    };
  }

  /**
   * 获取指定日期各个模型的消耗量统计 (按 Token 消耗降序排列)
   */
  public async getResolvedDayModelUsage(dateStr: string, agentCategory?: string): Promise<DayModelUsageItem[]> {
    if (!dateStr) return [];
    return (await (this.dayModelClient ??= new DayModelClient(this.dbPath)).get(dateStr, agentCategory)).models;
  }
  public async getResolvedDayTokenDetails(dateStr: string, agentCategory?: string): Promise<any[]> {
    if (!dateStr) return [];
    return (await (this.dayModelClient ??= new DayModelClient(this.dbPath)).get(dateStr, agentCategory)).details;
  }

  public getDayModelUsage(dateStr: string, agentCategory?: string): DayModelUsageItem[] {
    if (!this.db || !this.db.open || !dateStr) return [];

    let agentClause = '';
    const params: Record<string, any> = { targetDay: dateStr };

    if (agentCategory && agentCategory !== 'all') {
      agentClause = 'AND LOWER(agent_category(agent_name)) = @agentCategory';
      params.agentCategory = agentCategory.toLowerCase().trim();
    }

    const sql = `
      SELECT
        COALESCE(NULLIF(model, ''), 'unknown') as model,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COUNT(*) as request_count,
        SUM(CASE WHEN token_source = 'reported' THEN 1 ELSE 0 END) as reported_requests
      FROM usage_events
      WHERE is_model_request(url_path) = 1 AND strftime('%Y-%m-%d', created_at, 'localtime') = @targetDay
      ${agentClause}
      GROUP BY model
      ORDER BY total_tokens DESC
    `;

    return this.db.prepare(sql).all(params) as DayModelUsageItem[];
  }

  /**
   * 获取指定日期的 Token 消耗任务明细 (Top 50)
   */
  public getDayTokenDetails(dateStr: string, agentCategory?: string): any[] {
    if (!this.db || !this.db.open || !dateStr) return [];

    let agentClause = '';
    const params: Record<string, any> = { targetDay: dateStr };

    if (agentCategory && agentCategory !== 'all') {
      agentClause = 'AND LOWER(agent_category(agent_name)) = @agentCategory';
      params.agentCategory = agentCategory.toLowerCase().trim();
    }

    const sql = `
      SELECT
        id, event_id, session_id, agent_name, provider, model, token_source, status_code, capture_status, user_prompt, prompt_summary, duration_ms,
        input_tokens, output_tokens, cached_tokens, thinking_tokens, total_tokens, created_at
      FROM usage_events
      WHERE is_model_request(url_path) = 1 AND strftime('%Y-%m-%d', created_at, 'localtime') = @targetDay
      ${agentClause}
      ORDER BY total_tokens DESC
      LIMIT 50
    `;

    return this.db.prepare(sql).all(params) as any[];
  }


  /** Clear complete content while retaining lightweight history and permanent usage. */
  public clearRecords(): void {
    this.db.transaction(() => {
      this.db.exec(`UPDATE records SET request_body = '', response_body = '', system_prompt = '',
        response_text = '', thinking_text = '', content_expired = 1;
        DELETE FROM content_refs; DELETE FROM content_fields;`);
      new AttributionRepository(this.db).clearExpiredIdentityIndexes();
    }).immediate();
    this.bumpVersion(); clearTaskClustersCache();
  }

  public resetUsage(): void {
    this.db.transaction(() => {
      while (backfillUsageBatch(this.db)) { /* ensure legacy events remain tombstones */ }
      this.db.exec('UPDATE usage_ledger SET counted = 0');
      this.db.prepare("UPDATE storage_metadata SET value = datetime('now') WHERE key = 'usage_coverage_start'").run();
    }).immediate();
    this.bumpVersion();
  }

  public deleteAllData(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM records; DELETE FROM content_refs; DELETE FROM content_fields; DELETE FROM content_blocks; DELETE FROM usage_ledger;');
      this.db.prepare("UPDATE storage_metadata SET value = datetime('now') WHERE key = 'usage_coverage_start'").run();
    }).immediate();
    this.bumpVersion(); clearTaskClustersCache();
  }

  /**
   * Scans for historical records that contain unredacted sensitive authorization headers
   */
  public scanSensitiveRecords(): { totalScanned: number; sensitiveCount: number; recordIds: number[] } {
    if (!this.db || !this.db.open) return { totalScanned: 0, sensitiveCount: 0, recordIds: [] };
    const rows = this.db.prepare('SELECT id, request_headers FROM records ORDER BY id DESC').all() as any[];
    const sensitiveIds: number[] = [];

    const sensitiveKeys = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'anthropic-api-key', 'x-goog-api-key'];

    for (const row of rows) {
      try {
        const headers = JSON.parse(row.request_headers || '{}');
        for (const [k, v] of Object.entries(headers)) {
          const lk = k.toLowerCase();
          if (sensitiveKeys.includes(lk)) {
            const val = String(v);
            if (!val.includes('[REDACTED]')) {
              sensitiveIds.push(Number(row.id));
              break;
            }
          }
        }
      } catch {}
    }

    return {
      totalScanned: rows.length,
      sensitiveCount: sensitiveIds.length,
      recordIds: sensitiveIds
    };
  }

  /**
   * Sanitizes historical sensitive records in place
   */
  public sanitizeHistoricalRecords(): { sanitizedCount: number } {
    if (!this.db || !this.db.open) return { sanitizedCount: 0 };
    const { recordIds } = this.scanSensitiveRecords();
    if (recordIds.length === 0) return { sanitizedCount: 0 };

    const selectStmt = this.db.prepare('SELECT id, request_headers FROM records WHERE id = ?');
    const updateStmt = this.db.prepare('UPDATE records SET request_headers = ? WHERE id = ?');

    const sensitiveKeys = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'anthropic-api-key', 'x-goog-api-key'];

    const tx = this.db.transaction((ids: number[]) => {
      let count = 0;
      for (const id of ids) {
        const row = selectStmt.get(id) as any;
        if (!row) continue;
        try {
          const headers = JSON.parse(row.request_headers || '{}');
          let changed = false;
          for (const [k, v] of Object.entries(headers)) {
            const lk = k.toLowerCase();
            if (sensitiveKeys.includes(lk)) {
              const val = String(v);
              if (lk === 'authorization' && val.toLowerCase().startsWith('bearer ')) {
                headers[k] = 'Bearer [REDACTED]';
              } else if (lk === 'authorization' && val.toLowerCase().startsWith('basic ')) {
                headers[k] = 'Basic [REDACTED]';
              } else {
                headers[k] = '[REDACTED]';
              }
              changed = true;
            }
          }
          if (changed) {
            updateStmt.run(JSON.stringify(headers), id);
            count++;
          }
        } catch {}
      }
      return count;
    });

    const sanitizedCount = tx(recordIds);
    return { sanitizedCount };
  }

  /**
   * Diagnostic statistics for truncated and errored requests
   */
  public getTruncatedAndDroppedStats(): { truncatedCount: number; errorCount: number; totalRecords: number } {
    if (!this.db || !this.db.open) return { truncatedCount: 0, errorCount: 0, totalRecords: 0 };
    const truncatedRow = this.db.prepare("SELECT COUNT(*) as c FROM records WHERE capture_status = 'truncated'").get() as any;
    const errorRow = this.db.prepare("SELECT COUNT(*) as c FROM records WHERE status_code >= 400 OR capture_status = 'error'").get() as any;
    const totalRow = this.db.prepare('SELECT COUNT(*) as c FROM records').get() as any;

    return {
      truncatedCount: truncatedRow?.c || 0,
      errorCount: errorRow?.c || 0,
      totalRecords: totalRow?.c || 0
    };
  }

  /**
   * Diagnostic list of recent errored requests
   */
  public getRecentErrors(limit: number = 10): AuditRecord[] {
    if (!this.db || !this.db.open) return [];
    return this.db.prepare(`
      SELECT id, session_id, agent_name, provider, model, method, url_path, status_code,
             duration_ms, input_tokens, output_tokens, cached_tokens, total_tokens,
             prompt_summary, response_preview, created_at
      FROM records
      WHERE status_code >= 400 OR capture_status = 'error'
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as AuditRecord[];
  }

  public getDbPath(): string {
    return this.dbPath;
  }

  public getDbSize(): number {
    try {
      let size = 0;
      if (fs.existsSync(this.dbPath)) {
        size += fs.statSync(this.dbPath).size;
      }
      const wal = this.dbPath + '-wal';
      if (fs.existsSync(wal)) {
        size += fs.statSync(wal).size;
      }
      return size;
    } catch {
      return 0;
    }
  }

  public pruneOldRecords(days: number): { deleted: number } {
    if (!Number.isFinite(days) || days <= 0) return { deleted: 0 };
    const deleted = this.db.transaction(() => {
      let count = 0;
      for (const id of expiredRecordIds(this.db, Math.floor(days))) count += this.db.prepare('DELETE FROM records WHERE id = ?').run(id).changes;
      new AttributionRepository(this.db).clearExpiredIdentityIndexes();
      this.content().collectGarbage();
      return count;
    }).immediate();
    if (deleted) this.bumpVersion();
    return { deleted };
  }

  public checkpoint(): void {
    if (!this.db || !this.db.open) return;
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {}
  }

  public async stopMaintenance(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    worker.ref(); // Awaited shutdown must keep a standalone Node process alive until SQLite is closed.
    await new Promise<void>(resolve => {
      worker.once('exit', () => resolve());
      worker.postMessage({ stop: true });
    });
  }

  public close(): void {
    this.dayModelClient?.close();
    this.dayModelClient = undefined;
    void this.evidenceCollector?.stop();
    this.evidenceCollector = undefined;
    this.attributionService?.close();
    void this.attributionWorker?.close();
    this.attributionWorker = undefined;
    if (this.worker) { this.worker.postMessage({ stop: true }); this.worker = undefined; }
    if (this.db && this.db.open) {
      if (this.ownsSchema) this.checkpoint();
      this.db.close();
    }
  }
}
