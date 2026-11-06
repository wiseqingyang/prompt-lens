const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const {codexAdapter: adapter} = require('../dist/main/attribution/adapters/codex');
const {StorageEngine} = require('../dist/main/storage');
const {AttributionRepository} = require('../dist/main/attribution/repository');
const {captureInput} = require('../dist/main/attribution/capture');
const {ContentStore} = require('../dist/main/content-store');
const frames = {
  usage_limit: {type: 'error', error: {type: 'usage_limit_reached', message: 'synthetic quota'}, status_code: 429},
  connection_limit: {type: 'error', error: {type: 'invalid_request_error', code: 'websocket_connection_limit_reached', message: 'synthetic limit'}, status: 400},
  server_error: {type: 'error', error: {type: 'server_error', code: 'server_error', message: 'synthetic service error'}, status: 503}
};
const envelope = frame => ({format: 'ws-messages-v1', messages: [{direction: 'server', sequence: 1, payload: JSON.stringify(frame)}]});
const record = frame => ({agent_name: 'Codex', model: 'unknown', schema_version: '3.0.0', transport: 'wss', method: 'GET', status_code: 101,
  attribution: 'connection', capture_status: 'error', truncated_reason: 'websocket_connection_error_unattributed',
  request_body: '', response_body: JSON.stringify(envelope(frame)), input_tokens: 0, output_tokens: 0});
const input = frame => captureInput(record(frame), '', JSON.stringify(envelope(frame)));
const decide = capture => adapter.resolve({facts: adapter.extract(capture), capturedAt: '', native: {status: 'not_required'}});

test('connection issue matches only the three captured field combinations and preserves unresolved identity', () => {
  for (const [kind, frame] of Object.entries(frames)) {
    const capture = input(frame), result = decide(capture);
    assert.equal(result.connectionIssue?.kind, kind);
    assert.equal(result.connectionIssue.ruleVersion, '1');
    assert.equal(result.connectionIssue.statusCode, frame.status || frame.status_code);
    assert.ok(result.connectionIssue.evidence.includes('response_body.messages[0].payload.response_id:absent'));
    assert.equal(result.session.reason, 'connection_only');
    assert.equal(result.turn.reason, 'connection_only');
    assert.equal(result.purpose, undefined);
    assert.deepEqual(decide(capture), result, 'same facts produce the same result');
    const changed = structuredClone(frame); changed.error.message = 'unrelated prose';
    const other = record(changed); other.model = 'different-model';
    assert.equal(decide(captureInput(other, '', other.response_body)).connectionIssue.kind, kind);
  }
});

test('connection issue rejects every scope, structure, identity and error-code counterexample', () => {
  const base = input(frames.usage_limit);
  const cases = [];
  for (const [key, value] of Object.entries({agentName:'Antigravity', schemaVersion:'2.0.0', transport:'https', method:'POST', statusCode:429, attribution:'request', contentExpired:true})) {
    cases.push({...base, [key]:value});
  }
  for (const [key,value] of [['requestBodyEmpty',false],['captureStatus','complete'],['truncatedReason','other']]) {
    cases.push({...base, connection:{...base.connection,[key]:value}});
  }
  cases.push({...base,connection:undefined});
  for (const response of [null, [], {}, {format:'other',messages:[]}, {format:'ws-messages-v1',messages:[]},
    {format:'ws-messages-v1',messages:[...envelope(frames.usage_limit).messages,...envelope(frames.usage_limit).messages]},
    {format:'ws-messages-v1',messages:[{direction:'client',payload:JSON.stringify(frames.usage_limit)}]},
    {format:'ws-messages-v1',messages:[{direction:'server',payload:frames.usage_limit}]},
    {format:'ws-messages-v1',messages:[{direction:'server',payload:'invalid JSON'}]}]) cases.push({...base,connection:{...base.connection,response}});
  const badFrames = [null, [], {}, {...frames.usage_limit,type:'response.completed'}, {...frames.usage_limit,error:null},
    {...frames.usage_limit,error:[]}, {...frames.usage_limit,error:{message:'usage_limit_reached'}},
    {...frames.usage_limit,status_code:'429'}, {...frames.usage_limit,status_code:undefined},
    {...frames.usage_limit,status_code:503}, {...frames.usage_limit,status:429},
    {...frames.usage_limit,error:{type:'usage_limit_reached',code:null}},
    {...frames.connection_limit,status_code:400}, {...frames.connection_limit,status:'400'},
    {...frames.connection_limit,status:503}, {...frames.server_error,error:{type:'server_error',code:'different'}},
    {...frames.server_error,error:{type:'invalid_request_error',code:'server_error'}},
    {...frames.server_error,status:400}, {...frames.server_error,status_code:503}];
  for (const key of ['stream_id','response_id','response']) for (const value of ['',null,42,{},'assigned']) badFrames.push({...frames.usage_limit,[key]:value});
  for (const frame of badFrames) cases.push(input(frame));
  for (const capture of cases) assert.equal(decide(capture).connectionIssue, undefined, JSON.stringify(capture));
});

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lens-connection-')),file=path.join(root,'lens.db');
  const holder={root,file,storage:new StorageEngine(file)};
  t.after(()=>{holder.storage.close();fs.rmSync(root,{recursive:true,force:true});});
  return holder;
}
const assignment = (sessions,id) => sessions.flatMap(s=>s.tasks.flatMap(t=>t.turns)).find(r=>r.record_id===id)?.assignment;

