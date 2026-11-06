import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { DayModelUsageItem } from './types';

type Result = { models: DayModelUsageItem[]; details: any[] };

/** Read-only work stays off the host thread; concurrent identical requests share a snapshot. */
export class DayModelClient {
  private readonly active = new Map<string, { worker: Worker; promise: Promise<Result>; cancel: () => void }>();
  private closed = false;
  constructor(private readonly dbPath: string) {}

  get(date: string, agent?: string): Promise<Result> {
    if (this.closed) return Promise.reject(new Error('Model statistics worker closed'));
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (agent !== undefined && (typeof agent !== 'string' || agent.length > 128))) return Promise.reject(new Error('Invalid daily statistics parameters'));
    const key = JSON.stringify([date, agent || 'all']);
    const pending = this.active.get(key);
    if (pending) return pending.promise;
    if (this.active.size >= 4) return Promise.reject(new Error('Too many model statistics requests'));
    const worker = new Worker(path.join(__dirname, 'day-model-worker.js'), { workerData: { dbPath: this.dbPath, date, agent } });
    let cancel!: () => void;
    const promise = new Promise<Result>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, result?: Result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.active.delete(key); void worker.terminate();
        if (error) reject(error); else resolve(result!);
      };
      const timer = setTimeout(() => finish(new Error('Model statistics timed out')), 30_000);
      cancel = () => finish(new Error('Model statistics worker closed'));
      worker.on('message', message => message.error ? finish(new Error(message.error)) : finish(undefined, message.result as Result));
      worker.on('error', error => finish(error));
      worker.on('exit', code => finish(new Error(`Model statistics worker stopped (${code})`)));
    });
    this.active.set(key, { worker, promise, cancel });
    return promise;
  }

  close(): void {
    this.closed = true;
    for (const work of this.active.values()) work.cancel();
    this.active.clear();
  }
}
