const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { antigravityAdapter: adapter } = require('../dist/main/attribution/adapters/antigravity');
const { StorageEngine } = require('../dist/main/storage');
const { AttributionRepository } = require('../dist/main/attribution/repository');
const { attributionView } = require('../dist/main/attribution/view');
const templates = require('./fixtures/antigravity-purpose.json');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const body = text => ({request: {systemInstruction: {role: 'user', parts: [{text}]}, contents: [{role: 'user', parts: [{text: 'synthetic input'}]}]}});
const decide = b => adapter.resolve({facts: adapter.extract({agentName: 'Antigravity', body: b, capturedAt: '2026-01-01T00:00:00Z'}), native: {status: 'unavailable', reason: 'source_missing'}, capturedAt: '2026-01-01T00:00:00Z'});
const item = (id, decision) => ({record: {id, agent_name: 'Antigravity', model: 'synthetic', created_at: '2026-01-01T00:00:00Z', status_code: 200, input_tokens: 10, output_tokens: 2}, decision});

test('verified system templates classify purpose independently of model, request type, input and identity', () => {
  for (const [kind, text] of [['conversation_title', templates.conversation_title],
    ['conversation_title', templates.conversation_title_legacy], ['terminal_input_check', templates.terminal_input_check], ['web_search', templates.web_search]]) {
    for (const requestType of [undefined, 'checkpoint', 'chat', 'future-type']) {
      const capture = {...body(text), requestType, model: 'unrelated-model'};
      delete capture.request.contents;
      const result = decide(capture);
      assert.equal(result.purpose?.kind, kind);
      assert.ok(result.purpose.templateId);
      assert.deepEqual(result.purpose.evidence, ['request.systemInstruction.parts[0].text']);
      assert.equal(result.session.status, 'unresolved');
      assert.equal(result.turn.status, 'unresolved');
      capture.request.labels = {cascade_id: A};
      assert.equal(decide(capture).session.value, A);
      capture.requestId = `agent/${B}/1/${B}/1`;
      assert.equal(decide(capture).session.status, 'conflict');
      assert.equal(decide(capture).purpose.kind, kind);
    }
  }
});

test('purpose never comes from user text, response words, approximate templates or ambiguous system parts', () => {
  const text = templates.conversation_title;
  const cases = [body(text + ' '), body(text.replace('title generator', 'title reviewer')), body('title YES NO'), body(templates.web_search + ' '), {request:{tools:[{googleSearch:{}}]}}, {requestType:'web_search',model:'search-model'},
    {request: {contents: [{role: 'user', parts: [{text}]}]}},
    {request: {systemInstruction: {parts: [{text}, {text: 'extra instructions'}]}}},
    {request: {systemInstruction: {parts: [{text, inlineData: {mimeType: 'image/png', data: 'synthetic'}}]}}},
    {request: {systemInstruction: text}}, {}, null];
  for (const capture of cases) assert.equal(decide(capture).purpose, undefined);
});

test('purpose projections replay older records, preserve failures and raw content, survive reopen and clear with expiry', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-purpose-')), file = path.join(dir, 'lens.db');
  let storage = new StorageEngine(file);
  t.after(() => {storage.close(); fs.rmSync(dir, {recursive: true, force: true});});
  const raw = JSON.stringify(body(templates.terminal_input_check));
  const id = storage.insertRecord({agent_name: 'Antigravity', request_body: raw, status_code: 502, capture_status: 'error', input_tokens: 10, output_tokens: 0});
  await storage.getAttributedSessions();
  storage.db.prepare("UPDATE request_attributions SET rule_version='3',facts=?,decision=? WHERE record_id=?").run(
    JSON.stringify({session: {status: 'unresolved', reason: 'missing_session', evidence: []}, fields: {}}),
    JSON.stringify({agentId: 'antigravity', ruleVersion: '3', session: {status: 'unresolved', reason: 'missing_session', evidence: []}, turn: {status: 'unresolved', reason: 'missing_session', evidence: []}}), id);
  storage.close(); storage = new StorageEngine(file);
  let sessions = await storage.getAttributedSessions();
  assert.equal(sessions[0].tasks[0].turns[0].assignment.purpose?.kind, 'terminal_input_check');
  assert.equal(sessions[0].tasks_count, 0);
  assert.equal(sessions[0].tasks[0].turns[0].turn_type, 'error');
  assert.equal(storage.getRequestBody(id), raw);
  const saved = new AttributionRepository(storage.db).readAll().find(row => row.version === adapter.version);
  assert.equal(saved.facts.purpose.kind, 'terminal_input_check');
  assert.equal(saved.decision.purpose.templateId, saved.facts.purpose.templateId);
  storage.close(); storage = new StorageEngine(file);
  assert.equal((await storage.getAttributedSessions())[0].tasks[0].user_prompt, '终端输入等待检测');
  storage.clearRecords();
  sessions = await storage.getAttributedSessions();
  assert.ok(!JSON.stringify(sessions).includes('terminal_input_check'));
});

