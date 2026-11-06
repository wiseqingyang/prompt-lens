const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('renderer treats a zero ledger response as authoritative and never rebuilds usage from history', async t => {
  const { createServer } = await import('vite');
  // SSR loading needs no HMR listener; keep this isolated test from binding Vite's default port.
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: 'custom' });
  const oldWindow = global.window, oldFetch = global.fetch;
  const empty = { total_tokens: 0, peak_tokens: 0, peak_date: '', max_duration_ms: 0, current_streak: 0, longest_streak: 0, days: [] };
  const history = [{ total_tokens: 999, agent_name: 'Pi Agent', created_at: new Date().toISOString() }];
  try {
    const { useTokenActivity } = await server.ssrLoadModule('/src/renderer/composables/useTokenActivity.ts');
    await t.test('Electron zero result does not fall back to raw records', async () => {
      global.window = { electronAPI: { getDailyTokenActivity: async () => empty, getRecords: async () => ({ records: history }) } };
      global.fetch = async () => { throw new Error('unexpected HTTP fallback'); };
      const state = useTokenActivity();
      await state.fetchActivity();
      assert.equal(state.summary.value.total_tokens, 0);
      assert.deepEqual(state.summary.value.days, []);
    });
    await t.test('Web zero result does not read history', async () => {
      const calls = [];
      global.window = {};
      global.fetch = async url => { calls.push(url); return { ok: true, json: async () => url.includes('daily-activity') ? empty : ({ records: history }) }; };
      const state = useTokenActivity();
      await state.fetchActivity();
      assert.equal(state.summary.value.total_tokens, 0);
      assert.equal(calls.length, 1);
    });
    await t.test('unavailable ledger reports an error rather than displaying historical token totals', async () => {
      global.window = {};
      global.fetch = async () => ({ ok: false });
      const state = useTokenActivity();
      await state.fetchActivity();
      assert.ok(state.error.value);
      assert.equal(state.summary.value.total_tokens, 0);
    });
  } finally { global.window = oldWindow; global.fetch = oldFetch; await server.close(); }
});

test('settings load diagnostics only for the selected page in Electron and Web', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: 'custom' });
  const old = { window: global.window, fetch: global.fetch };
  try {
    const { useSettings } = await server.ssrLoadModule('/src/renderer/composables/useSettings.ts');
    for (const electron of [true, false]) {
      const calls = [];
      const config = { proxy: { listenPort: 8899 }, storage: { retentionDays: 0 } };
      const api = {
        getConfig: async () => { calls.push('config'); return structuredClone(config); },
        getDbInfo: async () => { calls.push('storage'); return { dbPath: '/synthetic', dbSize: 10, recordsCount: 3 }; },
        getCertStatus: async () => { calls.push('certificate'); return { state: 'missing' }; },
        checkAgent: async agent => { calls.push('agent:'+agent); return { installed: false, running: false }; },
        compactDatabase: async () => ({ savedBytes: 0 }), resetUsage: async () => ({ success: true })
      };
      global.window = electron ? { electronAPI: api } : {};
      global.fetch = async url => {
        const route = { '/api/config': 'getConfig', '/api/db-info': 'getDbInfo', '/api/cert/status': 'getCertStatus', '/api/maintenance/reclaim': 'compactDatabase', '/api/reset-usage': 'resetUsage' }[url];
        assert.ok(route, 'unexpected request: '+url);
        return { ok: true, json: api[route] };
      };
      const state = useSettings();
      await state.openSettings();
      assert.deepEqual(calls, ['config'], 'stats page must not dispatch unrelated synchronous work');
      state.isSettingsOpen.value = false; await state.openSettings();
      assert.deepEqual(calls, ['config', 'config']);
      state.settingsForm.value.proxy.listenPort = 9999;
      await state.selectSettingsTab('storage');
      assert.equal(calls.at(-1), 'storage');assert.equal(state.dbInfo.value.recordsCount, 3);
      assert.equal(state.settingsForm.value.proxy.listenPort, 9999, 'tab switch preserves unsaved edits');
      await state.selectSettingsTab('privacy');assert.equal(calls.at(-1), 'certificate');
      const beforeAgents = calls.length;
      await state.selectSettingsTab('agent');
      assert.deepEqual(calls.slice(beforeAgents), electron ? ['agent:antigravity', 'agent:codex_app', 'agent:codex_cli', 'agent:pi', 'agent:workbuddy'] : []);
      await state.selectSettingsTab('storage');
      const beforeMaintenance = calls.filter(c=>c==='storage').length;
      await state.compactDatabase(); await state.deleteData('resetUsage');
      assert.equal(calls.filter(c=>c==='storage').length, beforeMaintenance+2, 'maintenance refreshes stored size and coverage');
      const beforeStats = [...calls];await state.selectSettingsTab('stats');
      assert.deepEqual(calls, beforeStats);
    }
  } finally { Object.assign(global, old); await server.close(); }
});

