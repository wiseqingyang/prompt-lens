import { ContentReadCache } from '../content-store';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { AuditRecord, SessionCluster } from '../types';
import { clusterRecordsIntoSessions } from '../session';
import { AdapterRegistry } from './registry';
import { AttributionRepository, digest, evidenceScope, type StoredAttribution } from './repository';
import { unresolved, type EvidenceRoots, type CaptureInput, type NativeEvidence, type EvidenceSource, type AgentAdapter, type DecisionSnapshot, type RelationItem } from './contracts';
import { attributionView } from './view';
import type { AttributionDecision } from '../../shared/attribution';

function isAntigravityAvailable(obs: NativeEvidence): obs is import('./contracts').AntigravityNativeEvidence {
  return obs.status === 'available' && (obs.kind === undefined || obs.kind === 'antigravity') && Array.isArray((obs as any).steps);
}

function collapseObservations(observations: NativeEvidence[]): NativeEvidence[] {
  if (observations.length <= 1) return observations;
  const results: NativeEvidence[] = [];
  for (const obs of observations) {
    if (!isAntigravityAvailable(obs)) {
      results.push(obs);
      continue;
    }
    const existingIndex = results.findIndex(r => isAntigravityAvailable(r) && r.trajectoryId === obs.trajectoryId);
    if (existingIndex < 0) {
      results.push(obs);
    } else {
      const existing = results[existingIndex] as import('./contracts').AntigravityNativeEvidence;
      const minLen = Math.min(existing.steps.length, obs.steps.length);
      let conflict = false;
      for (let i = 0; i < minLen; i++) {
        if (existing.steps[i].index !== obs.steps[i].index ||
            existing.steps[i].type !== obs.steps[i].type ||
            existing.steps[i].source !== obs.steps[i].source ||
            existing.steps[i].input !== obs.steps[i].input) {
          conflict = true;
          break;
        }
      }
      if (!conflict && !existing.conflict && !obs.conflict) {
        if (obs.steps.length >= existing.steps.length) {
          results[existingIndex] = obs;
        }
      } else {
        results.push(obs);
      }
    }
  }
  return results;
}

export interface AttributionStorage {
  getRecords(options: { limit: number; lightweight: boolean; ids?: number[] }): AuditRecord[];
  getAttributionCapture(id: number, cache?: ContentReadCache): CaptureInput;
  attributionChanged(): void;
  getDataVersion(): number;
}

/** Collection owns native I/O. Queries and rule replay use only the application database. */
export class AttributionService {
  private pending: Promise<Set<number>> | undefined;
  private closed = false;
  private readonly reusableSources = new Map<string, { root: string; source: EvidenceSource }>();
  private sessionCache?: { revision: string; sessions: SessionCluster[] };
  private sessionPending?: Promise<SessionCluster[]>;
  constructor(private readonly storage: AttributionStorage, private readonly repository: AttributionRepository,
    private readonly registry = new AdapterRegistry(),
    private readonly sourceFactory: (root: string, adapterId: string) => EvidenceSource = (root, id) => this.registry.sourceFor(id, root)) {}

  close(): void { this.closed = true; this.reusableSources.clear(); }

  private revision(): string { return `${this.storage.getDataVersion()}:${this.repository.revision()}`; }

  private raw(record: AuditRecord, adapter: AgentAdapter, previous?: StoredAttribution, cache?: ContentReadCache) {
    // Validity is maintained by capture-input triggers, independently of UI/statistics changes.
    if (previous?.captureDigest && !record.content_expired) return { facts: previous.facts, hash: previous.captureDigest };
    const captureRevision = this.repository.revision();
    const input = this.storage.getAttributionCapture(record.id!, cache);
    const facts = adapter.extract(input);
    return { facts, hash: digest(JSON.stringify(input)), captureRevision };
  }