test('navigation collections preserve canonical identity and count requests once without inventing turns', async () => {
  const {createServer} = await import('vite');
  const vuePlugin = (await import('@vitejs/plugin-vue')).default;
  const server = await createServer({configFile: false, root: path.resolve(__dirname, '..'), plugins: [vuePlugin()], server: {middlewareMode: true, watch: null, hmr: false, ws: false}, appType: 'custom'});
  try {
    const {requestNavigationGroups} = await server.ssrLoadModule('/src/renderer/utils/requestNavigation.ts');
    const linked = body(templates.conversation_title); linked.request.labels = {cascade_id: A};
    const canonical = attributionView([item(1, decide(body(templates.conversation_title))), item(2, decide(body(templates.terminal_input_check))), item(3, decide(linked)), item(4, decide({}))]);
    const unchanged = structuredClone(canonical);
    const groups = requestNavigationGroups(canonical);
    assert.deepEqual(canonical, unchanged);
    assert.equal(canonical.reduce((n, g) => n + g.turns_count, 0), 4);
    assert.equal(canonical.reduce((n, g) => n + g.total_input_tokens, 0), 40);
    const aux = groups.find(g => g.kind === 'auxiliary'), other = groups.find(g => g.kind === 'pending');
    assert.equal(aux.title, '辅助请求'); assert.equal(aux.tasks_count, 0); assert.equal(aux.turns_count, 3);
    assert.equal(aux.total_input_tokens, 30);
    assert.deepEqual(aux.tasks.map(t => [t.user_prompt, t.turns.map(r => r.record_id)]), [['标题生成', [1, 3]], ['终端输入等待检测', [2]]]);
    assert.equal(other.title, '其他请求'); assert.equal(other.turns_count, 1);
    assert.deepEqual(other.tasks[0].turns.map(r => r.record_id), [4]);
    assert.equal(groups.find(g => g.session_id === A).tasks[0].turns[0].record_id, 3);
    assert.equal(requestNavigationGroups(attributionView([item(1, decide(body(templates.conversation_title)))])).length, 1);
    const {sessionNavigation} = await server.ssrLoadModule('/src/renderer/utils/sessionNavigation.ts');
    assert.deepEqual(sessionNavigation(aux, aux.tasks[1].id).turns.map(r => r.record_id), [2]);
    const {default: SessionList} = await server.ssrLoadModule('/src/renderer/components/session/SessionList.vue');
    const {createSSRApp} = require('vue'), {renderToString} = require('vue/server-renderer');
    const html = await renderToString(createSSRApp(SessionList, {currentTabInfo: {label: 'Antigravity', iconImg: ''}, sessions: groups, selectedSessionId: aux.id, selectedTaskId: aux.tasks[1].id, loadError: null}));
    assert.match(html, /1 个会话/); assert.match(html, /标题生成/); assert.match(html, /终端输入等待检测/);
    assert.doesNotMatch(html, /待归属|待识别|0 个轮次|missing_session/);
    const {default: Header} = await server.ssrLoadModule('/src/renderer/components/session/SessionDetailHeader.vue');
    const header = await renderToString(createSSRApp(Header, {session: aux.tasks[1], turns: aux.tasks[1].turns, selectedRecordId: 2, selectedRecord: {id: 2, model: 'selected-model'}, activeTab: 'messages'}));
    assert.match(header, /selected-model/); assert.match(header, /aria-label="当前用途"/);
    assert.match(header, /终端输入等待检测/);
  } finally {await server.close();}
});

