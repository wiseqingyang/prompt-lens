const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {codexAdapter:adapter}=require('../dist/main/attribution/adapters/codex');
const {attributionView}=require('../dist/main/attribution/view');
const {StorageEngine}=require('../dist/main/storage');
const {AttributionRepository}=require('../dist/main/attribution/repository');
const body=(thread='a',turn,kind='turn')=>({type:'response.create',client_metadata:{thread_id:thread,turn_id:turn,
  'x-codex-turn-metadata':JSON.stringify({thread_id:thread,turn_id:turn,request_kind:kind})},input:[]});
const warm=(thread='a')=>({...body(thread,'','prewarm'),generate:false});
const capture=b=>({agentName:'Codex',schemaVersion:'3.0.0',transport:'wss',body:b,capturedAt:'2026-01-02T00:00:00Z'});
const decide=b=>adapter.resolve({facts:adapter.extract(capture(b)),native:{status:'not_required'},capturedAt:'2026-01-02T00:00:00Z'});
const item=(id,b)=>({record:{id,agent_name:'Codex',created_at:'2026-01-02 00:00:00',status_code:200,input_tokens:2,output_tokens:1},decision:decide(b)});

test('Codex product turns: default, continuation, background and late old turns never create an unassigned group',()=>{
  const conflict=body('a','second');conflict.client_metadata['x-codex-turn-metadata']=JSON.stringify({thread_id:'a',turn_id:'other',request_kind:'turn'});
  const rows=[body(),warm(),body('a','first'),body('a','memory','memory'),body(),body('a','second'),body('a','first'),body(),body('a','first','compaction'),body(),conflict,body('b')].map((b,i)=>item(i+1,b));
  const original=structuredClone(rows),sessions=attributionView(rows),s=sessions.find(s=>s.session_id==='a');
  assert.equal(s.tasks_count,3);assert.ok(s.tasks.every(t=>t.kind==='turn'));
  assert.deepEqual(s.tasks.map(t=>t.turns.map(r=>r.record_id)),[[1,2],[3,4,5,7,9],[6,8,10,11]]);
  assert.equal(s.tasks[0].user_prompt,'未识别名称');assert.equal(s.tasks[0].native_input_index,undefined);
  assert.equal(s.tasks[0].turns[0].assignment.turn.reason,'missing_turn');
  assert.equal(s.tasks[1].turns.find(r=>r.record_id===4).assignment.turn.value.id,'memory','native identity survives product grouping');
  assert.equal(s.tasks[2].turns.find(r=>r.record_id===11).assignment.turn.status,'conflict');
  assert.equal(sessions.find(s=>s.session_id==='b').tasks_count,1);
  assert.equal(sessions.reduce((n,s)=>n+s.total_input_tokens,0),24);
  assert.equal(sessions.reduce((n,s)=>n+s.total_output_tokens,0),12);
  assert.deepEqual(rows,original);assert.deepEqual(attributionView([...rows].reverse()),sessions);
});

test('Codex purpose: canonical metadata proves purpose independently of session, model or user text',()=>{
  for(const [b,kind] of [[warm(),'prewarm'],[body('a','m','memory'),'memory'],[body('a','c','compaction'),'context_compaction']]){
    const result=decide(b);assert.equal(result.purpose?.kind,kind);assert.ok(result.purpose.ruleId);
    const missing=structuredClone(b);delete missing.client_metadata.thread_id;const meta=JSON.parse(missing.client_metadata['x-codex-turn-metadata']);delete meta.thread_id;missing.client_metadata['x-codex-turn-metadata']=JSON.stringify(meta);
    assert.equal(decide(missing).purpose.kind,kind);assert.equal(decide(missing).session.reason,'missing_session');
    const conflict=structuredClone(b);conflict.client_metadata.thread_id='different';assert.equal(decide(conflict).purpose.kind,kind);assert.equal(decide(conflict).session.status,'conflict');
  }
  assert.equal(decide(body('a','m','memory')).turnBehavior,'continue');
  assert.equal(decide(warm()).turnBehavior,'continue');
  assert.equal(decide(body('a','c','compaction')).turnBehavior,undefined);
  const flat={type:'response.create',client_metadata:{thread_id:'a',request_kind:'memory'},input:[{role:'user',content:'prewarm memory'}]};
  for(const b of [flat,{...warm(),generate:true},{...warm(),generate:'false'},body('a','valid','prewarm'),body('a','x','memory '),body('a','x','unknown')])assert.equal(decide(b).purpose,undefined);
  const invalid=body('a','m','memory');invalid.client_metadata['x-codex-turn-metadata']='{broken';assert.equal(decide(invalid).purpose,undefined);
  const http=body('a','m','memory');delete http.type;
  const input={...capture(http),transport:'https',headers:{'x-codex-turn-metadata':JSON.stringify({thread_id:'a',turn_id:'m',request_kind:'turn'})}};
  assert.equal(adapter.resolve({facts:adapter.extract(input),native:{status:'not_required'},capturedAt:input.capturedAt}).purpose,undefined,'conflicting applicable scopes never select a purpose');
});

