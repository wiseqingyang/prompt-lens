const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('access catalog exposes supported entry points, Pi adapter and exactly one generic entry', () => {
  const { AgentList, launchableAgents } = require('../dist/shared/agent');
  const { AdapterRegistry } = require('../dist/main/attribution/registry');
  assert.deepEqual(AgentList.map(agent => agent.key), ['antigravity', 'codex_app', 'codex_cli', 'pi', 'workbuddy', 'terminal']);
  assert.equal(AgentList.find(agent => agent.key === 'pi').adapterId, 'pi');
  assert.equal(new Set(AgentList.map(agent => agent.key)).size, AgentList.length);
  assert.deepEqual(AgentList.filter(agent => !agent.launchable).map(agent => agent.key), ['terminal']);
  assert.deepEqual([...new Set(launchableAgents.map(agent => agent.adapterId).filter(id => id !== null))].sort(),
    new AdapterRegistry().currentAdapters().map(adapter => adapter.id).sort());
});

test('access commands and installation queries follow the shared catalog in desktop and browser modes', async t => {
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'),
    server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: 'custom' });
  const oldWindow = global.window;
  t.after(async () => { global.window = oldWindow; await server.close(); });
  const { useSettings } = await server.ssrLoadModule('/src/renderer/composables/useSettings.ts');
  const queries = [], launches = [];
  global.window = { electronAPI: {
    platform: 'darwin',
    checkAgent: async key => { queries.push(key); return { installed: key === 'codex_cli' || key === 'pi' }; },
    launchAgent: async key => { launches.push(key); return { success: true, message: 'synthetic launch' }; }
  } };
  const settings = useSettings();
  assert.deepEqual(Object.keys(settings.agentStatus.value), ['antigravity', 'codex_app', 'codex_cli', 'pi', 'workbuddy']);
  await settings.checkAgentsStatus();
  assert.deepEqual(queries, ['antigravity', 'codex_app', 'codex_cli', 'pi', 'workbuddy']);
  assert.equal(settings.agentStatus.value.antigravity.installed, false);
  assert.equal(settings.agentStatus.value.codex_cli.installed, true);
  assert.equal(settings.agentStatus.value.pi.installed, true);
  const commands = settings.agentCommands.value;
  assert.deepEqual(Object.keys(commands), ['antigravity', 'codex_app', 'codex_cli', 'pi', 'workbuddy', 'terminal']);
  assert.match(commands.antigravity, /Antigravity\.app/);
  assert.match(commands.codex_app, /ChatGPT\.app/);
  assert.match(commands.codex_cli, /\ncodex$/);
  assert.match(commands.pi, /\npi$/);
  assert.match(commands.workbuddy, /WorkBuddy\.app/);
  for (const appKey of ['antigravity', 'codex_app', 'workbuddy']) {
    assert.match(commands[appKey], /pgrep -f/);
    assert.match(commands[appKey], /重启以挂载代理/);
    assert.match(commands[appKey], /pkill -f/);
  }
  assert.match(commands.pi, /NO_PROXY="localhost:8897,localhost:8088,127\.0\.0\.1:8897,127\.0\.0\.1:8088,\[::1\]:8897,\[::1\]:8088"/);
  assert.match(commands.terminal, /为当前终端注入/);
  settings.settingsForm.value.proxy.listenPort = 12345;
  for (const command of Object.values(settings.agentCommands.value)) {
    assert.match(command, /http:\/\/127\.0\.0\.1:12345/);
    assert.doesNotMatch(command, /:8899/);
    assert.match(command, /NODE_EXTRA_CA_CERTS/);
  }
  await settings.launchAgentApp('codex_cli');
  await settings.launchAgentApp('pi');
  assert.deepEqual(launches, ['codex_cli', 'pi']);
  global.window.electronAPI.checkAgent = async () => { throw new Error('synthetic unavailable'); };
  await settings.checkAgentsStatus();
  assert.equal(settings.agentStatus.value.codex_cli.installed, true, 'query failure preserves last known state');
  assert.deepEqual(Object.keys(settings.agentStatus.value), ['antigravity', 'codex_app', 'codex_cli', 'pi', 'workbuddy']);

  global.window = {};
  const toasts = [];
  const browser = useSettings(undefined, message => toasts.push(message));
  await browser.checkAgentsStatus();
  await browser.launchAgentApp('codex_cli');
  assert.equal(browser.isMacElectron.value, false);
  assert.equal(launches.length, 2);
  assert.match(toasts[0], /网页模式/);
  assert.deepEqual(Object.values(browser.agentStatus.value), Array(5).fill({ installed: false }));
});

test('actual Agent guide renders only the shared access entries', async t => {
  const { createServer } = await import('vite');
  const { default: vuePlugin } = await import('@vitejs/plugin-vue');
  const { createSSRApp } = require('vue');
  const { renderToString } = require('vue/server-renderer');
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [vuePlugin()],
    server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: 'custom' });
  const oldWindow = global.window;
  t.after(async () => { global.window = oldWindow; await server.close(); });
  global.window = {};
  const { useSettings } = await server.ssrLoadModule('/src/renderer/composables/useSettings.ts');
  const { default: Guide } = await server.ssrLoadModule('/src/renderer/components/settings/AgentGuideTab.vue');
  const settings = useSettings();
  const html = await renderToString(createSSRApp(Guide, { status: settings.agentStatus.value,
    commands: settings.agentCommands.value, isLaunchingAgent: false, isMacElectron: false }));
  const nav = html.match(/<nav[\s\S]*?<\/nav>/)[0];
  assert.equal((nav.match(/<button/g) || []).length, 6);
  for (const label of ['Antigravity', 'Codex 桌面端', 'Codex CLI', 'Pi Agent', 'WorkBuddy', '通用终端']) assert.ok(nav.includes(label));
  assert.doesNotMatch(html, /Cursor|Claude Code|data-agent-launch/);
  assert.match(html, /网页模式/);
});