  /** Returns IDs needing later evidence; never sends model requests. */
  async collect(root: EvidenceRoots, ids?: number[]): Promise<Set<number>> {
    const previous = this.pending;
    const pending = (async () => {
      if (previous) await previous.catch(() => undefined);
      if (this.closed) return new Set<number>();
      const records = this.storage.getRecords({ limit: -1, lightweight: true, ids });
      const sources = new Map<string, EvidenceSource>();
      const contentCache = new ContentReadCache();
      const stored = new Map(this.repository.readAll(ids, this.registry.currentAdapters()).map(row => [JSON.stringify([row.recordId, row.adapterId, row.version]), row]));
      let collected = 0;
      for (const record of records) {
        if (collected++ && collected % 8 === 0) await yieldToEventLoop();
        if (this.closed) return new Set<number>();
        if (record.content_expired) continue;
        const selected = this.registry.select({ agentName: record.agent_name, body: undefined, capturedAt: record.created_at || '' });
        if (selected.status !== 'matched') continue;
        const adapter = selected.adapter;
        if (adapter.evidenceMode === 'capture') continue;
        const old = stored.get(JSON.stringify([record.id, adapter.id, adapter.version]));
        const { facts, hash, captureRevision } = this.raw(record, adapter, old, contentCache);
        if (!facts.locator) continue;
        let source = sources.get(adapter.id);
        if (!source) {
          const directory = typeof root === 'string' ? (adapter.id === 'antigravity' ? root : '')
            : adapter.id === 'pi' ? root.piSessionsDir : root.antigravityDataDir;
          const cached = this.reusableSources.get(adapter.id);
          source = cached?.root === directory ? cached.source : this.sourceFactory(directory, adapter.id);
          if (source.beginBatch) { source.beginBatch(); this.reusableSources.set(adapter.id, { root: directory, source }); }
          sources.set(adapter.id, source);
        }
        const native = await source.read(facts.locator, old?.native);
        if (this.closed) return new Set<number>();
        // Commit each observation promptly; later deletion/expiry is enforced by the repository.
        if (native.status === 'available' || native.raw) this.repository.saveObservations([{
          recordId: record.id!, adapterId: adapter.id, scope: evidenceScope(adapter.id, facts)!,
          native, observedAt: new Date().toISOString()
        }]);
        const capturedAt = record.created_at || '';
        if (old?.captureDigest === hash && old.capturedAt === capturedAt &&
            digest(JSON.stringify(old.native)) === digest(JSON.stringify(native))) continue;
        this.repository.saveBatch([{ recordId: record.id!, adapterId: adapter.id, version: adapter.version,
          captureDigest: hash, captureRevision, capturedAt, facts, native, decision: adapter.resolve({ facts, native, capturedAt }) }]);
      }
      if (this.closed) return new Set<number>();
      const current = this.storage.getRecords({ limit: -1, lightweight: true, ids });
      return (await this.project(current)).retry;
    })();
    this.pending = pending;
    try { return await pending; } finally { if (this.pending === pending) this.pending = undefined; }
  }

  async sessions(): Promise<SessionCluster[]> {
    if (this.closed) throw new Error('Attribution service is closed');
    while (this.sessionPending) await this.sessionPending;
    if (this.closed) throw new Error('Attribution service is closed');
    const revision = this.revision();
    if (this.sessionCache?.revision === revision) return this.sessionCache.sessions;
    const work = (async () => {
      const result = await this.project(this.storage.getRecords({ limit: -1, lightweight: true }), revision, false);
      if (result.persisted && result.expectedRevision === this.revision()) this.sessionCache = { revision: result.expectedRevision, sessions: result.sessions };
      return result.sessions;
    })();
    this.sessionPending = work;
    try { return await work; } finally { if (this.sessionPending === work) this.sessionPending = undefined; }
  }

