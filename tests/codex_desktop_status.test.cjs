const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const desktop = () => require('../dist/main/codex-desktop');
const appPath = '/Applications/Codex.app';
const processInfo = (pid, executable = appPath + '/Contents/MacOS/Codex', ppid = 1, extra = {}) => ({ pid, ppid, uid: 501, startedAt: 'Thu Oct 22 14:01:02 2026', executable, ...extra });

function fixture(initial = []) {
  let processes = initial;
  const signals = [], launches = [], confirmations = [];
  const io = {
    selfPid: 999, uid: 501, resolveAppPath: value => value,
    readProcesses: async () => processes,
    signal: (pid, signal) => { signals.push([pid, signal]); processes = processes.filter(p => p.pid !== pid); },
    pause: async () => {}
  };
  return {
    io, signals, launches, confirmations,
    setProcesses: value => { processes = value; },
    run: (answer = true, selected = appPath) => desktop().launchCodexDesktop(selected,
      async count => { confirmations.push(count); return answer; },
      () => { launches.push('launch'); return { success: true, message: 'synthetic launched' }; }, io)
  };
}

function ipcHandler(channel, io, answer = 0, spawnError = false) {
  const source = fs.readFileSync(require.resolve('../dist/main/index.js'), 'utf8');
  const start = source.indexOf(`handle('api:${channel}-agent'`);
  const end = channel === 'check' ? source.indexOf("handle('api:launch-agent'", start) : source.indexOf('\n}\nfunction createWindow()', start);
  assert.ok(start >= 0 && end > start);
  const observed = { bundles: 0, spawned: [], dialogs: [], confirmations: [] };
  vm.runInNewContext(source.slice(start, end), {
    handle: (name, callback) => { if (name === `api:${channel}-agent`) observed.handler = callback; },
    process: { platform: 'darwin', env: {} }, mainWindow: null,
    agentRestartConfirmations: { request: async (...args) => { observed.confirmations.push(args); return answer === 1; } },
    findMacApp: names => '/Applications/' + names[0] + '.app', findCliBinary: name => '/synthetic/bin/' + name,
    configManager: { getConfig: () => ({ proxy: { listenPort: 12345 } }) },
    certManager: { getCertPaths: () => ({ caCertPath: '/synthetic/ca.crt' }), prepareAgentCaBundle: () => { observed.bundles++; return '/synthetic/bundle.pem'; } },
    path_1: { default: path },
    electron_1: { dialog: { showMessageBox: async (...args) => { observed.dialogs.push(args.at(-1)); return { response: answer }; } } },
    child_process_1: {
      execSync: () => assert.fail('installation query must not inspect processes'),
      spawn: (...args) => {
        observed.spawned.push(args);
        const child = new (require('node:events').EventEmitter)();
        child.unref = () => {};
        process.nextTick(() => spawnError ? child.emit('error', new Error('synthetic spawn denied')) : child.emit('spawn'));
        return child;
      }
    },
    codex_desktop_1: {
      launchCodexDesktop: (...args) => desktop().launchCodexDesktop(...args, io),
      isCodexDesktopRunning: () => assert.fail('installation query must not inspect processes')
    }
  });
  return observed;
}

test('Agent installation IPC returns only installed and never queries running processes', async () => {
  const observed = ipcHandler('check');
  for (const agent of ['antigravity', 'cursor', 'codex_app', 'codex', 'codex_cli', 'pi']) {
    const status = await observed.handler(null, { agent });
    assert.deepEqual(Object.keys(status), ['installed']);
    assert.equal(status.installed, true);
  }
});

test('Codex launch asks about residual processes and cancellation has no side effects', async () => {
  const f = fixture([processInfo(10, appPath + '/Contents/Frameworks/browser_crashpad_handler')]);
  const result = await f.run(false);
  assert.equal(result.success, false);
  assert.match(result.message, /取消/);
  assert.deepEqual(f.confirmations, [1]);
  assert.deepEqual(f.signals, []);
  assert.deepEqual(f.launches, []);
});

