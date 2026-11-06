import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import zlib from 'zlib';

// v1: 64-byte rolling polynomial fingerprint. Byte boundaries need not be UTF-8 boundaries:
// reconstruction concatenates bytes before decoding. Changing any parameter requires a new version.
export const CHUNK_V1 = { version: 1, min: 8 * 1024, target: 32 * 1024, max: 128 * 1024, window: 64 };
export const CONTENT_FIELDS = ['request_body', 'response_body', 'system_prompt', 'response_text', 'thinking_text'] as const;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function chunkContent(bytes: Buffer, config = CHUNK_V1): Buffer[] {
  const chunks: Buffer[] = [];
  let start = 0, rolling = 0, power = 1;
  for (let n = 0; n < config.window; n++) power = Math.imul(power, 257) >>> 0;
  const mask = config.target - 1;
  for (let i = 0; i < bytes.length; i++) {
    rolling = (Math.imul(rolling, 257) + bytes[i] + 1) >>> 0;
    if (i >= config.window) rolling = (rolling - Math.imul(bytes[i - config.window] + 1, power)) >>> 0;
    const length = i + 1 - start;
    if (length >= config.min && ((rolling & mask) === 0 || length >= config.max)) {
      chunks.push(bytes.subarray(start, i + 1)); start = i + 1;
    }
  }
  if (start < bytes.length) chunks.push(bytes.subarray(start));
  return chunks;
}

export function decodeLegacy(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    try { return zlib.inflateRawSync(value).toString('utf8'); }
    catch (cause) { throw new Error('历史内容损坏：无法解压 Deflate 报文', { cause }); }
  }
  return typeof value === 'string' ? value : '';
}

/** Bounded to one attribution pass. Encoded bytes are checked on every hit, so repairs
 * or corrupt blocks under an unchanged hash never reuse previously decoded content. */
export class ContentReadCache {
  private readonly blocks = new Map<string, { encoded: Buffer; codec: string; decoded: Buffer }>();
  private bytes = 0;
  constructor(private readonly limit = 64 * 1024 * 1024) {}
  get(key: string, codec: string, encoded: Buffer): Buffer | undefined {
    const entry = this.blocks.get(key);
    if (!entry || entry.codec !== codec || !entry.encoded.equals(encoded)) return;
    this.blocks.delete(key); this.blocks.set(key, entry);
    return entry.decoded;
  }
  set(key: string, codec: string, encoded: Buffer, decoded: Buffer): void {
    const old = this.blocks.get(key);
    if (old) { this.bytes -= old.encoded.length + old.decoded.length; this.blocks.delete(key); }
    const size = encoded.length + decoded.length;
    if (size > this.limit) return;
    while (this.bytes + size > this.limit && this.blocks.size) {
      const first = this.blocks.keys().next().value!;
      const entry = this.blocks.get(first)!; this.bytes -= entry.encoded.length + entry.decoded.length; this.blocks.delete(first);
    }
    this.blocks.set(key, {encoded, codec, decoded}); this.bytes += size;
  }
}

export class ContentStore {
  constructor(private db: Database.Database, private readonly cache?: ContentReadCache) {}

