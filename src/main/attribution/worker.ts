import { parentPort, workerData } from 'node:worker_threads';
import { StorageEngine } from '../storage';

// The host has completed schema migration before starting this connection; never migrate here.
const storage = new StorageEngine(workerData.dbPath, { migrate: false });
const pending: { id: number; method: 'sessions' | 'collect'; root?: any; ids?: number[] }[] = [];
let running = false;
async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pending.length) {
      const sessionIndex = pending.findIndex(item => item.method === 'sessions');
      const message = pending.splice(sessionIndex >= 0 ? sessionIndex : 0, 1)[0];
      const before = storage.getDataVersion();
      try {
        const result = message.method === 'sessions' ? await storage.getAttributedSessions()
          : [...await storage.collectAttributionEvidence(message.root, message.ids)];
        parentPort!.postMessage({ id: message.id, result, changed: before !== storage.getDataVersion() });
      } catch (error) {
        parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : 'Attribution failed', changed: before !== storage.getDataVersion() });
      }
    }
  } finally {
    running = false;
  }
}
parentPort!.on('message', message => {
  pending.push(message);
  void drain();
});
parentPort!.on('close', () => storage.close());
