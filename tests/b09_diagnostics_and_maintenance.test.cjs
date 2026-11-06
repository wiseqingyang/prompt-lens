const { temporaryDatabase } = require('./fixtures.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { StorageEngine } = require('../dist/main/storage');
const { CertManager } = require('../dist/main/cert');
const { WebServer } = require('../dist/main/web');

test('StorageEngine enforces standard directory with secure permissions (0700/0600)', () => {
  const tmpBase = path.join(os.tmpdir(), `prompt-lens-test-dir-${Date.now()}`);
  const tmpDbPath = path.join(tmpBase, 'lens.db');

  try {
    const storage = new StorageEngine(tmpDbPath);
    assert.equal(fs.existsSync(tmpDbPath), true);

    const dirStat = fs.statSync(tmpBase);
    // mode on POSIX should be 0700
    if (process.platform !== 'win32') {
      assert.equal(dirStat.mode & 0o777, 0o700);
      const fileStat = fs.statSync(tmpDbPath);
      assert.equal(fileStat.mode & 0o777, 0o600);
    }
    storage.close();
  } finally {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  }
});

test('StorageEngine scans unredacted historical records and performs in-place sanitization', (t) => {
  const tmpDbPath = temporaryDatabase(t);
  const storage = new StorageEngine(tmpDbPath);

  try {
    // 1. Insert dirty unredacted record (legacy)
    const dirtyId = storage.insertRecord({
      session_id: 'legacy-sess',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 500,
      request_headers: {
        authorization: 'Bearer ya29.very-secret-token-12345',
        cookie: 'user_session=super_secret_cookie_data',
        'x-api-key': 'ai-za-sy-12345-secret', // gitleaks:allow -- synthetic API key for header redaction test
        'content-type': 'application/json'
      }
    });

    // 2. Insert already clean record
    const cleanId = storage.insertRecord({
      session_id: 'clean-sess',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 300,
      request_headers: {
        authorization: 'Bearer [REDACTED]',
        'content-type': 'application/json'
      }
    });

    // 3. Scan
    const scanBefore = storage.scanSensitiveRecords();
    assert.equal(scanBefore.totalScanned, 2);
    assert.equal(scanBefore.sensitiveCount, 1);
    assert.deepEqual(scanBefore.recordIds, [dirtyId]);

    // 4. Sanitize
    const sanitizeResult = storage.sanitizeHistoricalRecords();
    assert.equal(sanitizeResult.sanitizedCount, 1);

    // 5. Scan again, must be 0
    const scanAfter = storage.scanSensitiveRecords();
    assert.equal(scanAfter.sensitiveCount, 0);

    // 6. Verify contents of dirty record are safely redacted
    const record = storage.getRecordById(dirtyId);
    assert.equal(record.request_headers['authorization'], 'Bearer [REDACTED]');
    assert.equal(record.request_headers['cookie'], '[REDACTED]');
    assert.equal(record.request_headers['x-api-key'], '[REDACTED]');
    assert.equal(record.request_headers['content-type'], 'application/json');
  } finally {
    storage.close();
    try { fs.unlinkSync(tmpDbPath); } catch {}
  }
});

test('WebServer diagnostics endpoint returns engine status, certificate fingerprint and queue health', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-diag-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const tmpDbPath = path.join(tmpDir, 'lens.db');
  const storage = new StorageEngine(tmpDbPath);
  const certMgr = new CertManager(tmpDir);

  // Insert mock truncated and errored records
  storage.insertRecord({
    session_id: 'err-sess',
    agent_name: 'Antigravity',
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    method: 'POST',
    url_path: '/v1internal:generateContent',
    status_code: 502,
    capture_status: 'truncated',
    duration_ms: 100
  });

  const mockCore = {
    getStatus: () => ({
      listenPort: 8899,
      upstream: 'http://127.0.0.1:7890',
      isCoreRunning: true,
      status: 'auditing'
    })
  };

  const web = new WebServer(storage, certMgr, 0, mockCore);

  try {
    const res = await web.app.inject({
      method: 'GET',
      url: '/api/diagnostics',
      headers: { host: '127.0.0.1' }
    });

    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);

    assert.equal(data.core.status, 'auditing');
    assert.equal(data.core.listenPort, 8899);
    assert.ok(data.cert.fingerprint.length > 0);
    assert.equal(data.queue.truncatedCount, 1);
    assert.equal(data.queue.errorCount, 1);
    assert.equal(data.recentErrors.length, 1);
    assert.equal(data.recentErrors[0].status_code, 502);
  } finally {
    await web.stop();
    storage.close();
    try { fs.unlinkSync(tmpDbPath); } catch {}
  }
});