test('token activity keeps the latest Agent selection authoritative during overlapping requests', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: 'custom' });
  const old = { window: global.window, fetch: global.fetch };
  const summary = total => ({ total_tokens: total, peak_tokens: total, peak_date: '', max_duration_ms: 0, current_streak: 0, longest_streak: 0, days: [] });
  try {
    const { useTokenActivity } = await server.ssrLoadModule('/src/renderer/composables/useTokenActivity.ts');
    for (const electron of [true, false]) {
      const pending = [];
      const request = agent => new Promise(resolve => pending.push({agent, resolve}));
      global.window = electron ? { electronAPI: { getDailyTokenActivity: request } } : {};
      global.fetch = async url => { const data = await request(new URL(url, 'http://localhost').searchParams.get('agent')); return { ok: true, json: async () => data }; };
      const state = useTokenActivity();
      const first = state.fetchActivity('Codex'), second = state.fetchActivity('Antigravity');
      await new Promise(resolve=>setImmediate(resolve));
      assert.deepEqual(pending.map(p=>p.agent), ['Codex','Antigravity']);
      pending[0].resolve(summary(10));await first;
      assert.equal(state.isLoading.value,true,'old completion cannot hide loading for current Agent');
      assert.equal(state.summary.value.total_tokens,0,'old Agent response is not published');
      pending[1].resolve(summary(20));await second;
      assert.equal(state.summary.value.total_tokens,20);assert.equal(state.isLoading.value,false);
      const third=state.fetchActivity('Codex'), fourth=state.fetchActivity('all');
      await new Promise(resolve=>setImmediate(resolve));
      pending[3].resolve(summary(30));await fourth;
      pending[2].resolve(summary(11));await third;
      assert.equal(state.summary.value.total_tokens,30,'late old response cannot replace latest totals');
      assert.equal(state.selectedAgent.value,'all');
    }
  } finally { Object.assign(global, old); await server.close(); }
});

test('stats Agent roster contains only captured Agents, including non-model requests and retained history', t => {
  const fs=require('node:fs'),os=require('node:os');
  const {StorageEngine}=require('../dist/main/storage');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lens-agent-roster-'));
  let storage=new StorageEngine(path.join(root,'lens.db'));
  t.after(()=>{storage.close();fs.rmSync(root,{recursive:true,force:true});});
  assert.deepEqual(storage.getStats().agents,[]);
  storage.insertRecord({agent_name:'WorkBuddy',provider:'openai',url_path:'/v2/chat/completions',status_code:500,token_source:'unavailable'});
  storage.insertRecord({agent_name:'Antigravity',provider:'unknown',url_path:'/web-fetch',token_source:'unavailable'});
  storage.insertRecord({agent_name:'WorkBuddy',provider:'openai',url_path:'/v2/chat/completions',token_source:'reported',input_tokens:10,output_tokens:2,total_tokens:12});
  const before=storage.getStats();assert.deepEqual(before.agents,['Antigravity','WorkBuddy']);assert.equal(before.total_tokens,12);
  storage.clearRecords();assert.deepEqual(storage.getStats(),before);
  storage.close();assert.deepEqual(storage.getStats().agents,[]);
  storage=new StorageEngine(path.join(root,'lens.db'));assert.deepEqual(storage.getStats(),before);
});

