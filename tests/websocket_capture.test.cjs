const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { execFileSync, spawn } = require('node:child_process');
const { WebSocket, WebSocketServer } = require('ws');
const { StorageEngine } = require('../dist/main/storage');
const { CoreManager } = require('../dist/main/core');
const { WebServer } = require('../dist/main/web');

// Full transport -> authenticated receiver -> SQLite -> session API regression.
// Every process, listener, CA and database belongs to this test only.
test('WebSocket Responses reach storage and sessions before the socket closes', { timeout: 20000 }, async (t) => {
  const cleanup = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-websocket-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storage = new StorageEngine(path.join(dir, 'lens.db'));
  cleanup.push(() => storage.close());
  const core = new CoreManager(storage, { receiverPort: 0, secret: 'fixture-secret' });
  await core.startReceiver();
  cleanup.push(() => core.stop());
  const web = new WebServer(storage, {}, 0);
  cleanup.push(() => web.app.close());
  const origin = http.createServer();
  const wss = new WebSocketServer({ server: origin });
  wss.on('connection', socket => socket.on('message', data => {
    const request = JSON.parse(data);
    if (request.input === 'interrupted') { socket.terminate(); return; }
    socket.send(JSON.stringify({ type: 'response.completed', response: {
      id: `resp-${request.input}`, model: 'fixture-model', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `answer-${request.input}` }] }],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
    }}));
  }));
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { for (const c of wss.clients) c.terminate(); wss.close(); await new Promise(resolve => origin.close(resolve)); });
  const bin = path.join(dir, 'prompt-lens-core');
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: path.join(__dirname, '../core-go') });
  const child = spawn(bin, ['-port', '0', '-upstream', '', '-data-dir', dir,
    '-callback', `http://127.0.0.1:${core.receiverServer.address().port}/api/capture`],
    { env: { ...process.env, LLM_LENS_SECRET: 'fixture-secret' }, stdio: ['pipe', 'pipe', 'pipe'] });
  cleanup.push(async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit'); child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 2000);
    try { await exited; } finally { clearTimeout(timer); }
  });
  const proxyPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('isolated core readiness timeout')), 5000);
    let output = '';
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/LLM_LENS_CORE_READY 127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.on('error', err => { clearTimeout(timer); reject(err); });
  });
  const socket = new WebSocket(`ws://127.0.0.1:${proxyPort}/v1/responses`, { headers: {
    Host: `127.0.0.1:${origin.address().port}`, 'User-Agent': 'Codex Desktop/0.162.0-alpha.17.2',
    Authorization: 'Bearer fixture-only',
    'x-codex-turn-metadata': JSON.stringify({ thread_id: 'stale-handshake-thread', turn_id: 'stale-turn' })
  }});
  cleanup.push(() => socket.terminate());
  await once(socket, 'open');
  const waitForRows = async n => {
    const end = Date.now() + 4000;
    while (storage.getStats().total_requests < n) {
      if (Date.now() > end) throw new Error(`expected ${n} persisted captures`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  for (let i = 1; i <= 2; i++) {
    const reply = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'response.create', model: 'fixture-model', input: `question-${i}`, previous_response_id: i === 2 ? 'resp-question-1' : null,
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'fixture-thread', turn_id: `turn-${i}` }) } }));
    await reply; await waitForRows(i);
    const record = storage.getRecordById(i);
    assert.equal(record.status_code, 101);
    assert.equal(record.transport, 'ws');
    assert.equal(record.body_format, 'ws-messages-v1');
    const messages = JSON.parse(record.response_body).messages;
    assert.deepEqual(messages.map(m => m.direction), ['client','server']);
    assert.equal(messages[0].payload, record.request_body);
    assert.equal(JSON.parse(messages[1].payload).response.id, `resp-question-${i}`);
    assert.equal(record.response_id, `resp-question-${i}`);
    if(i === 2) assert.equal(storage.getRelatedHistory(i).messageCount, 2);
    assert.equal(record.capture_status, 'complete');
    assert.equal(record.agent_name, 'Codex');
    assert.equal(record.session_id, 'fixture-thread');
    assert.equal(record.turn_id, `turn-${i}`);
    assert.equal(record.total_tokens, 12);
    assert.equal(record.response_text, `answer-question-${i}`);
    assert.equal(record.request_headers.authorization, 'Bearer [REDACTED]');
  }
  assert.equal(socket.readyState, WebSocket.OPEN);
  const response = await web.app.inject({ method: 'GET', url: '/api/sessions' });
  const sessions = response.json().sessions;
  assert.equal(response.statusCode, 200);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].turns_count, 2);
  assert.equal(sessions[0].total_input_tokens + sessions[0].total_output_tokens, 24);
  assert.ok(sessions[0].tasks.every(task => task.turns.every(turn => turn.turn_type !== 'error')));
  socket.send(JSON.stringify({ type: 'response.create', model: 'fixture-model', input: 'interrupted' }));
  await once(socket, 'close'); await waitForRows(3);
  assert.equal(storage.getRecordById(3).capture_status, 'error');
  assert.equal(storage.getTruncatedAndDroppedStats().errorCount, 1);
});