test('StorageEngine pruneOldRecords cleans up old records based on retention days and clearing content preserves history and usage', (t) => {
  const tmpDbPath = temporaryDatabase(t);
  const storage = new StorageEngine(tmpDbPath);

  try {
    const r1 = storage.insertRecord({
      session_id: 'old-sess-native',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 100
    });

    const r2 = storage.insertRecord({
      session_id: 'old-sess-iso',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 100
    });

    const r3 = storage.insertRecord({
      session_id: 'new-sess',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 100
    });

    storage.db.prepare("UPDATE records SET created_at = datetime('now', '-10 days') WHERE id = ?").run(r1);
    storage.db.prepare("UPDATE records SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(r2);

    const pruneRes = storage.pruneOldRecords(7);
    assert.equal(pruneRes.deleted, 2);

    assert.equal(storage.getRecordById(r1), null);
    assert.equal(storage.getRecordById(r2), null);
    assert.ok(storage.getRecordById(r3) !== null);

    assert.equal(storage.pruneOldRecords(0).deleted, 0);
    assert.equal(storage.pruneOldRecords(-5).deleted, 0);
    assert.equal(storage.pruneOldRecords(NaN).deleted, 0);

    storage.clearRecords();
    assert.equal(storage.getRecordById(r3).raw_pruned, true);
    assert.equal(storage.getStats().total_requests, 3);
    storage.deleteAllData();
    assert.equal(storage.getRecordById(r3), null);
    assert.equal(storage.getStats().total_requests, 0);
  } finally {
    storage.close();
    try { fs.unlinkSync(tmpDbPath); } catch {}
  }
});

test('StorageEngine transparently compresses large bodies and compactDatabase frees space', (t) => {
  const tmpDbPath = temporaryDatabase(t);
  const storage = new StorageEngine(tmpDbPath);

  try {
    const bigPayload = JSON.stringify({
      messages: Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `This is a test prompt turn #${i} with lots of repeating text to verify compression efficiency. `.repeat(10)
      }))
    });

    const id = storage.insertRecord({
      session_id: 'compress-sess',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 150,
      request_body: bigPayload,
      response_body: bigPayload
    });

    // Migration moves payloads into shared compressed blocks, verified before old columns release.
    assert.equal(storage.migrateContentBatch(), 1);
    // 1. Verify old columns are released and shared compressed storage is smaller.
    const rawRow = storage.db.prepare('SELECT request_body, response_body FROM records WHERE id = ?').get(id);
    assert.equal(rawRow.request_body, '');
    const stored = storage.db.prepare('SELECT SUM(length(data)) bytes FROM content_blocks').get().bytes;
    assert.ok(stored < bigPayload.length / 2, 'shared compressed blocks should be at least 50% smaller');

    // 2. Verify getRecordById transparently decompresses to original string
    const loaded = storage.getRecordById(id);
    assert.equal(loaded.request_body, bigPayload);
    assert.equal(loaded.response_body, bigPayload);

    // 3. Test compactDatabase
    const compactResult = storage.compactDatabase();
    assert.ok(compactResult.beforeBytes > 0);
    assert.ok(compactResult.afterBytes > 0);
    assert.ok(typeof compactResult.savedBytes === 'number');

    // 4. Verify data is still intact after compactDatabase
    const afterCompact = storage.getRecordById(id);
    assert.equal(afterCompact.request_body, bigPayload);
  } finally {
    storage.close();
    try { fs.unlinkSync(tmpDbPath); } catch {}
  }
});