test('Codex launches directly when only unrelated applications and standalone CLI exist', async () => {
  const f = fixture([
    processInfo(10, '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'),
    processInfo(11, '/usr/local/bin/codex'), processInfo(12, appPath + '-copy/Contents/MacOS/Codex'),
    processInfo(13, '/bin/sh')
  ]);
  assert.equal((await f.run()).success, true);
  assert.deepEqual(f.confirmations, []);
  assert.deepEqual(f.signals, []);
  assert.equal(f.launches.length, 1);
});

test('confirmed restart terminates main, residual helpers, embedded CLI and proven descendants before launch', async () => {
  const f = fixture([
    processInfo(10), processInfo(11, appPath + '/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper', 10),
    processInfo(12, appPath + '/Contents/Resources/codex-cli/bin/codex', 1),
    processInfo(13, '/synthetic/node', 11), processInfo(14, '/synthetic/tool', 13),
    processInfo(20, '/Applications/Other.app/Contents/MacOS/Other')
  ]);
  assert.equal((await f.run()).success, true);
  assert.deepEqual(f.signals.map(([pid]) => pid).sort((a, b) => a - b), [10, 11, 12, 13, 14]);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.confirmations, [5]);
});

test('TERM is followed by bounded waiting and KILL only when confirmed processes remain', async () => {
  const f = fixture([processInfo(10)]);
  let waits = 0;
  f.io.pause = async () => { waits++; };
  f.io.signal = (pid, signal) => { f.signals.push([pid, signal]); if (signal === 'SIGKILL') f.setProcesses([]); };
  assert.equal((await f.run()).success, true);
  assert.deepEqual(f.signals, [[10, 'SIGTERM'], [10, 'SIGKILL']]);
  assert.ok(waits > 0 && waits <= 30);
});

test('query errors, signal failures and surviving processes prevent restart', async () => {
  for (const failure of ['query', 'permission', 'surviving']) {
    const f = fixture([processInfo(10)]);
    if (failure === 'query') f.io.readProcesses = async () => { throw new Error('query denied'); };
    if (failure === 'permission') f.io.signal = () => { throw new Error('signal denied'); };
    if (failure === 'surviving') f.io.signal = () => {};
    assert.equal((await f.run()).success, false, failure);
    assert.equal(f.launches.length, 0, failure);
  }
});

test('PID reuse and processes appearing during confirmation are not silently terminated or relaunched', async () => {
  const f = fixture([processInfo(10)]);
  const result = await desktop().launchCodexDesktop(appPath, async () => {
    f.setProcesses([processInfo(10, '/Applications/Other.app/Contents/MacOS/Other', 1, { startedAt: 'Thu Oct 22 15:01:02 2026' }), processInfo(21)]);
    return true;
  }, () => assert.fail('remaining app must prevent launch'), f.io);
  assert.equal(result.success, false);
  assert.deepEqual(f.signals, []);
});

test('other users, this process and its ancestors cannot be terminated', async () => {
  for (const processes of [
    [processInfo(10, undefined, 1, { uid: 502 })],
    [processInfo(999)],
    [processInfo(10), processInfo(999, '/synthetic/promptlens', 10)]
  ]) {
    const f = fixture(processes);
    assert.equal((await f.run()).success, false);
    assert.deepEqual(f.signals, []);
    assert.deepEqual(f.launches, []);
  }
});

test('per-application launch is locked during confirmation and cancellation releases it', async () => {
  const f = fixture([processInfo(10)]);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const first = desktop().launchCodexDesktop(appPath, () => { entered(); return new Promise(resolve => { release = resolve; }); }, () => assert.fail('cancelled'), f.io);
  await ready;
  assert.equal((await f.run()).success, false);
  assert.equal(f.confirmations.length, 0);
  release(false);
  await first;
  assert.equal((await f.run(false)).success, false);
  assert.deepEqual(f.confirmations, [1]);
});

