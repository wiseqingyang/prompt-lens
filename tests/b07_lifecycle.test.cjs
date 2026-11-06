const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CoreManager } = require('../dist/main/core');

test('CoreManager drain waits for in-flight requests to finish before proceeding', async () => {
  let inserted = false;
  const mockStorage = {
    insertRecord: () => {
      inserted = true;
      return 1;
    }
  };

  const core = new CoreManager(mockStorage, {
    listenPort: 18899,
    receiverPort: 0,
    secret: 'test-secret'
  });

  await core['startReceiver']();
  const receiverPort = core['receiverServer'].address().port;

  try {
    const resPromise = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: receiverPort,
        path: '/api/capture',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-prompt-lens-secret': 'test-secret'
        }
      }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.write(JSON.stringify({
        event_id: "req-1",
        url_path: "/v1internal:generateContent",
        status_code: 200,
        method: "POST"
      }));
      req.end();
    });

    await resPromise;
    assert.equal(inserted, true);

    await core.drain(1000);
    assert.equal(core['inFlightCaptures'], 0);
  } finally {
    await core.stop();
  }
});

test('CoreManager stop shuts down receiver cleanly and idempotently', async () => {
  const core = new CoreManager({}, {
    listenPort: 18898,
    receiverPort: 0,
    secret: 'test-secret'
  });

  await core['startReceiver']();
  assert.equal(core['receiverServer'] !== null, true);

  await core.stop();
  assert.equal(core['receiverServer'], null);

  // Calling stop again should not throw
  await core.stop();
});

test('Go core binary terminates gracefully when parent process closes stdin (preventing orphan)', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-lifecycle-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const binPath = path.join(dataDir, 'prompt-lens-core');
  execFileSync('go', ['build', '-o', binPath, '.'], { cwd: path.join(__dirname, '../core-go') });

  // Spawn core with mock arguments
  const child = spawn(binPath, [
    '-port', '0',
    '-upstream', '',
    '-callback', '',
    '-data-dir', dataDir
  ], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });

  let started = false;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Go core ready timeout')), 5000);
    child.stdout.on('data', (data) => {
      const str = data.toString();
      if (str.includes('LLM_LENS_CORE_READY')) {
        started = true;
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  assert.equal(started, true);

  // Simulate parent crash / close by closing child stdin
  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });

  child.stdin.end();

  const { code, signal } = await Promise.race([
    exitPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Go core did not exit upon stdin EOF')), 4000))
  ]);

  // Code should be 0 (clean shutdown via server.Shutdown)
  assert.equal(code, 0);
});