test('StorageEngine getRecordsByIds batch retrieval, checkpoint, and >5MB truncation guard', (t) => {
  const tmpDbPath = temporaryDatabase(t);
  const storage = new StorageEngine(tmpDbPath);

  try {
    const ids = [];
    for (let i = 1; i <= 5; i++) {
      const id = storage.insertRecord({
        session_id: 'batch-sess',
        agent_name: 'Antigravity',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        method: 'POST',
        url_path: '/v1internal:generateContent',
        status_code: 200,
        duration_ms: 100 * i,
        request_body: JSON.stringify({ prompt: `Turn ${i} `.repeat(50) }),
        response_body: JSON.stringify({ reply: `Answer ${i} `.repeat(50) }),
        input_tokens: 100 * i,
        output_tokens: 50 * i,
        total_tokens: 150 * i
      });
      ids.push(id);
    }

    // 1. Batch retrieval via getRecordsByIds
    // Default lightweight mode: does NOT include heavy raw bodies to save memory & IPC bandwidth
    const batchRecords = storage.getRecordsByIds(ids);
    assert.equal(batchRecords.length, 5);
    assert.equal(batchRecords[0].id, ids[0]);
    assert.equal(batchRecords[0].request_body, '', 'default batch mode must omit heavy raw bodies');

    // On-demand mode: includeRawBody: true loads decompressed raw bodies
    const batchRecordsWithRaw = storage.getRecordsByIds(ids, { includeRawBody: true });
    assert.equal(batchRecordsWithRaw.length, 5);
    assert.ok(batchRecordsWithRaw[0].request_body.includes('Turn 1'), 'raw mode must decompress bodies');

    // 2. Checkpoint truncation works cleanly
    storage.checkpoint();
    const walFile = tmpDbPath + '-wal';
    if (fs.existsSync(walFile)) {
      assert.equal(fs.statSync(walFile).size, 0);
    }

    // 3. >5MB application payload is preserved; transport owns audit budgets
    const hugeStr = 'X'.repeat(6 * 1024 * 1024); // 6MB
    const hugeId = storage.insertRecord({
      session_id: 'huge-sess',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 500,
      request_body: hugeStr,
      response_body: 'normal'
    });
    const hugeRec = storage.getRecordById(hugeId);
    assert.equal(hugeRec.request_body, hugeStr);
  } finally {
    storage.close();
    try { fs.unlinkSync(tmpDbPath); } catch {}
  }
});