test('process snapshot parses identity and executable paths with spaces and rejects incomplete evidence', () => {
  const values = desktop().parseDesktopProcesses('  10 1 501 Thu Oct 22 14:01:02 2026 /Users/Test User/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n');
  assert.deepEqual(values, [processInfo(10, '/Users/Test User/Applications/ChatGPT.app/Contents/MacOS/ChatGPT')]);
  assert.throws(() => desktop().parseDesktopProcesses('10 /Applications/Codex.app'), /进程/);
});

test('confirmed restart waits for a real isolated test child to exit before launching', async t => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
  });
  await once(child, 'spawn');
  const f = fixture();
  f.io.readProcesses = async () => child.exitCode === null && child.signalCode === null ? [processInfo(child.pid)] : [];
  f.io.signal = (pid, signal) => { assert.equal(pid, child.pid); child.kill(signal); };
  f.io.pause = () => new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await f.run()).success, true);
  assert.equal(child.signalCode, 'SIGTERM');
  assert.equal(f.launches.length, 1);
});

test('Desktop Agent launch IPC requests custom confirmation without a native dialog and preserves proxy environment', async () => {
  const cases = [
    { agent: 'codex_app', appName: 'Codex.app', binary: '/Applications/Codex.app/Contents/MacOS/Codex', noProxy: '127.0.0.1:8897,127.0.0.1:8088', hasProxyArg: true },
    { agent: 'codex', appName: 'Codex.app', binary: '/Applications/Codex.app/Contents/MacOS/Codex', noProxy: '127.0.0.1:8897,127.0.0.1:8088', hasProxyArg: true },
    { agent: 'antigravity', appName: 'Antigravity.app', binary: '/Applications/Antigravity.app/Contents/MacOS/Antigravity', noProxy: 'localhost:8897,localhost:8088,127.0.0.1:8897,127.0.0.1:8088,[::1]:8897,[::1]:8088', hasProxyArg: true },
    { agent: 'workbuddy', appName: 'WorkBuddy.app', binary: '/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy', noProxy: 'localhost:8897,localhost:8088,127.0.0.1:8897,127.0.0.1:8088,[::1]:8897,[::1]:8088', hasProxyArg: true },
    { agent: 'cursor', appName: 'Cursor.app', binary: '/Applications/Cursor.app/Contents/MacOS/Cursor', noProxy: 'localhost:8897,localhost:8088,127.0.0.1:8897,127.0.0.1:8088,[::1]:8897,[::1]:8088', hasProxyArg: false }
  ];
  for (const { agent, appName, binary: expectedBinary, noProxy, hasProxyArg } of cases) {
    const running = [processInfo(10, `/Applications/${appName}/Contents/MacOS/Main`)];
    const cancelled = ipcHandler('launch', fixture(running).io, 0);
    assert.equal((await cancelled.handler({ sender: { id: 7 } }, { agent })).success, false, agent);
    assert.equal(cancelled.bundles, 0, agent);
    assert.equal(cancelled.spawned.length, 0, agent);
    assert.equal(cancelled.dialogs.length, 0, 'must not open a system dialog');
    assert.equal(cancelled.confirmations.length, 1, agent);
    assert.equal(cancelled.confirmations[0][1].appName, appName);
    assert.equal(cancelled.confirmations[0][1].processCount, 1);
    const confirmed = ipcHandler('launch', fixture(running).io, 1);
    assert.equal((await confirmed.handler({ sender: { id: 7 } }, { agent })).success, true, agent);
    assert.equal(confirmed.spawned.length, 1, agent);
    const [binary, args, { env }] = confirmed.spawned[0];
    assert.equal(binary, expectedBinary);
    if (hasProxyArg) assert.ok(args.includes('--proxy-server=http://127.0.0.1:12345'));
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:12345');
    assert.equal(env.NODE_EXTRA_CA_CERTS, '/synthetic/ca.crt');
    assert.equal(env.SSL_CERT_FILE, '/synthetic/bundle.pem');
    assert.equal(env.NO_PROXY, noProxy);
  }
});

