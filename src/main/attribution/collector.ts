import type { EvidenceRoots } from './contracts';
import { AttributionRepository } from './repository';
import { AttributionService } from './service';

export interface CollectionOptions {
  retryBaseMs?: number;
  pollMs?: number;
  batchSize?: number;
  onCollected?: (recordIds: number[]) => void;
}

/** Durable jobs, bounded batches and one in-flight native read pipeline per database. */
export class EvidenceCollector {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  constructor(private readonly repository: AttributionRepository, private readonly service: Pick<AttributionService, 'collect'>,
    private readonly root: () => EvidenceRoots, private readonly options: CollectionOptions = {}) {}

  wake(): void {
    if (this.stopped || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, 0);
    this.timer.unref();
  }

  private async run(): Promise<void> {
    if (this.stopped || this.running) return;
    let fullBatch = false;
    const work = (async () => {
      const ids = this.repository.dueJobs(Date.now(), this.options.batchSize ?? 32);
      if (!ids.length) return;
      fullBatch = ids.length === (this.options.batchSize ?? 32);
      let retry = new Set(ids);
      const revision = this.repository.revision();
      try {
        const root = this.root();
        retry = await this.service.collect(root, ids);
        // A settings change during I/O must not consume work queued for the new source.
        if (JSON.stringify(root) !== JSON.stringify(this.root())) retry = new Set(ids);
      }
      catch { /* Keep durable jobs for retry; never print native payloads or affect capture ACK. */ }
      if (!this.stopped) {
        const changed = revision !== this.repository.revision();
        this.repository.finishJobs(ids, retry, this.options.retryBaseMs ?? 1000);
        const completed = ids.filter(id => !retry.has(id));
        // A newly resolved session must reach the UI even if source monitoring continues.
        if (changed || completed.length) this.options.onCollected?.(changed ? ids : completed);
      }
    })();
    this.running = work;
    try { await work; }
    catch { /* Database lifecycle errors must not become unhandled rejections. Jobs remain durable. */ }
    finally {
      this.running = undefined;
      if (!this.stopped) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, fullBatch ? 0 : (this.options.pollMs ?? 1000));
        this.timer.unref();
      }
    }
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return this.running || Promise.resolve();
  }
}
