import type { AgentAdapter, CaptureInput, EvidenceSource } from './contracts';
import { workbuddyAdapter } from './adapters/workbuddy';
import { piAdapter } from './adapters/pi';
import { PiEvidenceSource } from './sources/pi';
import { codexAdapter } from './adapters/codex';
import { antigravityAdapter } from './adapters/antigravity';
import { AntigravityEvidenceSource } from './sources/antigravity';

export class AdapterRegistry {
  constructor(private readonly adapters: readonly AgentAdapter[] = [antigravityAdapter, codexAdapter, piAdapter, workbuddyAdapter],
    private readonly sources: ReadonlyMap<string, (root: string) => EvidenceSource> = new Map<string, (root: string) => EvidenceSource>([
      ['antigravity', root => new AntigravityEvidenceSource(root)],
      ['pi', root => new PiEvidenceSource(root)]
    ])) {
    if (new Set(adapters.map(adapter => adapter.id)).size !== adapters.length) throw new Error('Duplicate attribution adapter');
  }
  currentAdapters(): readonly AgentAdapter[] { return this.adapters; }
  sourceFor(adapterId: string, root: string): EvidenceSource {
    return this.sources.get(adapterId)?.(root) || { read: async () => ({ status: 'unavailable', reason: 'source_disabled' }) };
  }
  select(input: CaptureInput): { status: 'matched'; adapter: AgentAdapter } | { status: 'unsupported' } | { status: 'conflict' } {
    const matches = this.adapters.filter(adapter => adapter.matches(input));
    return matches.length === 1 ? { status: 'matched', adapter: matches[0] }
      : { status: matches.length ? 'conflict' : 'unsupported' };
  }
}
