const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CertManager } = require('../dist/main/cert');

test('initialization does not copy another tools CA or private key', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-ca-isolation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.mitmproxy'));
  fs.writeFileSync(path.join(dir, '.mitmproxy/mitmproxy-ca.pem'), 'synthetic unrelated CA');
  const home = mock.method(os, 'homedir', () => dir);
  const reads = [];
  const original = fs.readFileSync;
  const read = mock.method(fs, 'readFileSync', function(p, ...args) { reads.push(String(p)); return original.call(this, p, ...args); });
  try {
    new CertManager(path.join(dir, 'lens')).ensureCertDir();
    assert.equal(reads.some(p => p.includes('.mitmproxy')), false);
  } finally { read.mock.restore(); home.mock.restore(); }
});

test('certificate status distinguishes absent, invalid, untrusted, trusted and unavailable trust checks', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-ca-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let result = 'trusted';
  const run = async (file, args) => { assert.equal(file, '/usr/bin/security'); assert.ok(args.includes('verify-cert')); if (result !== 'trusted') throw Object.assign(new Error('synthetic failure'), { code: result === 'untrusted' ? 1 : 'ENOENT' }); return { stdout: '', stderr: '' }; };
  const cert = new CertManager(dir, { platform: 'darwin', run });
  assert.equal((await cert.getStatus()).state, 'missing');
  fs.writeFileSync(path.join(dir, 'ca.crt'), 'not a certificate');
  assert.equal((await cert.getStatus()).state, 'invalid');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=synthetic-oss-ca', '-keyout', path.join(dir, 'test.key'), '-out', path.join(dir, 'ca.crt')], { stdio: 'ignore' });
  const valid = await cert.getStatus();
  assert.equal(valid.state, 'trusted');
  assert.match(valid.fingerprint, /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/);
  result = 'untrusted'; assert.equal((await cert.getStatus()).state, 'untrusted');
  result = 'unavailable'; assert.equal((await cert.getStatus()).state, 'unknown');
});