test('failed executable spawn is reported without claiming launch success', async () => {
  const observed = ipcHandler('launch', fixture().io, 0, true);
  const result = await observed.handler(null, { agent: 'codex_app' });
  assert.equal(result.success, false);
  assert.match(result.message, /spawn denied/);
  assert.equal(observed.dialogs.length, 0);
});

test('renderer prevents duplicate launch calls and installation refresh stores no running status', async t => {
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: 'custom' });
  const oldWindow = global.window;
  t.after(async () => { global.window = oldWindow; await server.close(); });
  let calls = 0, release;
  global.window = { electronAPI: {
    platform: 'darwin', checkAgent: async () => ({ installed: true }),
    launchAgent: async () => { calls++; return new Promise(resolve => { release = resolve; }); }
  } };
  const { useSettings } = await server.ssrLoadModule('/src/renderer/composables/useSettings.ts');
  const settings = useSettings();
  await settings.checkAgentsStatus();
  assert.deepEqual(Object.keys(settings.agentStatus.value.codex_app), ['installed']);
  const first = settings.launchAgentApp('codex_app');
  await settings.launchAgentApp('codex_app');
  assert.equal(calls, 1);
  release({ success: false, message: 'cancelled' });
  await first;
  assert.equal(settings.isLaunchingAgent.value, false);
});

function confirmationWindow(id = 7) {
  const sender = new (require('node:events').EventEmitter)();
  sender.id = id;
  sender.isDestroyed = () => false;
  sender.messages = [];
  sender.send = (channel, payload) => sender.messages.push({ channel, payload });
  return sender;
}

test('custom confirmation is bound to its window and accepts exactly one response', async () => {
  const { AgentRestartConfirmations } = require('../dist/main/agent-restart-confirmation');
  const confirmations = new AgentRestartConfirmations();
  const sender = confirmationWindow();
  const waiting = confirmations.request(sender, { appName: 'Codex.app', processCount: 2 });
  const { channel, payload } = sender.messages[0];
  assert.equal(channel, 'agent:restart-confirmation');
  assert.equal(payload.appName, 'Codex.app');
  assert.equal(payload.processCount, 2);
  assert.equal(confirmations.respond(8, payload.requestId, true), false);
  assert.equal(confirmations.respond(7, 'unknown', true), false);
  assert.equal(confirmations.respond(7, payload.requestId, true), true);
  assert.equal(await waiting, true);
  assert.equal(confirmations.respond(7, payload.requestId, true), false);
  assert.equal(sender.listenerCount('destroyed'), 0);
  assert.equal(sender.listenerCount('did-start-navigation'), 0);
});

test('closing, navigation, hidden windows, delivery errors and timeout cancel confirmation', async () => {
  const { AgentRestartConfirmations } = require('../dist/main/agent-restart-confirmation');
  for (const reason of ['destroyed', 'did-start-navigation', 'hidden', 'send-error', 'timeout']) {
    const confirmations = new AgentRestartConfirmations(15);
    const sender = confirmationWindow();
    if (reason === 'send-error') sender.send = () => { throw new Error('gone'); };
    const waiting = confirmations.request(sender, { appName: 'Codex.app', processCount: 1 });
    if (reason === 'hidden') confirmations.cancelFor(sender.id);
    else if (reason === 'timeout') await new Promise(resolve => setTimeout(resolve, 25));
    else if (reason !== 'send-error') sender.emit(reason);
    assert.equal(await waiting, false, reason);
    assert.equal(sender.listenerCount('destroyed'), 0, reason);
    assert.equal(sender.listenerCount('did-start-navigation'), 0, reason);
    const requestId = sender.messages[0]?.payload.requestId;
    if (requestId) assert.equal(confirmations.respond(sender.id, requestId, true), false, reason);
  }
});

