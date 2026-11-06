// Launch with Electron. No production entry point, proxy, system CA or Agent is started.
// Pass an unpacked .app/Contents/Resources/app.asar to exercise the packaged modules.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlens-desktop-smoke-'));
app.setPath('userData', path.join(directory, 'electron'));
app.setName('PromptLens Isolated Smoke');
let storage, web, win;
let loaded = false, exitCode = 0, finishing = false;
const seen = new Set();
const checkOnly = process.argv.includes('--check');
const maybeDone = () => {
  if (checkOnly && loaded && ['api:get-stats', 'api:get-sessions', 'api:get-record-detail'].every(channel => seen.has(channel)) && !finishing) {
    finishing = true;
    console.log('SMOKE_PASSED');
    setTimeout(() => app.quit(), 250);
  }
};
const timer = setTimeout(() => { console.error('SMOKE_TIMEOUT'); exitCode = 1; app.quit(); }, checkOnly ? 30000 : 15 * 60 * 1000);
(async () => {
  await app.whenReady();
  const { StorageEngine } = require(path.join(root, 'dist/main/storage'));
  const { CertManager } = require(path.join(root, 'dist/main/cert'));
  const { ConfigManager } = require(path.join(root, 'dist/main/config'));
  const { WebServer } = require(path.join(root, 'dist/main/web'));
  const { assertTrustedSender, assertIpcArguments, secureWebContents } = require(path.join(root, 'dist/main/desktop-security'));
  storage = new StorageEngine(path.join(directory, 'synthetic.db'));
  const id = storage.insertRecord({ session_id: 'smoke-session', agent_name: 'Codex', model: 'synthetic-model', user_prompt: '合成桌面冒烟记录', response_text: '仅本地测试，无真实模型调用', total_tokens: 12 });
  assert.equal(storage.getRecordById(id).response_text, '仅本地测试，无真实模型调用');
  const cert = new CertManager(path.join(directory, 'ca'));
  cert.ensureCertDir();
  const config = new ConfigManager(path.join(directory, 'config.json'), '', directory);
  web = new WebServer(storage, cert, 0, undefined, 'synthetic-desktop-smoke-only', config);
  await web.app.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${web.app.server.address().port}`;
  win = new BrowserWindow({ width: 1200, height: 820, title: 'PromptLens Isolated Smoke', webPreferences: { preload: path.join(root, 'dist/preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  secureWebContents(win.webContents, origin);
  // Route supported bridge reads through the packaged Web API. Privileged OS operations are absent.
  const routes = {
    'api:get-stats': () => '/api/stats', 'api:get-sessions': () => '/api/sessions',
    'api:get-records': () => '/api/records', 'api:get-record-detail': id => `/api/records/${id}`,
    'api:get-record-history': id => `/api/records/${id}/history`, 'api:get-config': () => '/api/config',
    'api:get-db-info': () => '/api/db-info', 'api:get-cert-status': () => '/api/cert/status',
    'api:get-daily-token-activity': () => '/api/stats/daily-activity'
  };
  for (const [channel, route] of Object.entries(routes)) ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event, win.webContents.id, origin);
    assertIpcArguments(channel, args);
    const response = await web.app.inject({ url: route(...args), headers: { host: new URL(origin).host, 'x-prompt-lens-secret': 'synthetic-desktop-smoke-only' } });
    assert.equal(response.statusCode, 200);
    console.log('IPC_OK', channel);
    seen.add(channel); maybeDone();
    return response.json();
  });
  ipcMain.handle('api:check-agent', (event, ...args) => {
    assertTrustedSender(event, win.webContents.id, origin); assertIpcArguments('api:check-agent', args);
    return { installed: false, running: false };
  });
  ipcMain.handle('api:get-records-by-ids', (event, ids, options) => {
    assertTrustedSender(event, win.webContents.id, origin); assertIpcArguments('api:get-records-by-ids', [ids, options]);
    return storage.getRecordsByIds(ids, options);
  });
  win.webContents.on('preload-error', (_event, _path, error) => { console.error('PRELOAD_ERROR', error.message); exitCode = 1; });
  await win.loadURL(origin + '/?token=synthetic-desktop-smoke-only');
  assert.equal(win.webContents.getURL(), origin + '/');
  const prefs = win.webContents.getLastWebPreferences();
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
  loaded = true; maybeDone();
  console.log('SMOKE_READY', JSON.stringify({ root, electron: process.versions.electron, sqlite: 'insert/read passed', sandbox: prefs.sandbox, origin }));
})().catch(error => { console.error(error); exitCode = 1; app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { clearTimeout(timer); if (web) void web.app.close(); if (storage) storage.close(); fs.rmSync(directory, { recursive: true, force: true }); console.log('SMOKE_CLEANED'); });

app.on('quit', () => process.exit(exitCode));