test('connection classification replays old projections and invalidates changed response and capture state', async t => {
  const h=fixture(t), raw=record(frames.usage_limit),id=h.storage.insertRecord(raw);
  assert.equal(assignment(await h.storage.getAttributedSessions(),id).connectionIssue.kind,'usage_limit');
  h.storage.db.prepare("UPDATE request_attributions SET rule_version='3',facts=?,decision=? WHERE record_id=?").run(
    JSON.stringify({session:{status:'unresolved',reason:'connection_only',evidence:[]},fields:{}}),
    JSON.stringify({agentId:'codex',ruleVersion:'3',session:{status:'unresolved',reason:'connection_only',evidence:[]},turn:{status:'unresolved',reason:'connection_only',evidence:[]}}),id);
  h.storage.db.exec('DROP TRIGGER invalidate_connection_attribution; PRAGMA user_version=15');
  h.storage.close();h.storage=new StorageEngine(h.file);
  assert.equal(h.storage.db.pragma('user_version',{simple:true}), 19);
  assert.equal(assignment(await h.storage.getAttributedSessions(),id).connectionIssue.kind,'usage_limit');
  assert.equal(h.storage.getRecordById(id).response_body,raw.response_body);
  const before=h.storage.getStats();
  while(new ContentStore(h.storage.db).migrateOne()) {}
  assert.equal(assignment(await h.storage.getAttributedSessions(),id).connectionIssue.kind,'usage_limit');
  const next=JSON.stringify(envelope(frames.connection_limit));
  h.storage.db.prepare('UPDATE records SET response_body=? WHERE id=?').run(next,id);
  assert.equal(assignment(await h.storage.getAttributedSessions(),id).connectionIssue.kind,'connection_limit');
  assert.equal(h.storage.getRecordById(id).response_body,next);
  for(const field of ['capture_status','truncated_reason']) {
    const original=h.storage.db.prepare(`SELECT ${field} value FROM records WHERE id=?`).get(id).value;
    h.storage.db.prepare(`UPDATE records SET ${field}=? WHERE id=?`).run('unverified',id);
    assert.equal(assignment(await h.storage.getAttributedSessions(),id).connectionIssue,undefined);
    h.storage.db.prepare(`UPDATE records SET ${field}=? WHERE id=?`).run(original,id);
    assert.equal(assignment(await h.storage.getAttributedSessions(),id).connectionIssue.kind,'connection_limit');
  }
  assert.deepEqual(h.storage.getStats(),before);
  h.storage.close();h.storage=new StorageEngine(h.file);
  assert.equal(assignment(await h.storage.getAttributedSessions(),id).connectionIssue.kind,'connection_limit');
  h.storage.clearRecords();
  assert.equal(assignment(await h.storage.getAttributedSessions(),id)?.connectionIssue,undefined);
});

test('v16 connection invalidation migration rolls back on failure and can be retried', async t => {
  const h=fixture(t),raw=record(frames.server_error),id=h.storage.insertRecord(raw);
  h.storage.db.exec('DROP TRIGGER invalidate_connection_attribution; PRAGMA user_version=15');h.storage.close();
  const install=AttributionRepository.installConnectionInvalidation;
  try {
    AttributionRepository.installConnectionInvalidation=db=>{install(db);throw new Error('synthetic v16 failure');};
    assert.throws(()=>new StorageEngine(h.file),/synthetic v16 failure/);
  } finally {AttributionRepository.installConnectionInvalidation=install;}
  const db=new Database(h.file,{readonly:true});
  try {
    assert.equal(db.pragma('user_version',{simple:true}),15);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='invalidate_connection_attribution'").get(),undefined);
    assert.equal(new ContentStore(db).read(id,'response_body',db.prepare('SELECT response_body FROM records WHERE id=?').get(id).response_body),raw.response_body);
  } finally {db.close();}
  h.storage=new StorageEngine(h.file);
  assert.equal(h.storage.db.pragma('user_version',{simple:true}), 19);
  assert.equal(assignment(await h.storage.getAttributedSessions(),id).connectionIssue.kind,'server_error');
});