test('pending custom confirmation cannot terminate processes before an accepted response', async () => {
  const { AgentRestartConfirmations } = require('../dist/main/agent-restart-confirmation');
  const confirmations = new AgentRestartConfirmations();
  const sender = confirmationWindow();
  const f = fixture([processInfo(10)]);
  const pending = desktop().launchCodexDesktop(appPath,
    count => confirmations.request(sender, { appName: 'Codex.app', processCount: count }),
    () => { f.launches.push('launched'); return { success: true, message: 'test' }; }, f.io);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sender.messages.length, 1);
  assert.deepEqual(f.signals, []);
  assert.deepEqual(f.launches, []);
  confirmations.respond(sender.id, sender.messages[0].payload.requestId, false);
  assert.equal((await pending).success, false);
  assert.deepEqual(f.signals, []);
});

test('restart response IPC rejects malformed values and arbitrary process controls', () => {
  const { assertIpcArguments } = require('../dist/main/desktop-security');
  const requestId = '11111111-2222-4333-8444-555555555555';
  assert.doesNotThrow(() => assertIpcArguments('api:confirm-agent-restart', [{ requestId, confirmed: false }]));
  for (const invalid of [{ requestId }, { requestId, confirmed: 'yes' }, { requestId: '', confirmed: true }, { requestId, confirmed: true, pid: 10 }]) {
    assert.throws(() => assertIpcArguments('api:confirm-agent-restart', [invalid]), /Invalid/);
  }
});

test('renderer custom confirmation handles cancel, confirm, retry, expiry, close and subscription cleanup', async t => {
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: 'custom' });
  const oldWindow = global.window;
  t.after(async () => { global.window = oldWindow; await server.close(); });
  const { useSettings } = await server.ssrLoadModule('/src/renderer/composables/useSettings.ts');
  const { effectScope, nextTick } = require('vue');
  for (const mode of ['cancel', 'confirm', 'error', 'expired', 'close', 'dispose']) {
    let notify, complete, removed = false, firstError = mode === 'error';
    const responses = [], messages = [];
    const request = { requestId: '11111111-2222-4333-8444-555555555555', appName: 'Codex.app', processCount: 1 };
    global.window = { electronAPI: {
      platform: 'darwin', checkAgent: async () => ({ installed: true }),
      onAgentRestartConfirmation: callback => { notify = callback; return () => { removed = true; }; },
      confirmAgentRestart: async (id, answer) => {
        responses.push([id, answer]);
        if (firstError) { firstError = false; throw new Error('temporary'); }
        if (mode !== 'confirm') complete({ success: false, message: 'cancelled' });
        return mode !== 'expired';
      },
      launchAgent: async () => { const pending = new Promise(resolve => { complete = resolve; }); notify(request); return pending; }
    } };
    const scope = effectScope();
    const settings = scope.run(() => useSettings(undefined, message => messages.push(message)));
    settings.isSettingsOpen.value = true;
    const launch = settings.launchAgentApp('codex_app');
    assert.equal(settings.agentRestartRequest.value.requestId, request.requestId, mode);
    assert.equal(responses.length, 0, mode);
    if (mode === 'close') { settings.isSettingsOpen.value = false; await nextTick(); }
    else if (mode === 'dispose') scope.stop();
    else {
      await settings.respondToAgentRestart(mode === 'confirm');
      if (mode === 'error') {
        assert.equal(settings.isConfirmingAgentRestart.value, false);
        assert.equal(settings.agentRestartRequest.value.requestId, request.requestId);
        await settings.respondToAgentRestart(false);
      }
      if (mode === 'confirm') {
        assert.equal(settings.isConfirmingAgentRestart.value, true);
        await settings.respondToAgentRestart(true);
        assert.equal(responses.length, 1);
        complete({ success: true, message: 'launched' });
      }
    }
    await launch;
    assert.equal(settings.agentRestartRequest.value, null, mode);
    assert.equal(settings.isLaunchingAgent.value, false, mode);
    assert.equal(responses[0][0], request.requestId, mode);
    if (mode === 'expired') assert.ok(messages.some(message => message.includes('失效')));
    scope.stop();
    assert.equal(removed, true, mode);
  }
});
