const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { buildProxyEnv } = require('../dist/main/proxy-env');

test('agent trust bundle accepts both untouched TLS and MITM TLS', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tls = require('node:tls');
  const { CertManager } = require('../dist/main/cert');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lens-trust-test-'));
  const servers = [];
  try {
    const config = path.join(dir, 'openssl.cnf');
    fs.writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\n');
    const createAuthority = name => {
      const keyPath = path.join(dir, name + '.key');
      const certPath = path.join(dir, name + '.pem');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=' + name, '-config', config, '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath, 'utf8') };
    };
    const normal = createAuthority('normal-site-test');
    const audit = createAuthority('prompt-lens-test');
    fs.writeFileSync(path.join(dir, 'ca.crt'), audit.cert);
    // A second local authority represents the normal site's system trust.
    // Production also retains all bundled public CAs without this mock.
    const systemRoots = mock.method(tls, 'getCACertificates', type => {
      assert.equal(type, 'system'); return [normal.cert];
    });
    let bundle;
    try { bundle = fs.readFileSync(new CertManager(dir).prepareAgentCaBundle(), 'utf8'); }
    finally { systemRoots.mock.restore(); }
    for (const root of tls.rootCertificates) assert.ok(bundle.includes(root.trim()), 'public root was lost');
    const startServer = async credentials => {
      const server = tls.createServer(credentials, socket => socket.end('trusted'));
      servers.push(server);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    };
    const check = (port, ca) => new Promise((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca });
      let body = '';
      socket.setTimeout(2000, () => socket.destroy(new Error('TLS test timed out')));
      socket.on('data', data => { body += data; });
      socket.on('end', () => resolve(body));
      socket.on('error', reject);
    });
    const normalPort = await startServer(normal);
    const auditPort = await startServer(audit);
    await assert.rejects(check(normalPort, audit.cert), /self-signed|unable to verify|unknown authority/i);
    assert.equal(await check(normalPort, bundle), 'trusted');
    assert.equal(await check(auditPort, bundle), 'trusted');
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('copied environment overrides both proxy cases and safely quotes the CA path', () => {
  const caPath = "/tmp/user's certs/$(false)/ca.crt";
  const caBundlePath = "/tmp/user's certs/$(false)/agent-ca-bundle.pem";
  const output = execFileSync('/bin/sh', ['-c', buildProxyEnv(8899, caPath, caBundlePath) + '\n/usr/bin/env -0'], {
    env: { PATH: '/usr/bin:/bin', https_proxy: 'http://stale:7890', no_proxy: '*', SSL_CERT_FILE: caPath, REQUESTS_CA_BUNDLE: caPath, CURL_CA_BUNDLE: caPath }
  });
  const env = Object.fromEntries(output.toString().split('\0').filter(Boolean).map(line => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  }));
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    assert.equal(env[name], 'http://127.0.0.1:8899');
  }
  assert.equal(env.NO_PROXY, env.no_proxy);
  assert.ok(env.NO_PROXY.includes('localhost:8897'));
  assert.ok(env.NO_PROXY.includes('[::1]:8897'));
  assert.ok(!env.NO_PROXY.includes('localhost,127.0.0.1'));
  assert.ok(!env.NO_PROXY.includes('localhost:20128'));
  assert.equal(env.NODE_EXTRA_CA_CERTS, caPath);
  for (const key of ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']) assert.equal(env[key], caBundlePath);
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
});

test('health reports core failure and UI returns the same command as the tray', async () => {
  const { WebServer } = require('../dist/main/web');
  let ready = false;
  const server = new WebServer({}, {
    getCertPaths: () => ({ caCertPath: '/tmp/test-ca.crt' }),
    prepareAgentCaBundle: () => '/tmp/test-ca-bundle.pem'
  }, 0, {
    getStatus: () => ({ isCoreRunning: ready, listenPort: 8899 })
  });
  try {
    let response = await server.app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 503);
    ready = true;
    response = await server.app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().engine, 'electron-go');
    response = await server.app.inject({ method: 'GET', url: '/api/proxy-env' });
    assert.equal(response.json().command, buildProxyEnv(8899, '/tmp/test-ca.crt', '/tmp/test-ca-bundle.pem'));
  } finally { await server.stop(); }
});

test('core starts only after readiness and rejects early exit or spawn errors', async () => {
  // No Electron UI, real child process or user CA is touched by this test.
  const Module = require('node:module');
  const childProcess = require('node:child_process');
  const fs = require('node:fs');
  const originalExists = fs.existsSync;
  const exists = mock.method(fs, 'existsSync', (file) => String(file).endsWith('/prompt-lens-core') || String(file).endsWith('/prompt-lens-core') || originalExists(file));
  const chmod = mock.method(fs, 'chmodSync', () => {});
  const originalLoad = Module._load;
  const loader = mock.method(Module, '_load', function(name, ...args) {
    if (name === 'electron') return { app: { getAppPath: () => require('node:path').resolve(__dirname, '..') } };
    return originalLoad.call(this, name, ...args);
  });
  const { CoreManager } = require('../dist/main/core');
  loader.mock.restore();
  let child;
  const spawner = mock.method(childProcess, 'spawn', () => {
    child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
    return child;
  });
  try {
    const manager = new CoreManager({}, { listenPort: 18899 });
    let pending = manager.startCoreProcess();
    assert.equal(manager.getStatus().isCoreRunning, false);
    child.stdout.write('LLM_LENS_CORE_READY 127.0.0.1:');
    assert.equal(manager.getStatus().isCoreRunning, false);
    child.stdout.write('18899\n');
    await pending;
    assert.equal(manager.getStatus().isCoreRunning, true);
    child.emit('exit', 1, null);
    assert.equal(manager.getStatus().isCoreRunning, false);
    pending = manager.startCoreProcess();
    child.emit('exit', 1, null);
    await assert.rejects(pending, /就绪前退出/);
    pending = manager.startCoreProcess();
    child.emit('error', new Error('spawn ENOEXEC'));
    await assert.rejects(pending, /ENOEXEC/);
  } finally {
    spawner.mock.restore();
    exists.mock.restore();
    chmod.mock.restore();
  }
});
