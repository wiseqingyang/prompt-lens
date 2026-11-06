import { promises as fs } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { AntigravityLocator, PiLocator, EvidenceSource, NativeEvidence, AntigravityArchive } from '../contracts';
import { decodeAntigravityArchive } from '../adapters/antigravityArchive';
import { nativeUuid } from '../adapters/antigravity';

const MAX_BYTES = 16 * 1024 * 1024;

/** A configured root is read-only. A fresh instance provides one consistent collection batch. */
export class AntigravityEvidenceSource implements EvidenceSource {
  private readonly cache = new Map<string, Promise<NativeEvidence>>();
  constructor(private readonly root: string) {}

  read(locator: AntigravityLocator | PiLocator): Promise<NativeEvidence> {
    if (locator.kind === 'pi') return Promise.resolve({ status: 'unavailable', reason: 'source_invalid' });
    const key = JSON.stringify([locator.conversationId, locator.trajectoryId]);
    let pending = this.cache.get(key);
    if (!pending) { pending = this.load(locator); this.cache.set(key, pending); }
    return pending;
  }

  private async load(locator: AntigravityLocator): Promise<NativeEvidence> {
    if (!this.root) return { status: 'unavailable', reason: 'source_disabled' };
    if (!nativeUuid(locator.conversationId) || !nativeUuid(locator.trajectoryId)) return { status: 'unavailable', reason: 'source_invalid' };
    let archive: AntigravityArchive | undefined;
    try {
      const root = await fs.realpath(this.root);
      const inside = async (relative: string) => {
        const resolved = await fs.realpath(path.join(root, relative));
        if (!resolved.startsWith(root + path.sep)) throw new Error('outside source root');
        return resolved;
      };
      const dbPath = await inside(`conversations/${locator.conversationId}.db`);
      const transcriptPath = await inside(`brain/${locator.conversationId}/.system_generated/logs/transcript.jsonl`);
      const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 100 });
      let metadata: AntigravityArchive["metadata"] | undefined;
      try {
        db.pragma('query_only = ON');
        const meta = db.prepare('SELECT cascade_id, trajectory_id FROM trajectory_meta LIMIT 2').all() as { cascade_id: string; trajectory_id: string }[];
        if (meta.length === 1) metadata = meta[0];
      } finally { db.close(); }
      if (!metadata || metadata.cascade_id !== locator.conversationId || metadata.trajectory_id !== locator.trajectoryId) return { status: 'unavailable', reason: 'trajectory_mismatch' };
      const handle = await fs.open(transcriptPath, 'r');
      let raw: string;
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > MAX_BYTES) return { status: 'unavailable', reason: 'source_limit' };
        const buffer = Buffer.alloc(before.size + 1);
        let read = 0;
        while (read < buffer.length) {
          const chunk = await handle.read(buffer, read, buffer.length - read, read);
          if (!chunk.bytesRead) break;
          read += chunk.bytesRead;
        }
        const after = await handle.stat();
        if (before.size !== read || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return { status: 'unavailable', reason: 'source_changed' };
        raw = buffer.subarray(0, read).toString('utf8');
      } finally { await handle.close(); }
      archive = { format: 'antigravity-jsonl-v1', sourceId: root, metadata, transcript: raw };
      return decodeAntigravityArchive(archive, root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { status: 'unavailable', reason: code === 'ENOENT' || code === 'EACCES' ? 'source_missing' : 'source_invalid', ...(archive ? { raw: archive } : {}) };
    }
  }
}