test('connection collections and web search preserve accounting, selection and semantic status in Electron and Web', async t => {
  const h=fixture(t),ids=Object.values(frames).map(frame=>h.storage.insertRecord(record(frame)));
  const unmatched=h.storage.insertRecord(record({...frames.server_error,error:{type:'other'}}));
  h.storage.insertRecord({...record(frames.server_error),attribution:'request',request_body:JSON.stringify({type:'response.create',client_metadata:{thread_id:'thread-a',turn_id:'turn-a'}}),capture_status:'complete',truncated_reason:'',input_tokens:5});
  const templates=require('./fixtures/antigravity-purpose.json');
  const search=h.storage.insertRecord({agent_name:'Antigravity',model:'synthetic-search',request_body:JSON.stringify({request:{systemInstruction:{parts:[{text:templates.web_search}]}},requestType:'future'}),input_tokens:3,status_code:502,capture_status:'error'});
  const canonical=await h.storage.getAttributedSessions(),stats=h.storage.getStats();
  const {createServer}=await import('vite'),vuePlugin=(await import('@vitejs/plugin-vue')).default;
  const server=await createServer({configFile:false,root:path.resolve(__dirname,'..'),plugins:[vuePlugin()],server:{middlewareMode:true,watch:null,hmr:false,ws:false},appType:'custom'});
  const originalWindow=global.window,originalFetch=global.fetch;
  t.after(async()=>{global.window=originalWindow;global.fetch=originalFetch;await server.close();});
  const {requestNavigationGroups,isConversation}=await server.ssrLoadModule('/src/renderer/utils/requestNavigation.ts');
  const groups=requestNavigationGroups(canonical),connections=groups.find(g=>g.kind==='connection');
  assert.equal(groups.filter(isConversation).length,1);
  assert.equal(connections.title,'连接异常');assert.equal(connections.tasks_count,0);assert.equal(connections.turns_count,3);
  assert.deepEqual(connections.tasks.map(t=>t.user_prompt),['额度耗尽','连接时长达到上限','服务端错误']);
  assert.deepEqual(groups.find(g=>g.kind==='pending').tasks.flatMap(t=>t.turns.map(r=>r.record_id)),[unmatched]);
  const aux=groups.find(g=>g.kind==='auxiliary');assert.equal(aux.tasks[0].user_prompt,'网页搜索');
  assert.equal(aux.tasks[0].turns[0].record_id,search);assert.equal(aux.tasks[0].turns[0].turn_type,'error');
  const {buildChatTimelineTurns}=await server.ssrLoadModule('/src/renderer/utils/messageParser.ts');
  const timeline=buildChatTimelineTurns(connections.tasks[0],{[ids[0]]:h.storage.getRecordById(ids[0])});
  assert.equal(timeline[0].statusCode,101,'original handshake status is preserved');
  assert.equal(timeline[0].connectionIssue.statusCode,429,'event status is separate');
  const {default:SessionList}=await server.ssrLoadModule('/src/renderer/components/session/SessionList.vue');
  const {createSSRApp}=require('vue'),{renderToString}=require('vue/server-renderer');
  const html=await renderToString(createSSRApp(SessionList,{currentTabInfo:{label:'Codex',iconImg:''},sessions:groups.filter(g=>g.agent_name==='Codex'),selectedSessionId:connections.id,loadError:null}));
  assert.match(html,/1 个会话/);assert.match(html,/3 次事件/);assert.match(html,/连接异常类型/);assert.match(html,/额度耗尽/);
  const {default:Timeline}=await server.ssrLoadModule('/src/renderer/components/timeline/TimelineView.vue');
  const timelineHtml=await renderToString(createSSRApp(Timeline,{turns:timeline,isLoading:false}));
  assert.match(timelineHtml,/连接异常 429/);assert.match(timelineHtml,/连接事件/);assert.match(timelineHtml,/额度耗尽/);
  assert.doesNotMatch(timelineHtml,/模型响应|PROMPT|101 Error/);
  const {useSessions}=await server.ssrLoadModule('/src/renderer/composables/useSessions.ts');
  for(const mode of ['Electron','Web']) {
    const list=()=>({sessions:canonical}),details=ids=>ids.map(id=>h.storage.getRecordById(id));
    global.window=mode==='Electron'?{electronAPI:{getStats:async()=>stats,getSessions:async()=>list(),getRecordsByIds:async ids=>details(ids),getRecordDetail:async id=>h.storage.getRecordById(id)}}:{};
    global.fetch=async(url,options)=>({ok:true,json:async()=>url==='/api/stats'?stats:url.startsWith('/api/sessions')?list():url==='/api/records/batch'?{records:details(JSON.parse(options.body).ids)}:h.storage.getRecordById(Number(url.split('/').at(-1)))});
    const state=useSessions();await state.fetchData();await state.selectSession(state.filteredSessions.value.find(g=>g.kind==='connection'));
    await state.selectTask(connections.tasks[1]);await state.fetchData();
    assert.equal(state.currentSession.value.user_prompt,'连接时长达到上限',mode);assert.equal(state.selectedId.value,ids[1],mode);
    assert.equal(state.agentTabs.value.find(t=>t.id==='Codex').count,1,mode);
    state.searchQuery.value='额度耗尽';assert.equal(state.filteredSessions.value.length,1,mode);
    assert.equal(state.filteredSessions.value[0].kind,'connection',mode);
  }
  assert.deepEqual(h.storage.getStats(),stats);
});
