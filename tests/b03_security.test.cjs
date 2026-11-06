const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { WebServer } = require('../dist/main/web');
const { CoreManager } = require('../dist/main/core');

test('WebServer blocks untrusted Origin and non-local Host headers with 403', async () => {
  let clearCalled = false;
  const web = new WebServer(
    { clearRecords: () => { clearCalled = true; } },
    { installToSystemStore: async () => ({ success: true }) },
    0
  );
  try {
    // 1. Hostile origin
    const res1 = await web.app.inject({
      method: 'POST',
      url: '/api/clear',
      headers: {
        host: '127.0.0.1',
        origin: 'https://malicious-website.com'
      }
    });
    assert.equal(res1.statusCode, 403);
    assert.equal(clearCalled, false);

    // 2. Hostile host header
    const res2 = await web.app.inject({
      method: 'POST',
      url: '/api/clear',
      headers: {
        host: 'attacker-controlled.domain'
      }
    });
    assert.equal(res2.statusCode, 403);
    assert.equal(clearCalled, false);

    // 3. Legitimate local request
    const res3 = await web.app.inject({
      method: 'POST',
      url: '/api/clear',
      headers: {
        host: '127.0.0.1'
      }
    });
    assert.equal(res3.statusCode, 200);
    assert.equal(clearCalled, true);
  } finally {
    await web.stop();
  }
});