function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'lens-codex-products-')),file=path.join(root,'db.sqlite'),h={root,file,s:new StorageEngine(file)};
  t.after(async()=>{await h.s.stopAttributionCollection();h.s.close();fs.rmSync(root,{recursive:true,force:true});});return h;}
const add=(s,b)=>s.insertRecord({agent_name:'Codex',provider:'openai',schema_version:'3.0.0',transport:'wss',method:'GET',status_code:101,attribution:'request',capture_status:'complete',model:'synthetic',request_body:JSON.stringify(b),token_source:'reported',input_tokens:2,output_tokens:1,total_tokens:3});

test('Codex v4 replay changes product groups while preserving raw captures, native indexes and usage',async t=>{
  const h=fixture(t),ids=[warm(),body('a','first'),body('a','memory','memory'),body(),body('a','second')].map(b=>add(h.s,b));
  const raw=ids.map(id=>h.s.getRequestBody(id)),stats=h.s.getStats();await h.s.getAttributedSessions();
  const repo=new AttributionRepository(h.s.db);
  for(const r of repo.readAll()){const d={...r.decision};delete d.turnGrouping;delete d.turnBehavior;delete d.purpose;d.ruleVersion='4';const f={...r.facts};delete f.purpose;
    h.s.db.prepare('UPDATE request_attributions SET rule_version=?,facts=?,decision=? WHERE record_id=?').run('4',JSON.stringify(f),JSON.stringify(d),r.recordId);}
  h.s.close();h.s=new StorageEngine(h.file);const sessions=await h.s.getAttributedSessions();
  assert.deepEqual(sessions[0].tasks.map(t=>t.turns.map(r=>r.record_id)),[[ids[0]],[ids[1],ids[2],ids[3]],[ids[4]]]);
  assert.equal(h.s.getRecordById(ids[2]).turn_id,'memory');assert.equal(h.s.getRecordById(ids[3]).turn_id,'');
  assert.deepEqual(ids.map(id=>h.s.getRequestBody(id)),raw);assert.deepEqual(h.s.getStats(),stats);
  const before=h.s.db.prepare('SELECT total_changes() n').get().n;assert.deepEqual(await h.s.getAttributedSessions(),sessions);
  assert.equal(h.s.db.prepare('SELECT total_changes() n').get().n,before);
  h.s.close();h.s=new StorageEngine(h.file);assert.deepEqual(await h.s.getAttributedSessions(),sessions);
  h.s.db.prepare('UPDATE records SET request_body=? WHERE id=?').run(JSON.stringify(body('a','first')),ids[0]);
  const changed=await h.s.getAttributedSessions();assert.equal(changed[0].tasks_count,2);assert.ok(changed[0].tasks.every(t=>t.kind==='turn'));
  h.s.db.prepare('DELETE FROM records WHERE id=?').run(ids[4]);assert.equal((await h.s.getAttributedSessions())[0].tasks_count,1);
  h.s.clearRecords();assert.ok((await h.s.getAttributedSessions()).every(s=>s.kind==='pending'));
});

test('Codex unknown sessions retain purpose navigation and timeline labels without inventing a shared turn',async t=>{
  const {createServer}=await import('vite'),vue=(await import('@vitejs/plugin-vue')).default;
  const server=await createServer({configFile:false,root:path.resolve(__dirname,'..'),plugins:[vue()],server:{middlewareMode:true,watch:null,hmr:false,ws:false},appType:'custom'});t.after(()=>server.close());
  const {requestNavigationGroups}=await server.ssrLoadModule('/src/renderer/utils/requestNavigation.ts');
  const {buildChatTimelineTurns}=await server.ssrLoadModule('/src/renderer/utils/messageParser.ts');
  const missing=b=>{delete b.client_metadata.thread_id;const m=JSON.parse(b.client_metadata['x-codex-turn-metadata']);delete m.thread_id;b.client_metadata['x-codex-turn-metadata']=JSON.stringify(m);return b;};
  const canonical=attributionView([item(1,missing(warm())),item(2,missing(body('a','m','memory'))),item(3,{type:'response.create'}),item(4,warm('known'))]);
  const groups=requestNavigationGroups(canonical),aux=groups.find(s=>s.kind==='auxiliary'),pending=groups.find(s=>s.kind==='pending');
  assert.deepEqual(aux.tasks.map(t=>t.user_prompt),['预热','后台记忆任务']);assert.deepEqual(pending.tasks.flatMap(t=>t.turns.map(r=>r.record_id)),[3]);
  assert.ok(groups.find(s=>s.session_id==='known').tasks.every(t=>t.kind==='turn'));
  const task=aux.tasks.find(t=>t.user_prompt==='预热'),turns=buildChatTimelineTurns(task,{});assert.equal(turns[0].purpose.kind,'prewarm');
  const {default:Timeline}=await server.ssrLoadModule('/src/renderer/components/timeline/TimelineView.vue');
  const {createSSRApp}=require('vue'),{renderToString}=require('vue/server-renderer');
  const html=await renderToString(createSSRApp(Timeline,{turns,isLoading:false}));assert.match(html,/请求用途/);assert.match(html,/预热/);assert.doesNotMatch(html,/missing_turn|missing_session/);
});
