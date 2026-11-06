const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebServer } = require('../dist/main/web');
const { assertTrustedSender, assertIpcArguments } = require('../dist/main/desktop-security');

test('IPC accepts the known top frame and rejects other frames, windows and malformed arguments', () => {
  const frame = { url: 'http://127.0.0.1:8088/' };
  const event = { sender: { id: 7, mainFrame: frame }, senderFrame: frame };
  assert.doesNotThrow(() => assertTrustedSender(event, 7, 'http://127.0.0.1:8088'));
  assert.throws(() => assertTrustedSender(event, 8, 'http://127.0.0.1:8088'), /Untrusted/);
  assert.throws(() => assertTrustedSender({ ...event, senderFrame: { ...frame } }, 7, 'http://127.0.0.1:8088'), /Untrusted/);
  frame.url = 'https://example.invalid/';
  assert.throws(() => assertTrustedSender(event, 7, 'http://127.0.0.1:8088'), /Untrusted/);
  assert.doesNotThrow(() => assertIpcArguments('api:get-record-detail', [1]));
  assert.throws(() => assertIpcArguments('api:get-record-detail', ['1']), /Invalid/);
  assert.throws(() => assertIpcArguments('api:get-records-by-ids', [[-1], {}]), /Invalid/);
  assert.throws(() => assertIpcArguments('api:launch-agent', [{ agent: 'sh; echo unsafe' }]), /Invalid/);
  assert.throws(() => assertIpcArguments('api:unknown', []), /Invalid/);
});

test('control plane rejects cross-port origins, cookie substrings and API URL tokens', async t => {
  let cleared = 0;
  const secret = 'synthetic-control-secret';
  const web = new WebServer({ clearRecords() { cleared++; } }, {}, 8088, undefined, secret);
  t.after(() => web.stop());
  const request = headers => web.app.inject({ method: 'POST', url: '/api/clear', headers: { host: '127.0.0.1:8088', ...headers } });
  assert.equal((await request({ origin: 'http://127.0.0.1:9999', cookie: `prompt_lens_token=${secret}` })).statusCode, 403);
  for (const cookie of [`fake_prompt_lens_token=${secret}`, `prompt_lens_token=${secret}-suffix`]) {
    assert.equal((await request({ cookie })).statusCode, 401);
  }
  assert.equal((await web.app.inject({ method: 'POST', url: `/api/clear?token=${secret}`, headers: { host: '127.0.0.1:8088' } })).statusCode, 401);
  assert.equal(cleared, 0);
  assert.equal((await request({ origin: 'http://127.0.0.1:8088', cookie: `prompt_lens_token=${secret}` })).statusCode, 200);
  assert.equal(cleared, 1);
});

test('browser bootstrap redirects to a token-free URL with restrictive response headers', async t => {
  const web = new WebServer({}, {}, 8088, undefined, 'synthetic-bootstrap-secret');
  t.after(() => web.stop());
  const r = await web.app.inject({ url: '/?token=synthetic-bootstrap-secret', headers: { host: '127.0.0.1:8088' } });
  assert.equal(r.statusCode, 303);
  assert.equal(r.headers.location, '/');
  assert.match(r.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
});

test('HTTP rejects unbounded pagination and malformed records before accessing storage', async t => {
  const web = new WebServer({ getRecords() { throw new Error('must not be reached'); } }, {}, 0, undefined, 'synthetic-input-secret');
  t.after(() => web.stop());
  const headers = { host: 'localhost', 'x-prompt-lens-secret': 'synthetic-input-secret' };
  for (const url of ['/api/records?limit=-1', '/api/records?limit=100000', '/api/records?offset=-1', '/api/records/not-a-number', '/api/sessions?limit=100000']) {
    assert.equal((await web.app.inject({ url, headers })).statusCode, 400);
  }
  assert.equal((await web.app.inject({ method: 'POST', url: '/api/records/batch', headers, payload: { ids: [-1] } })).statusCode, 400);
  assert.equal((await web.app.inject({ method: 'POST', url: '/api/config', headers, payload: { proxy: { listenPort: 8088 } } })).statusCode, 400);
});
