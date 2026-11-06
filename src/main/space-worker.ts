import Database from 'better-sqlite3';
import { workerData } from 'worker_threads';
import { ContentStore } from './content-store';
const db = new Database(workerData.dbPath);
try {
  db.pragma('busy_timeout = 5000');
  const store = new ContentStore(db);
  while (store.collectGarbage()) { /* reclaim only unreferenced content */ }
  db.pragma('auto_vacuum = INCREMENTAL');
  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
} finally { db.close(); }
