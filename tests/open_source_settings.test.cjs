const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { testUpstreamConnectivity } = require('../dist/main/upstream-test');

test('proxy probe reports tunnel scope, authenticates and rejects unsupported schemes', async t => {
  const server = http.createServer();
  server.on('connect', (req, socket) => {
    const authorized = req.headers['proxy-authorization'] === 'Basic ' + Buffer.from('synthetic:probe').toString('base64');
    socket.end(`HTTP/1.1 ${authorized ? '200 Connection Established' : '407 Proxy Authentication Required'}\r\n\r\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await testUpstreamConnectivity(url)).ok, false);
  const result = await testUpstreamConnectivity(url.replace('http://', 'http://synthetic:probe@'));
  assert.equal(result.ok, true);
  assert.match(result.message, /尚未验证/);
  assert.equal((await testUpstreamConnectivity('socks5://127.0.0.1:1')).ok, false);
});

test('settings show web failures and preserve mode-specific upstream targets', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: 'custom' });
  const old = { window: global.window, fetch: global.fetch, alert: global.alert };
  try {
    const { useSettings } = await server.ssrLoadModule('/src/renderer/composables/useSettings.ts');
    global.window = {};
    const messages = [];
    global.alert = m => messages.push(m);
    global.fetch = async () => ({ ok: false });
    const state = useSettings(undefined, m => messages.push(m));
    state.isSettingsOpen.value = true;
    await state.testUpstream();
    assert.equal(state.upstreamTestResult.value.ok, false);
    await state.saveSettings();
    assert.equal(state.isSettingsOpen.value, true);
    assert.equal(messages.some(m => m.includes('已保存')), false);
    assert.equal(messages.some(m => m.includes('失败')), true);
    await state.refreshCertificate();
    assert.equal(state.certificate.value.state, 'unknown');
    const targets = [];
    global.window = { electronAPI: { testUpstream: async target => { targets.push(target); return { ok: false }; } } };
    await state.testUpstream();
    state.settingsForm.value.proxy.upstreamMode = 'direct';
    await state.testUpstream();
    state.settingsForm.value.proxy.upstreamMode = 'custom';
    state.settingsForm.value.proxy.customUpstream = 'http://127.0.0.1:4321';
    await state.testUpstream();
    assert.deepEqual(targets, [undefined, '', 'http://127.0.0.1:4321']);
  } finally { Object.assign(global, old); await server.close(); }
});

test('useSettings allows adding and removing custom interception domains with sanitization', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: 'custom' });
  const old = { window: global.window, fetch: global.fetch };
  try {
    const { useSettings } = await server.ssrLoadModule('/src/renderer/composables/useSettings.ts');
    global.window = {};
    const state = useSettings();
    assert.deepEqual(state.settingsForm.value.proxy.customDomains, []);

    state.addCustomDomain('workbuddy.cn');
    assert.deepEqual(state.settingsForm.value.proxy.customDomains, ['workbuddy.cn']);

    state.addCustomDomain('workbuddy.cn');
    assert.deepEqual(state.settingsForm.value.proxy.customDomains, ['workbuddy.cn']);

    state.addCustomDomain('https://api.siliconflow.cn:443/v1/chat');
    assert.deepEqual(state.settingsForm.value.proxy.customDomains, ['workbuddy.cn', 'api.siliconflow.cn']);

    state.addCustomDomain('   ');
    assert.deepEqual(state.settingsForm.value.proxy.customDomains, ['workbuddy.cn', 'api.siliconflow.cn']);

    state.removeCustomDomain(0);
    assert.deepEqual(state.settingsForm.value.proxy.customDomains, ['api.siliconflow.cn']);
  } finally { Object.assign(global, old); await server.close(); }
});
