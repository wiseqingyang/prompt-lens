const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { StorageEngine } = require('../dist/main/storage');
const { CoreManager } = require('../dist/main/core');

test('CoreManager and StorageEngine sustain concurrent high-frequency capture events cleanly', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-smoke-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const tmpDbPath = path.join(tmpDir, 'lens.db');
  const storage = new StorageEngine(tmpDbPath);

  const secret = 'smoke-secret-key-123';
  const core = new CoreManager(storage, {
    listenPort: 28899,
    receiverPort: 0,
    secret
  });

  try {
    await core['startReceiver']();
    const receiverPort = core['receiverServer'].address().port;
    const totalRequests = 40;
    const promises = [];

    for (let i = 1; i <= totalRequests; i++) {
      const payload = JSON.stringify({
        event_id: `evt-${i}`,
        request_id: `req-${i}`,
        sequence: 1,
        url_path: '/v1internal:generateContent',
        status_code: i % 10 === 0 ? 500 : 200,
        method: 'POST',
        request_headers: {
          authorization: `Bearer token-${i}`,
          'content-type': 'application/json'
        },
        request_body: JSON.stringify({
          model: 'gemini-2.5-pro',
          contents: [{ role: 'user', parts: [{ text: `User request #${i}` }] }]
        }),
        response_body: `data: {"response":{"candidates":[{"content":{"parts":[{"text":"Response #${i}"}]}}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20,"totalTokenCount":120,"cachedContentTokenCount":10}}}\n\n`
      });

      const p = new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: receiverPort,
          path: '/api/capture',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-prompt-lens-secret': secret
          }
        }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            assert.equal(res.statusCode, 200);
            resolve(JSON.parse(body));
          });
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      promises.push(p);
    }

    const results = await Promise.all(promises);
    assert.equal(results.length, totalRequests);

    // Drain
    await core.drain(2000);

    // Verify storage counts
    const stats = storage.getStats();
    assert.equal(stats.total_requests, totalRequests);

    // Verify sanitized headers in DB
    const firstRecord = storage.getRecordById(1);
    assert.ok(firstRecord);
    assert.equal(firstRecord.request_headers['authorization'], 'Bearer [REDACTED]');
    assert.equal(firstRecord.token_source, 'reported');

    // Verify queue stats
    const queue = storage.getTruncatedAndDroppedStats();
    assert.equal(queue.totalRecords, totalRequests);
    assert.equal(queue.errorCount, 4); // 10, 20, 30, 40 are status 500
  } finally {
    await core.stop();
    storage.close();
  }
});