  private async project(records: AuditRecord[], expectedRevision = this.revision(), needRetry = true): Promise<{ sessions: SessionCluster[]; retry: Set<number>; expectedRevision: string; persisted: boolean }> {
    const previous = new Map(this.repository.readAll(records.map(record => record.id!), this.registry.currentAdapters()).map(row => [JSON.stringify([row.recordId, row.adapterId, row.version]), row]));
    // Decode immutable observations once per scope and fingerprint each shared snapshot once.
    // Both caches live only for this replay; subsequent evidence/rule changes are read afresh.
    const contentCache = new ContentReadCache();
    const observationDigests = this.repository.observationDigests();
    const emptyObservations = digest('[]');
    const scopes = new Map<string, NativeEvidence[]>();
    const fingerprints = new WeakMap<NativeEvidence, string>();
    const fingerprint = (native: NativeEvidence): string => {
      let hash = fingerprints.get(native);
      if (!hash) { hash = digest(JSON.stringify(native)); fingerprints.set(native, hash); }
      return hash;
    };
    const relationGroups = new Map<AgentAdapter, RelationItem[]>();
    const legacy: AuditRecord[] = [], rows: StoredAttribution[] = [];
    const items: { record: AuditRecord; decision: AttributionDecision }[] = [], retry = new Set<number>();
    let processed = 0;
    let persisted = true;
    const writeProjection = (write: () => void) => {
      if (needRetry) write(); // Collection must persist evidence/results before consuming durable jobs.
      else if (persisted) persisted = this.repository.tryProjectionWrite(write);
    };
    const flush = () => {
      if (this.closed) throw new Error('Attribution service is closed');
      if (!rows.length) return;
      const beforeFlush = this.revision();
      const batch = rows.splice(0);
      writeProjection(() => {
        if (this.repository.saveBatch(batch)) this.storage.attributionChanged();
      });
      if (beforeFlush === expectedRevision) expectedRevision = this.revision();
    };
    for (const record of records) {
      if (processed++ && processed % 8 === 0) {
        flush();
        await yieldToEventLoop();
      }
      if (this.closed) throw new Error('Attribution service is closed');
      const input: CaptureInput = { agentName: record.agent_name, body: undefined, capturedAt: record.created_at || '' };
      const selected = this.registry.select(input);
      if (selected.status === 'unsupported') { legacy.push(record); continue; }
      if (selected.status === 'conflict') {
        items.push({ record, decision: { agentId: record.agent_name, ruleVersion: 'none',
          session: unresolved('adapter_conflict'), turn: unresolved('adapter_conflict') } });
        continue;
      }
      const adapter = selected.adapter;
      const old = previous.get(JSON.stringify([record.id, adapter.id, adapter.version]));
      const raw = this.raw(record, adapter, old, contentCache), facts = raw.facts;
      const scope = evidenceScope(adapter.id, facts);
      const observationDigest = scope ? observationDigests.get(scope) || emptyObservations : emptyObservations;
      const reusable = !!old?.captureDigest && old.captureDigest === raw.hash && old.capturedAt === input.capturedAt &&
        old.observationDigest === observationDigest && !record.content_expired;
      let native: NativeEvidence | undefined;
      if (!reusable) {
        native = adapter.evidenceMode === 'capture' ? { status: 'not_required' }
          : old?.native.status === 'unavailable' ? old.native : { status: 'unavailable', reason: 'source_missing' };
        if (scope && !record.content_expired) {
          const beforeLink = this.revision();
          writeProjection(() => this.repository.linkScope(record.id!, adapter.id, scope));
          if (beforeLink === expectedRevision) expectedRevision = this.revision();
          let observations = scopes.get(scope);
          if (!observations) {
            const rawList = this.repository.readObservations(scope).map(observation =>
              adapter.decodeEvidence ? adapter.decodeEvidence(observation.native) : observation.native);
            observations = collapseObservations(rawList);
            scopes.set(scope, observations);
          }
          for (const decoded of observations) {
            const previousSnapshot: DecisionSnapshot & { decision: AttributionDecision } = { facts, native, capturedAt: input.capturedAt, decision: adapter.resolve({ facts, native, capturedAt: input.capturedAt }) };
            native = adapter.reconcile ? adapter.reconcile(facts, decoded, previousSnapshot) : decoded;
          }
        }
      }
      const decision = reusable ? old.decision : adapter.resolve({ facts, native: native!, capturedAt: input.capturedAt });
      if (needRetry && facts.locator && !record.content_expired && (adapter.monitorEvidence || (decision.turn.status !== 'resolved' && decision.turn.reason !== 'no_user_input'))) {
        const currentNative = reusable ? old.native : native!;
        if (!(currentNative.status === 'available' && currentNative.conflict)) retry.add(record.id!);
      }
      items.push({ record, decision });
      if (adapter.relate) {
        const group = relationGroups.get(adapter) || [];
        group.push({recordId: record.id!, contentExpired: Boolean(record.content_expired), facts, decision});
        relationGroups.set(adapter, group);
      }
      if (!reusable && (!old || old.observationDigest !== observationDigest || old.captureDigest !== raw.hash || old.capturedAt !== input.capturedAt ||
          JSON.stringify(old.decision) !== JSON.stringify(decision) || fingerprint(old.native) !== fingerprint(native!))) {
        rows.push({ recordId: record.id!, adapterId: adapter.id, version: adapter.version,
          facts, captureDigest: raw.hash, captureRevision: raw.captureRevision, observationDigest, capturedAt: input.capturedAt, native: native!, decision });
      }
    }
    flush();
    // Relations are computed from this complete projection, never persisted from a partial collection batch.
    const byId = new Map(items.map(item => [item.record.id!, item]));
    for (const [adapter, group] of relationGroups) for (const [id, toolLink] of adapter.relate!(group)) {
      const item = byId.get(id);
      if (item) item.decision = {...item.decision, toolLink};
    }
    return { retry, expectedRevision, persisted, sessions: [...clusterRecordsIntoSessions(legacy), ...attributionView(items)]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)) };
  }
}
