import type { EvidenceRoots } from './contracts';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { SessionCluster } from '../types';

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** One serial execution context; failures never fall back to blocking the UI thread. */
export class AttributionWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;
  private failure?: Error;
  private stopping?: Promise<void>;
  private sessionsPending?: Promise<SessionCluster[]>;

  constructor(dbPath: string, onChanged: () => void) {
    this.worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: { dbPath } });
    this.worker.on('message', message => {
      if (message.changed) onChanged();
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
      if (!this.pending.size) this.worker.unref();
    });
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', () => this.fail(new Error('Attribution worker stopped')));
    this.worker.unref();
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  /** Crashed, exited or timed out; an explicit close() is not a failure. */
  get failed(): boolean { return !this.closed && !!this.failure; }

  private request(method: 'sessions' | 'collect', root?: EvidenceRoots, ids?: number[]): Promise<unknown> {
    if (this.closed || this.failure) return Promise.reject(this.failure || new Error('Attribution worker closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.fail(new Error('Attribution worker timed out'));
        void this.worker.terminate();
      }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.ref();
      this.worker.postMessage({ id, method, root, ids });
    });
  }

  sessions(): Promise<SessionCluster[]> {
    if (this.sessionsPending) return this.sessionsPending;
    const work = this.request('sessions') as Promise<SessionCluster[]>;
    this.sessionsPending = work;
    void work.finally(() => { if (this.sessionsPending === work) this.sessionsPending = undefined; }).catch(() => undefined);
    return work;
  }

  async collect(root: EvidenceRoots, ids?: number[]): Promise<Set<number>> {
    return new Set(await this.request('collect', root, ids) as number[]);
  }

  close(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.fail(new Error('Attribution worker closed'));
    this.stopping = this.worker.terminate().then(() => undefined);
    return this.stopping;
  }
}