test('StorageEngine cold-hot payload dehydration prunes historical raw bodies while keeping analytics intact', (t) => {
  const tmpDbPath = temporaryDatabase(t);
  const storage = new StorageEngine(tmpDbPath);

  try {
    const payload = JSON.stringify({ longText: 'Repeat payload '.repeat(200) });

    // Insert a "cold" record (created 5 days ago)
    const coldId = storage.insertRecord({
      session_id: 'cold-sess',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 1200,
      input_tokens: 5000,
      output_tokens: 300,
      total_tokens: 5300,
      user_prompt: '请分析这个代码库的架构',
      response_preview: '该项目采用分层架构...',
      prompt_summary: '架构分析',
      request_body: payload,
      response_body: payload
    });

    // Manually backdate cold record to 5 days ago in SQLite
    storage.db.prepare("UPDATE records SET created_at = datetime('now', '-5 days') WHERE id = ?").run(coldId);

    // Insert a "hot" record (recent today)
    const hotId = storage.insertRecord({
      session_id: 'hot-sess',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 800,
      input_tokens: 2000,
      output_tokens: 150,
      total_tokens: 2150,
      user_prompt: '最新一轮提示词',
      response_preview: '最新回复内容',
      prompt_summary: '最新提示词',
      request_body: payload,
      response_body: payload
    });

    // Run compactDatabase with prunePayloadsDays: 3 (prunes records older than 3 days)
    const res = storage.pruneHistoricalPayloads(3);
    assert.equal(res.pruned, 1);
    assert.equal(storage.compactDatabase({ prunePayloadsDays: 1 }).prunedPayloadsCount, 0, 'reclaim must not expire payloads');

    // Check cold record: raw bodies dehydrated to empty string, but analytics and prompts are 100% intact!
    const coldRec = storage.getRecordById(coldId);
    assert.equal(coldRec.request_body, '', 'cold raw request_body must be pruned to empty');
    assert.equal(coldRec.response_body, '', 'cold raw response_body must be pruned to empty');
    assert.equal(coldRec.user_prompt, '请分析这个代码库的架构', 'user_prompt must remain untouched');
    assert.equal(coldRec.response_preview, '该项目采用分层架构...', 'response_preview must remain untouched');
    assert.equal(coldRec.prompt_summary, '架构分析', 'prompt_summary must remain untouched');
    assert.equal(coldRec.total_tokens, 5300, 'total_tokens must remain untouched');
    assert.equal(coldRec.duration_ms, 1200, 'duration_ms must remain untouched');

    // Check hot record: completely untouched with raw payload preserved
    const hotRec = storage.getRecordById(hotId);
    assert.equal(hotRec.request_body, payload, 'hot request_body must be kept intact');
    assert.equal(hotRec.response_body, payload, 'hot response_body must be kept intact');
  } finally {
    storage.close();
    try { fs.unlinkSync(tmpDbPath); } catch {}
  }
});

test('StorageEngine correctly decompresses compressed BLOB during startup backfill of response_text', (t) => {
  const tmpDbPath = temporaryDatabase(t);
  let storage = new StorageEngine(tmpDbPath);

  try {
    const longReply = 'Backfilled model reply from compressed BLOB. '.repeat(20);
    const rawRes = JSON.stringify({
      candidates: [{
        content: {
          parts: [{ text: longReply }]
        }
      }]
    });

    // Insert record
    const id = storage.insertRecord({
      session_id: 'blob-sess',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 200,
      response_body: rawRes
    });

    // Force response_text to empty in SQLite
    storage.db.prepare("UPDATE records SET response_text = '' WHERE id = ?").run(id);

    // An explicit legacy BLOB fixture verifies the old format after upgrade.
    storage.db.prepare('UPDATE records SET response_body = ? WHERE id = ?').run(require('node:zlib').deflateRawSync(Buffer.from(rawRes)), id);
    // Verify it is compressed Buffer in SQLite
    const row = storage.db.prepare('SELECT response_body, response_text FROM records WHERE id = ?').get(id);
    assert.equal(row.response_text, '');
    assert.ok(Buffer.isBuffer(row.response_body));

    // Close and reopen to trigger startup backfill
    storage.close();

    const reopenedStorage = new StorageEngine(tmpDbPath);
    try {
      const backfilledRec = reopenedStorage.db.prepare('SELECT response_text FROM records WHERE id = ?').get(id);
      assert.equal(backfilledRec.response_text, longReply);
    } finally {
      reopenedStorage.close();
    }
  } finally {
    try { fs.unlinkSync(tmpDbPath); } catch {}
  }
});

test('normalizeRetentionDays strictly rejects Infinity, negative and NaN while accepting valid numbers', () => {
  const { normalizeRetentionDays } = require('../dist/main/config');

  assert.equal(normalizeRetentionDays(Infinity), 0);
  assert.equal(normalizeRetentionDays(-Infinity), 0);
  assert.equal(normalizeRetentionDays('Infinity'), 0);
  assert.equal(normalizeRetentionDays('-Infinity'), 0);
  assert.equal(normalizeRetentionDays(NaN), 0);
  assert.equal(normalizeRetentionDays('NaN'), 0);
  assert.equal(normalizeRetentionDays(-5), 0);
  assert.equal(normalizeRetentionDays('-5'), 0);
  assert.equal(normalizeRetentionDays('  '), 0);
  assert.equal(normalizeRetentionDays(undefined), 0);
  assert.equal(normalizeRetentionDays(null), 0);

  assert.equal(normalizeRetentionDays(0), 0);
  assert.equal(normalizeRetentionDays(7), 7);
  assert.equal(normalizeRetentionDays(3.9), 3);
  assert.equal(normalizeRetentionDays('30'), 30);
  assert.equal(normalizeRetentionDays(' 14 '), 14);
});

