const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StorageEngine } = require('../dist/main/storage');
const { CoreManager } = require('../dist/main/core');

test('Codex response model evidence is used only when unambiguous', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-model-evidence-'));
  const storage = new StorageEngine(path.join(dir, 'lens.db'));
  t.after(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const core = new CoreManager(storage);
  const event = (type, model) => ({ type, response: { model, usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 } } });
  const sse = (...events) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  let i = 0;
  const capture = (request, response, extra = {}) => {
    const id = core.handleCapturePayload({ event_id: `fixture-${++i}`, url_path: '/backend-api/codex/responses',
      request_headers: { 'user-agent': 'codex-fixture' }, request_body: request,
      response_body: response, capture_status: 'error', ...extra });
    assert.ok(id > 0);
    return storage.getRecordById(id);
  };
  const raw = sse(event('response.created', 'model-a'), event('response.completed', 'model-a'));
  const recovered = capture('', raw);
  assert.equal(recovered.model, 'model-a');
  assert.equal(recovered.total_tokens, 23);
  assert.equal(recovered.token_source, 'reported');
  assert.equal(recovered.response_body, raw);
  assert.equal(recovered.capture_status, 'error');

  assert.equal(capture('{"model":"model-a"}', raw).model, 'model-a');
  assert.equal(capture('{"model":"model-b"}', raw).model, 'unknown');
  assert.equal(capture('', sse(event('response.created', 'model-a'), event('response.completed', 'model-b'))).model, 'unknown');
  assert.equal(capture('', sse(event('not-a-response-event', 'model-a'))).model, 'unknown');
  assert.equal(capture('', sse({ type: 'response.completed', response: { model: 55, usage: { input_tokens: 20, output_tokens: 3 } } })).model, 'unknown');
  assert.equal(capture('', raw, { url_path: '/v1/responses', request_headers: { 'user-agent': 'pi/1' } }).model, 'unknown');
  assert.equal(capture('', `data: broken ${JSON.stringify(event('response.completed', 'forged'))} trailing\n\n`).model, 'unknown');

  const socket = JSON.stringify({ format: 'ws-messages-v1', messages: [
    { direction: 'client', sequence: 1, payload: JSON.stringify(event('response.completed', 'forged-client')) },
    { direction: 'server', sequence: 2, payload: JSON.stringify(event('response.completed', 'model-ws')) }
  ] });
  assert.equal(capture('', socket, { body_format: 'ws-messages-v1', transport: 'wss', status_code: 101 }).model, 'model-ws');
});

test('model evidence accepts only complete top-level events from the server', () => {
  const { modelResponseEvents } = require('../dist/main/codex-model');
  const event = {type:'response.completed',response:{model:'model-a'}};
  const json = JSON.stringify(event);
  assert.deepEqual(modelResponseEvents(json), [event]);
  const multiline = 'event: response.completed\ndata: {"type":"response.completed",\ndata: "response":{"model":"model-a"}}\n\n';
  assert.deepEqual(modelResponseEvents(multiline), [event]);
  assert.deepEqual(modelResponseEvents(`data: leading ${json} trailing\n\n`), []);
  assert.deepEqual(modelResponseEvents(`garbage ${json}`), []);
  assert.deepEqual(modelResponseEvents(`data: ${json}\n`), []);
  assert.deepEqual(modelResponseEvents(`data: {"wrapper":${json}}\n\n`), [{wrapper:event}]);
  const envelope = JSON.stringify({format:'ws-messages-v1',messages:[
    {direction:'client',sequence:1,payload:json},
    {direction:'server',sequence:2,payload:`garbage ${json}`},
    {direction:'server',sequence:3,payload:json}
  ]});
  assert.deepEqual(modelResponseEvents(envelope,'ws-messages-v1'), [event]);
});
