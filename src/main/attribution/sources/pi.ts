import { promises as fs, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { object, type EvidenceSource, type NativeEvidence, type PiArchive, type CaptureFacts } from '../contracts';
import { decodePiArchive, piApi } from '../adapters/piArchive';

type Row = PiArchive['records'][number];
type IndexedFile = { name: string; path: string; stamp: string; header: string; rows: IndexedRow[] };
type IndexedRow = { file: IndexedFile; id: string; offset: number; length: number; digest: string; parentId: unknown; input: boolean; api?: string; responseId?: string };
type Scan = { sourceId: string; responses: Map<string, IndexedRow[]>; entries: Map<string, IndexedRow> } | { reason: 'source_disabled' | 'source_missing' | 'source_limit' | 'source_invalid' | 'source_changed' };
// Bound work, individual JSON objects, index cardinality and cached payloads separately.
// Whole log files are never allocated or retained in memory.
const MAX_FILES = 1024, MAX_SCAN_BYTES = 1024 * 1024 * 1024, MAX_ENTRIES = 200000;
const MAX_LINE_BYTES = 8 * 1024 * 1024, MAX_HEADER_BYTES = 64 * 1024, CACHE_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const READ_BYTES = 64 * 1024;
const stamp = (stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const failure = (error: unknown): Extract<Scan, { reason: string }> => {
  const code = (error as NodeJS.ErrnoException).code, message = (error as Error).message;
  return { reason: message === 'source_limit' ? 'source_limit' : message === 'source_changed' ? 'source_changed'
    : code === 'ENOENT' || code === 'EACCES' ? 'source_missing' : 'source_invalid' };
};

/** One complete index snapshot per batch. Unchanged files reuse metadata; changed files are rescanned. */
export class PiEvidenceSource implements EvidenceSource {
  private scan?: Promise<Scan>;
  private files = new Map<string, IndexedFile>();
  private payloads = new Map<IndexedRow, string>();
  private payloadBytes = 0;
  beginBatch(): void { this.scan = undefined; }
  constructor(private readonly root: string) {}

  async read(locator: NonNullable<CaptureFacts['locator']>, previous?: NativeEvidence): Promise<NativeEvidence> {
    if (locator.kind !== 'pi') return { status: 'unavailable', reason: 'source_invalid' };
    const scanned = await (this.scan ??= this.load());
    if ('reason' in scanned) return { status: 'unavailable', reason: scanned.reason };
    try {
      const matches = scanned.responses.get(JSON.stringify([locator.api, locator.responseId])) || [];
      const selected = new Set(matches);
      if (previous?.status === 'available' && previous.kind === 'pi') for (const row of previous.raw.records) {
        const current = scanned.entries.get(JSON.stringify([row.path, object(JSON.parse(row.entry)).id]));
        if (current) selected.add(current);
      }
      const records: Row[] = [];
      let bytes = 0;
      for (const row of selected) {
        bytes += row.length + Buffer.byteLength(row.file.header);
        if (bytes > MAX_EVIDENCE_BYTES) throw new Error('source_limit');
        records.push({ path: row.file.path, header: row.file.header, entry: await this.readEntry(row) });
      }
      const ancestry: NonNullable<PiArchive['ancestry']> = [];
      for (const match of matches) {
        const chain: NonNullable<PiArchive['ancestry']>[number] = { path: match.file.path, entryIds: [] };
        const seen = new Set<string>();
        let row: IndexedRow | undefined = match;
        while (row && !seen.has(row.id)) {
          // Bound depth as well as bytes. Keep the session match even when the turn cannot be proven.
          if (chain.entryIds.length >= 10000) { chain.limited = true; break; }
          if (!selected.has(row)) {
            const size = row.length + Buffer.byteLength(row.file.header);
            if (bytes + size > MAX_EVIDENCE_BYTES) { chain.limited = true; break; }
            records.push({ path: row.file.path, header: row.file.header, entry: await this.readEntry(row) });
            bytes += size; selected.add(row);
          }
          chain.entryIds.push(row.id); seen.add(row.id);
          if (row.input || typeof row.parentId !== 'string') break;
          row = scanned.entries.get(JSON.stringify([row.file.path, row.parentId]));
        }
        ancestry.push(chain);
      }
      return decodePiArchive({ format: 'pi-jsonl-v3', sourceId: scanned.sourceId, locator, records, ancestry });
    } catch (error) { return { status: 'unavailable', ...failure(error) }; }
  }

  private cache(row: IndexedRow, text: string): void {
    if (this.payloads.delete(row)) this.payloadBytes -= row.length;
    while (this.payloadBytes + row.length > CACHE_BYTES && this.payloads.size) {
      const first = this.payloads.keys().next().value!;
      this.payloads.delete(first); this.payloadBytes -= first.length;
    }
    this.payloads.set(row, text); this.payloadBytes += row.length;
  }

  private async readEntry(row: IndexedRow): Promise<string> {
    const cached = this.payloads.get(row);
    if (cached !== undefined) { this.cache(row, cached); return cached; }
    // Cache eviction never loses evidence: retrieve the indexed line from the same file version.
    if (await fs.realpath(row.file.name) !== row.file.name) throw new Error('source_changed');
    const handle = await fs.open(row.file.name, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (stamp(await handle.stat()) !== row.file.stamp) throw new Error('source_changed');
      const bytes = Buffer.alloc(row.length);
      let read = 0;
      while (read < bytes.length) {
        const result = await handle.read(bytes, read, bytes.length - read, row.offset + read);
        if (!result.bytesRead) throw new Error('source_changed');
        read += result.bytesRead;
      }
      if (stamp(await handle.stat()) !== row.file.stamp || stamp(await fs.stat(row.file.name)) !== row.file.stamp || digest(bytes) !== row.digest) throw new Error('source_changed');
      const text = bytes.toString('utf8'); this.cache(row, text); return text;
    } finally { await handle.close(); }
  }

  private async indexFile(file: IndexedFile, size: number, remainingEntries: number): Promise<void> {
    const handle = await fs.open(file.name, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (stamp(await handle.stat()) !== file.stamp) throw new Error('source_changed');
      const ids = new Set<string>();
      const accept = (bytes: Buffer, offset: number) => {
        const text = bytes.toString('utf8');
        if (!text.trim()) return;
        const entry = object(JSON.parse(text));
        if (!file.header) {
          if (bytes.length > MAX_HEADER_BYTES) throw new Error('source_limit');
          if (entry.type !== 'session' || entry.version !== 3 || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 512) throw new Error('source_invalid');
          file.header = text; return;
        }
        if (file.rows.length >= remainingEntries) throw new Error('source_limit');
        if (typeof entry.id !== 'string' || !entry.id || entry.id.length > 512 || ids.has(entry.id)) throw new Error('source_invalid');
        ids.add(entry.id);
        const message = object(entry.message);
        const api = entry.type === 'message' && message.role === 'assistant' ? piApi(message.api) : undefined;
        const responseId = api && typeof message.responseId === 'string' && message.responseId.length <= 512 ? message.responseId : undefined;
        const row: IndexedRow = { file, id: entry.id, offset, length: bytes.length, digest: digest(bytes), parentId: entry.parentId, input: entry.type === 'message' && message.role === 'user', api, responseId };
        file.rows.push(row);
        // Cache matching assistant payloads during scanning; ancestors are retrieved only when required.
        if (responseId) this.cache(row, text);
      };
      let position = 0, lineStart = 0, lineBytes = 0;
      let fragments: Buffer[] = [];
      const buffer = Buffer.alloc(READ_BYTES);
      while (position < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
        if (!bytesRead) throw new Error('source_changed');
        let start = 0;
        for (let i = 0; i < bytesRead; i++) if (buffer[i] === 10) {
          lineBytes += i - start;
          if (lineBytes > MAX_LINE_BYTES) throw new Error('source_limit');
          const tail = buffer.subarray(start, i);
          accept(fragments.length ? Buffer.concat([...fragments, tail], lineBytes) : tail, lineStart);
          fragments = []; lineBytes = 0; lineStart = position + i + 1; start = i + 1;
        }
        if (start < bytesRead) {
          lineBytes += bytesRead - start;
          if (lineBytes > MAX_LINE_BYTES) throw new Error('source_limit');
          fragments.push(Buffer.from(buffer.subarray(start, bytesRead)));
        }
        position += bytesRead;
      }
      if (lineBytes) accept(Buffer.concat(fragments, lineBytes), lineStart);
      if (!file.header) throw new Error('source_invalid');
      if (stamp(await handle.stat()) !== file.stamp) throw new Error('source_changed');
    } finally { await handle.close(); }
  }

  private async load(): Promise<Scan> {
    if (!this.root) return { reason: 'source_disabled' };
    try {
      const root = await fs.realpath(this.root);
      const files: string[] = [], directories: { name: string; stamp: string }[] = [];
      const list = async (directory: string, depth: number): Promise<void> => {
        const stat = await fs.stat(directory);
        directories.push({ name: directory, stamp: stamp(stat) });
        const entries = await fs.readdir(directory, { withFileTypes: true });
        if (entries.length > MAX_FILES || directories.length > MAX_FILES) throw new Error('source_limit');
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const name = path.join(directory, entry.name);
          // An unreadable/symlinked subtree could contain a second candidate: fail closed.
          if (entry.isSymbolicLink()) throw new Error('source_invalid');
          if (entry.isDirectory()) {
            if (depth >= 1) throw new Error('source_invalid');
            await list(name, depth + 1);
          } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            if (files.length >= MAX_FILES) throw new Error('source_limit');
            files.push(name);
          }
        }
      };
      await list(root, 0);
      let bytes = 0, count = 0;
      const nextFiles = new Map<string, IndexedFile>();
      for (const name of files) {
        const resolved = await fs.realpath(name);
        if (!resolved.startsWith(root + path.sep)) throw new Error('source_invalid');
        const info = await fs.stat(resolved);
        bytes += info.size;
        if (!info.isFile()) throw new Error('source_invalid');
        if (bytes > MAX_SCAN_BYTES) throw new Error('source_limit');
        const cached = this.files.get(resolved);
        let file: IndexedFile;
        if (cached?.stamp === stamp(info)) file = cached;
        else {
          file = { name: resolved, path: path.relative(root, resolved), stamp: stamp(info), header: '', rows: [] };
          await this.indexFile(file, info.size, MAX_ENTRIES - count);
        }
        count += file.rows.length;
        if (count > MAX_ENTRIES) throw new Error('source_limit');
        nextFiles.set(resolved, file);
      }
      // Never establish a new unique match from a partially scanned or changing source.
      for (const entry of [...directories, ...nextFiles.values()]) if (stamp(await fs.stat(entry.name)) !== entry.stamp) throw new Error('source_changed');
      this.files = nextFiles;
      for (const row of this.payloads.keys()) if (nextFiles.get(row.file.name) !== row.file) {
        this.payloads.delete(row); this.payloadBytes -= row.length;
      }
      const responses = new Map<string, IndexedRow[]>(), entries = new Map<string, IndexedRow>();
      for (const file of nextFiles.values()) for (const row of file.rows) {
        entries.set(JSON.stringify([row.file.path, row.id]), row);
        if (row.api && row.responseId) {
          const key = JSON.stringify([row.api, row.responseId]);
          const candidates = responses.get(key) || [];
          candidates.push(row); responses.set(key, candidates);
        }
      }
      return { sourceId: root, responses, entries };
    } catch (error) {
      this.files.clear(); this.payloads.clear(); this.payloadBytes = 0;
      return failure(error);
    }
  }
}