test('CoreManager receiver preserves UTF-8 split across TCP chunks and only ACKs on success', async () => {
  const inserts = [];
  let simulateDiskFailure = false;

  const mockStorage = {
    insertRecord: (rec) => {
      if (simulateDiskFailure) {
        throw new Error('synthetic sqlite io failure');
      }
      inserts.push(rec);
      return inserts.length;
    }
  };

  const manager = new CoreManager(mockStorage, {
    receiverPort: 0,
    secret: 'test-secret-12345'
  });

  await manager.startReceiver();
  const port = manager.receiverServer.address().port;

  const send = (data, options = {}) => new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': options.contentType || 'application/json',
      'Content-Length': data.length
    };
    if (options.secret) {
      headers['X-Prompt-Lens-Secret'] = options.secret;
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/capture',
      headers
    }, res => {
      let resBody = '';
      res.on('data', d => { resBody += d; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: resBody }));
    });
    req.on('error', reject);

    if (options.splitIndex) {
      req.write(data.subarray(0, options.splitIndex));
      setTimeout(() => req.end(data.subarray(options.splitIndex)), 20);
    } else {
      req.end(data);
    }
  });

  try {
    const rawPayload = {
      url_path: '/v1internal:generateContent?key=AIzaSySecretToken',
      method: 'POST',
      status_code: 200,
      duration_ms: 100,
      request_headers: {
        authorization: 'Bearer super-secret-api-token',
        cookie: 'session_id=secret_cookie_val',
        'x-api-key': 'secret-x-key',
        'user-agent': 'Antigravity/2.15.0'
      },
      request_body: JSON.stringify({
        model: 'gemini-1.5-pro',
        contents: [{ role: 'user', parts: [{ text: '这是一段包含中文字符的测试提问' }] }]
      }),
      response_body: JSON.stringify({
        candidates: [{ content: { parts: [{ text: '好的，收到！' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
      })
    };

    const payloadBuf = Buffer.from(JSON.stringify(rawPayload), 'utf8');

    // 1. Unauthorized request (missing secret) -> 401
    const unauthRes = await send(payloadBuf);
    assert.equal(unauthRes.statusCode, 401);
    assert.equal(inserts.length, 0);

    // 2. Split UTF-8 across chunk boundary right in the middle of "中文"
    const splitOffset = payloadBuf.indexOf(Buffer.from('中文字符')) + 1; // splits the 3-byte '中'
    const validRes = await send(payloadBuf, {
      secret: 'test-secret-12345',
      splitIndex: splitOffset
    });
    assert.equal(validRes.statusCode, 200);
    assert.equal(inserts.length, 1);
    // Verify UTF-8 integrity: MUST NOT contain replacement characters
    assert.ok(inserts[0].user_prompt.includes('中文字符'), `Prompt corrupted: ${inserts[0].user_prompt}`);
    // Verify header sanitization
    assert.equal(inserts[0].request_headers.authorization, 'Bearer [REDACTED]');
    assert.equal(inserts[0].request_headers.cookie, '[REDACTED]');
    assert.equal(inserts[0].request_headers['x-api-key'], '[REDACTED]');

    // 3. Malformed JSON payload -> 400 Bad Request
    const badJsonRes = await send(Buffer.from('{ malformed json'), { secret: 'test-secret-12345' });
    assert.equal(badJsonRes.statusCode, 400);

    // 4. Persistence failure -> 500 Internal Server Error (NOT 200 ACK!)
    simulateDiskFailure = true;
    const diskFailRes = await send(payloadBuf, { secret: 'test-secret-12345' });
    assert.equal(diskFailRes.statusCode, 500);
    assert.equal(inserts.length, 1); // No phantom inserts
  } finally {
    await new Promise(r => manager.receiverServer.close(r));
  }
});

test('WebServer API endpoints enforce authentication and bootstrap session cookies', async () => {
  const secret = 'ultra-secure-test-secret-42';
  let cleared = false;
  const web = new WebServer(
    { clearRecords: () => { cleared = true; } },
    { installToSystemStore: async () => ({ success: true }) },
    0,
    { getStatus: () => ({ isCoreRunning: true, listenPort: 8899 }) },
    secret
  );

  try {
    // 1. Health check is always public
    const resHealth = await web.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1' }
    });
    assert.equal(resHealth.statusCode, 200);

    // 2. Unauthenticated request to /api/clear is blocked
    const resUnauth = await web.app.inject({
      method: 'POST',
      url: '/api/clear',
      headers: { host: '127.0.0.1' }
    });
    assert.equal(resUnauth.statusCode, 401);
    assert.equal(cleared, false);

    // 3. Wrong secret is blocked
    const resWrong = await web.app.inject({
      method: 'POST',
      url: '/api/clear',
      headers: {
        host: '127.0.0.1',
        'x-prompt-lens-secret': 'wrong-secret'
      }
    });
    assert.equal(resWrong.statusCode, 401);
    assert.equal(cleared, false);

    // 4. Authenticated via Header 'x-prompt-lens-secret'
    const resHeader = await web.app.inject({
      method: 'POST',
      url: '/api/clear',
      headers: {
        host: '127.0.0.1',
        'x-prompt-lens-secret': secret
      }
    });
    assert.equal(resHeader.statusCode, 200);
    assert.equal(cleared, true);
    cleared = false;

    // 5. Authenticated via Bearer token
    const resBearer = await web.app.inject({
      method: 'POST',
      url: '/api/clear',
      headers: {
        host: '127.0.0.1',
        authorization: `Bearer ${secret}`
      }
    });
    assert.equal(resBearer.statusCode, 200);
    assert.equal(cleared, true);
    cleared = false;

    // 6. Authenticated via Cookie
    const resCookie = await web.app.inject({
      method: 'POST',
      url: '/api/clear',
      headers: {
        host: '127.0.0.1',
        cookie: `prompt_lens_token=${secret}; other_cookie=val`
      }
    });
    assert.equal(resCookie.statusCode, 200);
    assert.equal(cleared, true);
    cleared = false;

    // 7. Cookie bootstrap on visiting root with ?token=
    const resBootstrap = await web.app.inject({
      method: 'GET',
      url: `/?token=${secret}`,
      headers: { host: '127.0.0.1' }
    });
    const setCookie = resBootstrap.headers['set-cookie'];
    assert.ok(setCookie, 'Expected set-cookie header');
    assert.ok(setCookie.includes(`prompt_lens_token=${secret}`), 'Expected token in cookie');
    assert.ok(setCookie.includes('HttpOnly'), 'Expected HttpOnly');
    assert.ok(setCookie.includes('SameSite=Strict'), 'Expected SameSite=Strict');
  } finally {
    await web.stop();
  }
});