test('Token statistics uses the sidebar discovery roster through settings, independently of filtered usage', async t => {
  const {createServer}=await import('vite');
  const {default:vue}=await import('@vitejs/plugin-vue');
  const server=await createServer({configFile:false,root:path.resolve(__dirname,'..'),plugins:[vue()],server:{middlewareMode:true,watch:null,hmr:false,ws:false},appType:'custom'});
  t.after(()=>server.close());
  const {useSessions}=await server.ssrLoadModule('/src/renderer/composables/useSessions.ts');
  const Settings=(await server.ssrLoadModule('/src/renderer/components/settings/SettingsModal.vue')).default;
  const {createSSRApp}=require('vue'),{renderToString}=require('@vue/server-renderer');
  const state=useSessions();
  const settings={settingsTab:{value:'stats'},isSavingSettings:{value:false},agentRestartRequest:{value:null}};
  const filters=async()=>{
    const html=await renderToString(createSSRApp(Settings,{isOpen:true,settings,agentOptions:state.agentTabs.value}));
    return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)]
      .map(match=>match[1].replace(/<[^>]*>/g,'').trim())
      .filter(label=>['全部 Agent','Codex','Antigravity','Pi','WorkBuddy','其他'].includes(label));
  };
  assert.deepEqual(await filters(),['全部 Agent','Codex','其他']);
  state.stats.value={agents:['WorkBuddy','Pi Agent'],total_tokens:0};
  assert.deepEqual(await filters(),['全部 Agent','Codex','Pi','WorkBuddy','其他']);
  state.searchQuery.value='no matches';state.stats.value={agents:[]};state.sessions.value=[];
  assert.deepEqual(await filters(),['全部 Agent','Codex','Pi','WorkBuddy','其他']);
});

test('token activity viewMode correctly differentiates daily, weekly and cumulative aggregations', async t => {
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: 'custom' });
  t.after(() => server.close());
  const { useTokenActivity } = await server.ssrLoadModule('/src/renderer/composables/useTokenActivity.ts');
  const state = useTokenActivity();
  const now = new Date();
  const d1 = new Date(now);
  const d2 = new Date(now);
  // Ensure d1 and d2 fall in the same week by subtracting days from current day
  const dayOfWeek = now.getDay();
  if (dayOfWeek >= 1) {
    d1.setDate(now.getDate() - 1);
  } else {
    d2.setDate(now.getDate() + 1);
  }
  const date1 = d1.toISOString().slice(0, 10);
  const date2 = d2.toISOString().slice(0, 10);

  state.summary.value = {
    total_tokens: 300,
    peak_tokens: 200,
    peak_date: date2,
    max_duration_ms: 1000,
    current_streak: 2,
    longest_streak: 2,
    days: [
      { date: date1, total_tokens: 100, input_tokens: 80, output_tokens: 20, cached_tokens: 0, thinking_tokens: 0, request_count: 5, max_duration_ms: 500 },
      { date: date2, total_tokens: 200, input_tokens: 160, output_tokens: 40, cached_tokens: 0, thinking_tokens: 0, request_count: 8, max_duration_ms: 1000 }
    ]
  };

  state.viewMode.value = 'daily';
  let cells = state.heatmapData.value.weeks.flat();
  const c1Daily = cells.find(c => c.date === date1);
  const c2Daily = cells.find(c => c.date === date2);
  assert.equal(c1Daily.tokens, 100);
  assert.equal(c2Daily.tokens, 200);

  state.viewMode.value = 'weekly';
  cells = state.heatmapData.value.weeks.flat();
  const c1Weekly = cells.find(c => c.date === date1);
  const c2Weekly = cells.find(c => c.date === date2);
  assert.equal(c1Weekly.tokens, 300);
  assert.equal(c2Weekly.tokens, 300);
  assert.ok(c1Weekly.weekRange);
  assert.equal(c1Weekly.weekRange, c2Weekly.weekRange);

  state.viewMode.value = 'cumulative';
  cells = state.heatmapData.value.weeks.flat();
  const c1Cum = cells.find(c => c.date === date1);
  const c2Cum = cells.find(c => c.date === date2);
  assert.equal(c1Cum.tokens, 100);
  assert.equal(c2Cum.tokens, 300);
});