test('Electron and Web keep auxiliary purpose selection through refresh and never count collections as conversations', async t => {
  const {createServer} = await import('vite');
  const server = await createServer({configFile: false, root: path.resolve(__dirname, '..'), server: {middlewareMode: true, watch: null, hmr: false, ws: false}, appType: 'custom'});
  const originalWindow = global.window, originalFetch = global.fetch;
  t.after(async () => {global.window = originalWindow; global.fetch = originalFetch; await server.close();});
  const {useSessions} = await server.ssrLoadModule('/src/renderer/composables/useSessions.ts');
  for (const mode of ['Electron', 'Web']) {
    let records = [item(1, decide(body(templates.conversation_title))), item(2, decide(body(templates.terminal_input_check)))];
    const list = () => ({sessions: attributionView(records)});
    const detail = id => ({id, raw_loaded: true, request_body: '{}'});
    global.window = mode === 'Electron' ? {electronAPI: {getStats: async () => ({total_tokens: 24}), getSessions: async () => list(), getRecordsByIds: async ids => ids.map(detail), getRecordDetail: async id => detail(id)}} : {};
    global.fetch = async (url, options) => ({ok: true, json: async () => {
      if (url === '/api/stats') return {total_tokens: 24};
      if (url.startsWith('/api/sessions')) return list();
      if (url === '/api/records/batch') return {records: JSON.parse(options.body).ids.map(detail)};
      return detail(Number(url.split('/').at(-1)));
    }});
    const state = useSessions(); state.activeAgent.value = 'Antigravity';
    await state.fetchData();
    const aux = state.filteredSessions.value.find(g => g.kind === 'auxiliary');
    await state.selectSession(aux); await state.selectTask(aux.tasks[1]);
    assert.equal(state.currentSession.value.user_prompt, '终端输入等待检测', mode);
    assert.equal(state.currentRecord.value.id, 2, mode);
    assert.equal(state.agentTabs.value.find(g => g.id === 'Antigravity').count, 0, mode);
    records.push(item(3, decide(body(templates.terminal_input_check))));
    await state.fetchData();
    assert.equal(state.selectedId.value, 2, mode);
    assert.deepEqual(state.currentSession.value.turns.map(r => r.record_id), [2, 3], mode);
    assert.equal(state.stats.value.total_tokens, 24, mode);
    state.searchQuery.value = '终端输入等待检测';
    assert.equal(state.filteredSessions.value.length, 1, mode);
    state.searchQuery.value = 'synthetic';
    assert.equal(state.filteredSessions.value.length, 1, mode);
    state.searchQuery.value = '';
    records = [];
    await state.fetchData();
    assert.equal(state.selectedSessionId.value, null, mode);
    assert.equal(state.currentSession.value, null, mode);
  }
});

test('request collections share the chronological stream and use only their own remaining request timestamps', async () => {
  const {createServer} = await import('vite');
  const vuePlugin = (await import('@vitejs/plugin-vue')).default;
  const server = await createServer({configFile: false, root: path.resolve(__dirname, '..'), plugins: [vuePlugin()], server: {middlewareMode: true, watch: null, hmr: false, ws: false}, appType: 'custom'});
  try {
    const {requestNavigationGroups} = await server.ssrLoadModule('/src/renderer/utils/requestNavigation.ts');
    const linked = body('normal system'); linked.request.labels = {cascade_id: A};
    const at = (id, decision, day) => {const entry = item(id, decision); entry.record.created_at = `2026-01-0${day}T00:00:00Z`; return entry;};
    const canonical = attributionView([at(1, decide({}), 1), at(2, decide(linked), 2), at(3, decide(body(templates.conversation_title)), 3)]);
    const groups = requestNavigationGroups(canonical);
    assert.deepEqual(groups.map(g => g.kind), ['auxiliary', 'session', 'pending']);
    assert.equal(groups[2].updated_at, '2026-01-01T00:00:00Z');
    assert.equal(groups[2].created_at, '2026-01-01T00:00:00Z');
    assert.deepEqual(requestNavigationGroups([...canonical].reverse()), groups, 'input order does not affect stream order');
    const {default: SessionList} = await server.ssrLoadModule('/src/renderer/components/session/SessionList.vue');
    const {createSSRApp} = require('vue'), {renderToString} = require('vue/server-renderer');
    const render = sessions => renderToString(createSSRApp(SessionList, {currentTabInfo: {label: 'Antigravity', iconImg: ''}, sessions, selectedSessionId: groups[0].id, loadError: null}));
    const html = await render(groups);
    assert.match(html, /aria-label="请求时间流"/);
    assert.doesNotMatch(html, /aria-label="请求分类"/);
    assert.equal((html.match(/data-navigation-kind=/g) || []).length, 3);
    assert.ok(html.indexOf('data-navigation-kind="auxiliary"') < html.indexOf('data-navigation-kind="session"'));
    assert.ok(html.indexOf('data-navigation-kind="session"') < html.indexOf('data-navigation-kind="pending"'));
    assert.match(html, /aria-label="辅助请求用途"/);
    assert.match(html, /1 个会话/);
    const many = [...Array.from({length: 35}, (_, n) => ({...groups[1], id: `session-${n}`})), groups[0], groups[2]];
    const limited = await render(many);
    assert.equal((limited.match(/data-navigation-kind=/g) || []).length, 35);
    assert.doesNotMatch(limited, /data-navigation-kind="auxiliary"|data-navigation-kind="pending"/);
    assert.match(limited, /35 \/ 37 项/);
  } finally {await server.close();}
});