test('compressBody preserves massive UTF-8 application payloads exactly', () => {
  const { compressBody, decompressBody } = require('../dist/main/storage');

  // Multi-byte Chinese character (3 bytes in UTF-8)
  const sampleChar = '大';
  // Generate a string that exceeds 5MB in UTF-8 bytes
  const repeatCount = 2 * 1024 * 1024; // ~6MB in UTF-8 bytes
  const largeStr = sampleChar.repeat(repeatCount);

  assert.ok(Buffer.byteLength(largeStr, 'utf8') > 5 * 1024 * 1024);

  const truncatedBufferOrStr = compressBody(largeStr);
  const decompressed = decompressBody(truncatedBufferOrStr);

  assert.equal(decompressed, largeStr);
  // Ensure UTF-8 characters on both sides are valid and not corrupted
  assert.ok(!decompressed.includes('\uFFFD'), 'Truncation must not produce invalid unicode replacement characters');
  assert.equal(Buffer.byteLength(decompressed, 'utf8'), Buffer.byteLength(largeStr, 'utf8'));
});

test('StorageEngine tracks dataVersion and getCachedTaskClusters serves tasks with zero redundant scan', (t) => {
  const { getCachedTaskClusters, clearTaskClustersCache } = require('../dist/main/session');
  const tmpDbPath = temporaryDatabase(t);
  const storage = new StorageEngine(tmpDbPath);

  try {
    clearTaskClustersCache();
    const v1 = storage.getDataVersion();
    assert.equal(v1, 1);

    // Initial cache pull
    const tasks1 = getCachedTaskClusters(storage);
    assert.equal(tasks1.length, 0);

    // Insert record -> version must increment
    storage.insertRecord({
      session_id: 'cache-sess-1',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 300,
      user_prompt: '测试任务缓存',
      response_preview: '完成'
    });

    const v2 = storage.getDataVersion();
    assert.ok(v2 > v1, 'insertRecord must bump dataVersion');

    const tasks2 = getCachedTaskClusters(storage);
    assert.equal(tasks2.length, 1);

    // Same version -> must return identical reference instantly
    const tasks3 = getCachedTaskClusters(storage);
    assert.strictEqual(tasks2, tasks3, 'Subsequent calls without data changes must return cached reference directly');

    // Dehydration -> version bumps
    storage.pruneHistoricalPayloads(0);
    // Clearing records -> version bumps
    storage.clearRecords();
    const v3 = storage.getDataVersion();
    assert.ok(v3 > v2, 'clearRecords must bump dataVersion');

    const tasksAfterClear = getCachedTaskClusters(storage);
    assert.equal(tasksAfterClear.length, 1, 'lightweight history survives content clearing');
    storage.deleteAllData();
    assert.equal(getCachedTaskClusters(storage).length, 0);
  } finally {
    storage.close();
    try { fs.unlinkSync(tmpDbPath); } catch {}
  }
});