  static createSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS content_blocks (
        hash TEXT PRIMARY KEY, version INTEGER NOT NULL, codec TEXT NOT NULL,
        raw_length INTEGER NOT NULL, data BLOB NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS content_fields (
        record_id INTEGER NOT NULL, field TEXT NOT NULL, version INTEGER NOT NULL,
        encoding TEXT NOT NULL, raw_length INTEGER NOT NULL, digest TEXT NOT NULL,
        chunk_count INTEGER NOT NULL, PRIMARY KEY(record_id, field)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS content_refs (
        record_id INTEGER NOT NULL, field TEXT NOT NULL, ordinal INTEGER NOT NULL,
        hash TEXT NOT NULL, PRIMARY KEY(record_id, field, ordinal)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_content_refs_hash ON content_refs(hash);
      CREATE TRIGGER IF NOT EXISTS delete_record_content AFTER DELETE ON records BEGIN
        DELETE FROM content_refs WHERE record_id = OLD.id;
        DELETE FROM content_fields WHERE record_id = OLD.id;
      END;
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_records_content_pending ON records(id) WHERE content_expired = 0 AND (${CONTENT_FIELDS.map(f => `LENGTH(${f}) > 0`).join(' OR ')});`);
    // A repair can replace a migrated field. Its replacement is staged for the next migration.
    for (const field of CONTENT_FIELDS) db.exec(`
      CREATE TRIGGER IF NOT EXISTS replace_content_${field} AFTER UPDATE OF ${field} ON records
      WHEN LENGTH(NEW.${field}) > 0 BEGIN
        DELETE FROM content_refs WHERE record_id = NEW.id AND field = '${field}';
        DELETE FROM content_fields WHERE record_id = NEW.id AND field = '${field}';
      END;
    `);
  }

  read(recordId: number, field: string, legacy: unknown): string {
    // During old-schema migrations this table may not exist yet.
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'content_fields'").get();
    if (!exists) {
      if (Number(this.db.pragma('user_version', { simple: true })) >= 11) throw new Error('内容清单表损坏');
      return decodeLegacy(legacy);
    }
    const meta = this.db.prepare('SELECT * FROM content_fields WHERE record_id = ? AND field = ?').get(recordId, field) as any;
    if (!meta) {
      if (this.db.prepare('SELECT 1 FROM content_refs WHERE record_id = ? AND field = ? LIMIT 1').get(recordId, field)) throw new Error(`内容清单缺失：${recordId}/${field}`);
      return decodeLegacy(legacy);
    }
    if (meta.version !== 1 || meta.encoding !== 'utf8') throw new Error(`内容格式不支持：${recordId}/${field}`);
    const chunks: Buffer[] = [];
    let length = 0, ordinal = 0;
    const refs = this.db.prepare(`SELECT r.ordinal, r.hash, b.version, b.codec, b.raw_length, b.data
      FROM content_refs r LEFT JOIN content_blocks b ON r.hash = b.hash
      WHERE record_id = ? AND field = ? ORDER BY ordinal`).iterate(recordId, field);
    for (const row of refs as Iterable<any>) {
      if (row.ordinal !== ordinal++ || row.version !== 1 || row.raw_length <= 0 || row.raw_length > CHUNK_V1.max || !Buffer.isBuffer(row.data)) throw new Error(`内容引用损坏：${recordId}/${field}`);
      let bytes = this.cache?.get(row.hash, row.codec, row.data);
      if (!bytes) {
        try {
          if (row.codec === 'br9') bytes = zlib.brotliDecompressSync(row.data, { maxOutputLength: row.raw_length });
          else if (row.codec === 'raw') bytes = row.data as Buffer;
          else throw new Error('unknown codec');
        } catch (cause) { throw new Error(`内容块损坏：${row.hash}`, { cause }); }
        if (bytes.length !== row.raw_length || hash(bytes) !== row.hash) throw new Error(`内容校验失败：${row.hash}`);
        this.cache?.set(row.hash, row.codec, row.data, bytes);
      }
      if (bytes.length !== row.raw_length) throw new Error(`内容长度损坏：${row.hash}`);
      chunks.push(bytes); length += bytes.length;
    }
    if (ordinal !== meta.chunk_count || length !== meta.raw_length) throw new Error(`内容长度/引用损坏：${recordId}/${field}`);
    const bytes = Buffer.concat(chunks, length);
    if (hash(bytes) !== meta.digest) throw new Error(`内容摘要损坏：${recordId}/${field}`);
    return bytes.toString('utf8');
  }

  // Called in a worker. Compression happens before acquiring the SQLite write reservation.
  // One field at a time bounds memory to the current field plus its compressed blocks.
  migrateOne(): boolean {
    const condition = CONTENT_FIELDS.map(f => `LENGTH(${f}) > 0`).join(' OR ');
    const choice = CONTENT_FIELDS.map(f => `WHEN LENGTH(${f}) > 0 THEN '${f}'`).join(' ');
    const candidate = this.db.prepare(`SELECT id, CASE ${choice} END field FROM records
      WHERE content_expired = 0 AND (${condition}) ORDER BY id LIMIT 1`).get() as any;
    if (!candidate) return false;
    const field = candidate.field as typeof CONTENT_FIELDS[number];
    // Fetch only the current field, never all large fields or a database-sized batch.
    const row = this.db.prepare(`SELECT id, ${field} FROM records WHERE id = ?`).get(candidate.id) as any;
    if (!row) return true;
    {
      const original = row[field];
      const bytes = Buffer.from(decodeLegacy(original), 'utf8');
      const prepared = new Map<string, { digest: string; raw: Buffer; data: Buffer | null; codec: string }>();
      const blocks = chunkContent(bytes).map(raw => {
        const digest = hash(raw);
        const prior = prepared.get(digest);
        if (prior) return prior;
        const exists = this.db.prepare('SELECT 1 FROM content_blocks WHERE hash = ?').get(digest);
        if (exists) return { digest, raw, data: null as Buffer | null, codec: '' };
        const compressed = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } });
        const block = { digest, raw, data: compressed.length < raw.length ? compressed : raw, codec: compressed.length < raw.length ? 'br9' : 'raw' };
        prepared.set(digest, block);
        return block;
      });
      this.db.transaction(() => {
        const current = this.db.prepare(`SELECT ${field}, content_expired FROM records WHERE id = ?`).get(row.id) as any;
        if (!current || current.content_expired || !same(current[field], original)) return;
        this.db.prepare('DELETE FROM content_refs WHERE record_id = ? AND field = ?').run(row.id, field);
        blocks.forEach((block, ordinal) => {
          if (block.data) this.db.prepare('INSERT OR IGNORE INTO content_blocks VALUES (?, 1, ?, ?, ?)').run(block.digest, block.codec, block.raw.length, block.data);
          this.db.prepare('INSERT INTO content_refs VALUES (?, ?, ?, ?)').run(row.id, field, ordinal, block.digest);
        });
        this.db.prepare('INSERT OR REPLACE INTO content_fields VALUES (?, ?, 1, ?, ?, ?, ?)').run(row.id, field, 'utf8', bytes.length, hash(bytes), blocks.length);
        const restored = Buffer.from(this.read(row.id, field, ''), 'utf8');
        if (!restored.equals(bytes)) throw new Error('迁移校验失败，旧内容已保留');
        this.db.prepare(`UPDATE records SET ${field} = '' WHERE id = ?`).run(row.id);
      }).immediate();
    }
    return true;
  }

  collectGarbage(limit = 256): number {
    return this.db.prepare(`DELETE FROM content_blocks WHERE hash IN (
      SELECT hash FROM content_blocks b WHERE NOT EXISTS (SELECT 1 FROM content_refs r WHERE r.hash = b.hash) LIMIT ?
    )`).run(limit).changes;
  }
}
function same(a: any, b: any): boolean {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : a === b;
}