test('getRecordById and getRecordsByIds correctly mark raw_loaded and raw_pruned flags', (t) => {
  const tmpDbPath = temporaryDatabase(t);
  const storage = new StorageEngine(tmpDbPath);

  try {
    const rawReq = JSON.stringify({ prompt: 'hello world' });
    const rawRes = JSON.stringify({ reply: 'welcome' });

    const id = storage.insertRecord({
      session_id: 'flags-sess-1',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 100,
      user_prompt: 'hello world',
      response_preview: 'welcome',
      request_body: rawReq,
      response_body: rawRes
    });

    // 1. Lightweight batch retrieval -> raw_loaded must be false
    const lightList = storage.getRecordsByIds([id], { includeRawBody: false });
    assert.equal(lightList.length, 1);
    assert.equal(lightList[0].raw_loaded, false);
    assert.equal(lightList[0].request_body, '');
    assert.equal(lightList[0].response_body, '');

    // 2. Full batch retrieval -> raw_loaded must be true
    const fullList = storage.getRecordsByIds([id], { includeRawBody: true });
    assert.equal(fullList.length, 1);
    assert.equal(fullList[0].raw_loaded, true);
    assert.equal(fullList[0].raw_pruned, false);
    assert.equal(fullList[0].request_body, rawReq);
    assert.equal(fullList[0].response_body, rawRes);

    // 3. getRecordById -> raw_loaded must be true
    const detail = storage.getRecordById(id);
    assert.ok(detail);
    assert.equal(detail.raw_loaded, true);
    assert.equal(detail.raw_pruned, false);
    assert.equal(detail.request_body, rawReq);

    // 4. Backdate and prune payload
    storage.db.prepare("UPDATE records SET created_at = datetime('now', '-10 days') WHERE id = ?").run(id);
    storage.pruneHistoricalPayloads(5);

    const prunedDetail = storage.getRecordById(id);
    assert.ok(prunedDetail);
    assert.equal(prunedDetail.raw_loaded, true);
    assert.equal(prunedDetail.raw_pruned, true, 'Pruned record must have raw_pruned=true');
    assert.equal(prunedDetail.request_body, '');
  } finally {
    storage.close();
    try { fs.unlinkSync(tmpDbPath); } catch {}
  }
});

test('getCachedTaskClusters incrementally clusters only affected sessions when new records arrive', (t) => {
  const { getCachedTaskClusters, clearTaskClustersCache } = require('../dist/main/session');
  const tmpDbPath = temporaryDatabase(t);
  const storage = new StorageEngine(tmpDbPath);

  try {
    clearTaskClustersCache();

    // 1. Insert records for Session A and Session B
    storage.insertRecord({
      session_id: 'sess-A',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 150,
      user_prompt: 'Task A prompt 1',
      response_preview: 'Task A reply 1'
    });

    storage.insertRecord({
      session_id: 'sess-B',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 200,
      user_prompt: 'Task B prompt 1',
      response_preview: 'Task B reply 1'
    });

    const initialTasks = getCachedTaskClusters(storage);
    assert.equal(initialTasks.length, 2);
    const taskA1 = initialTasks.find((t) => t.session_id === 'sess-A');
    const taskB1 = initialTasks.find((t) => t.session_id === 'sess-B');
    assert.ok(taskA1 && taskB1);
    assert.equal(taskA1.turns.length, 1);
    assert.equal(taskB1.turns.length, 1);

    // 2. Incremental arrival: ONLY Session A receives a new turn
    storage.insertRecord({
      session_id: 'sess-A',
      agent_name: 'Antigravity',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      method: 'POST',
      url_path: '/v1internal:generateContent',
      status_code: 200,
      duration_ms: 180,
      user_prompt: 'Task A prompt 1', // same task, second turn
      response_preview: 'Task A reply 2'
    });

    const updatedTasks = getCachedTaskClusters(storage);
    assert.equal(updatedTasks.length, 2);
    const taskA2 = updatedTasks.find((t) => t.session_id === 'sess-A');
    const taskB2 = updatedTasks.find((t) => t.session_id === 'sess-B');

    assert.ok(taskA2);
    assert.equal(taskA2.turns.length, 2, 'Session A must be incrementally updated to 2 turns');
    // Session B's task object should be completely preserved from unaffected set
    assert.strictEqual(taskB1, taskB2, 'Unaffected Session B task object must remain completely preserved without re-cluster');
  } finally {
    storage.close();
    try { fs.unlinkSync(tmpDbPath); } catch {}
  }
});
