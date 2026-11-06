const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StorageEngine } = require('../dist/main/storage');
const { AttributionRepository } = require('../dist/main/attribution/repository');
const ua = 'Codex Desktop/0.162.0-alpha.17.2';
const metadata = (thread='thread-a',turn='turn-a',kind='turn') => ({thread_id:thread,turn_id:turn,request_kind:kind});
const body = (thread='thread-a',turn='turn-a',kind='turn') => ({type:'response.create',client_metadata:{thread_id:thread,turn_id:turn,'x-codex-turn-metadata':JSON.stringify(metadata(thread,turn,kind))},input:[]});
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lens-codex-'));
  const storage=new StorageEngine(path.join(root,'lens.db'));
  t.after(async()=>{await storage.stopAttributionCollection();await storage.stopMaintenance();storage.close();fs.rmSync(root,{recursive:true,force:true});});
  return {storage,root};
}
function insert(storage,b=body(),extra={}) {
  return storage.insertRecord({agent_name:'Codex',provider:'openai',model:'fixture',schema_version:'2.0.0',transport:'wss',attribution:'request',method:'GET',status_code:101,request_headers:{'user-agent':ua},request_body:JSON.stringify(b),session_id:'thread-a',thread_id:'thread-a',turn_id:b?.client_metadata?.turn_id || '',session_confidence:'exact',input_tokens:11,output_tokens:2,total_tokens:13,duration_ms:5,...extra});
}
test('Codex: native turns survive steer, compaction, interleaving and identical prompts',async t=>{
  const {storage}=fixture(t);
  const a=insert(storage,body(),{user_prompt:'first'});
  const b=insert(storage,body('thread-a','turn-b'),{user_prompt:'first'});
  const c=insert(storage,body('thread-a','turn-a','compaction'),{user_prompt:'changed',finish_reason:'stop'});
  const d=insert(storage,body(),{user_prompt:'steer',tool_calls_json:'[{"name":"tool"}]'});
  const sessions=await storage.getAttributedSessions();
  assert.equal(sessions.length,1);assert.equal(sessions[0].tasks_count,2);
  assert.deepEqual(sessions[0].tasks.map(x=>x.turns.map(y=>y.record_id)),[[a,c,d],[b]]);
  assert.equal(sessions[0].tasks[0].is_completed,false,'a model response cannot complete a native turn');
  assert.equal(sessions[0].total_input_tokens,44);assert.equal(sessions[0].total_duration_ms,20);
  assert.deepEqual(await storage.getAttributedSessions(),sessions,'replay must be deterministic');
});

const { codexAdapter } = require('../dist/main/attribution/adapters/codex');
const { attributionView } = require('../dist/main/attribution/view');
const { captureProtocol } = require('../dist/shared/captureProtocol');
const { describeCommunication } = require('../dist/shared/communication');
const capture = (b=body(),extra={}) => ({agentName:'Codex',capturedAt:'2026-01-01T00:00:00Z',headers:{'user-agent':ua},transport:'wss',schemaVersion:'3.0.0',attribution:'request',body:b,...extra});
const decide = input => codexAdapter.resolve({facts:codexAdapter.extract(input),native:{status:'not_required'},capturedAt:input.capturedAt});
test('Codex: per-frame scope excludes handshake identities, including absent frame identity',()=>{
  const input=capture(body(),{headers:{'user-agent':ua,'thread-id':'old-thread','x-codex-turn-metadata':JSON.stringify(metadata('old-thread','old-turn'))}});
  assert.equal(decide(input).turn.value.id,'turn-a');
  assert.equal(decide(input).session.value,'thread-a');
  input.body={type:'response.create'};
  assert.equal(decide(input).session.reason,'missing_session');
  assert.equal(decide({...input,attribution:'connection'}).session.reason,'connection_only');
});
test('Codex: HTTP request headers remain usable with no body; contradictory copies stay conflicts',()=>{
  const input=capture(undefined,{body:undefined,transport:'https',schemaVersion:'2.0.0',headers:{'User-Agent':ua,'Thread-Id':'thread-a','X-Codex-Turn-Metadata':JSON.stringify(metadata())}});
  assert.equal(decide(input).turn.value.id,'turn-a');
  input.body=body('thread-b');
  assert.equal(decide(input).session.status,'conflict');
  input.body=body();input.body.client_metadata.turn_id='different';
  assert.equal(decide(input).session.value,'thread-a');assert.equal(decide(input).turn.status,'conflict');
  input.body.client_metadata.turn_id='';assert.equal(decide(input).turn.status,'conflict');
  input.headers['thread-id']='thread-b';assert.equal(decide(input).session.status,'conflict','duplicate header casing cannot hide conflicts');
});
test('Codex: rejected metadata, capture formats and misleading aliases cannot infer identity',()=>{
  for(const value of [null,[],42,'', '{broken','null','[]']) {
    const b=body();b.client_metadata['x-codex-turn-metadata']=value;
    assert.equal(decide(capture(b)).session.reason,'invalid_metadata',JSON.stringify(value));
  }
  for(const value of [null,[],42]) {const b=body();b.client_metadata=value;assert.equal(decide(capture(b)).session.reason,'invalid_metadata');}
  const aliases={type:'response.create',client_metadata:{session_id:'affinity',threadId:'not-supported',turnId:'not-supported'},metadata:{thread_id:'nested-is-not-identity'},prompt_cache_key:'shared'};
  assert.equal(decide(capture(aliases)).session.reason,'missing_session');
  assert.equal(decide(capture(body(),{schemaVersion:'99'})).session.reason,'unsupported_format');
  assert.equal(decide(capture(body(),{transport:'unknown'})).session.reason,'unknown_protocol');
  assert.equal(decide(capture(body(),{contentExpired:true})).session.reason,'content_unavailable');
});
test('Codex: prewarm and background memory have distinct semantics without inventing steps',()=>{
  const warm=body('thread-a','','prewarm');warm.generate=false;
  assert.equal(decide(capture(warm)).turn.reason,'prewarm');
  const memory=body('thread-a','memory-turn','memory');
  memory.client_metadata['x-codex-turn-metadata']=JSON.stringify({turn_id:'memory-turn',request_kind:'memory'});
  const decision=decide(capture(memory));
  assert.equal(decision.session.value,'thread-a');assert.equal(decision.turn.value.id,'memory-turn');
  assert.equal(decision.turnKind,'background');assert.equal(decision.turn.value.inputIndex,undefined);
  const serialized=JSON.stringify(capture(memory));decide(JSON.parse(serialized));assert.equal(serialized,JSON.stringify(capture(memory)));
});
test('legacy protocol evidence distinguishes WS from HTTP without inventing a secure scheme',()=>{
  const ws={schemaVersion:'2.0.0',method:'GET',statusCode:101,body:body(),headers:{Connection:'keep-alive, Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13'}};
  assert.equal(captureProtocol(ws).family,'websocket');
  assert.equal(captureProtocol({...ws,statusCode:200}).family,'unknown');
  const http={schemaVersion:'2.0.0',method:'POST',headers:{'content-type':'application/json'},body:{input:[]}};
  assert.equal(captureProtocol(http).family,'http');
  assert.equal(captureProtocol({...http,headers:{...http.headers,upgrade:'websocket'}}).family,'unknown');
  assert.equal(captureProtocol({...http,schemaVersion:'new'}).family,'unknown');
  assert.equal(describeCommunication({protocol_family:'websocket'}).transport,'WebSocket');
  assert.equal(describeCommunication({transport:'wss',protocol_family:'websocket'}).transport,'WSS');
});
test('Codex: group keys are independent of input order, isolate threads and do not make pending turns',()=>{
  const raw=[body(),body('thread-b'),body('thread-a','turn-b'),{type:'response.create'}];
  const items=raw.map((b,i)=>({record:{id:i+1,created_at:`2026-01-0${i+1}`,agent_name:'Codex',input_tokens:10,output_tokens:2,status_code:200},decision:decide(capture(b))}));
  const normal=attributionView(items);assert.deepEqual(attributionView([...items].reverse()),normal);
  assert.equal(normal.length,3);assert.equal(normal.find(x=>x.kind==='pending').tasks_count,0);
  assert.equal(normal.reduce((n,x)=>n+x.turns_count,0),4);
  assert.equal(normal.reduce((n,x)=>n+x.total_input_tokens,0),40);
});
test('Codex: insert, projection, indexed filters and replay share one decision and preserve captures',async t=>{
  const {storage}=fixture(t);const b=body('thread-b','turn-b');
  const id=insert(storage,b,{session_id:'obsolete',thread_id:'obsolete',turn_id:'obsolete'});
  assert.equal(storage.getRecords({sessionId:'thread-b'}).length,1,'indexes updated before navigation query');
  assert.equal(storage.getRecords({sessionId:'obsolete'}).length,0);
  const raw=storage.getRequestBody(id);const before=storage.db.prepare('SELECT total_changes() n').get().n;
  await storage.getAttributedSessions();await storage.getAttributedSessions();
  assert.equal(storage.getRequestBody(id),raw);
  assert.equal(storage.db.prepare('SELECT total_changes() n').get().n,before,'identical projections do not write again');
  const row=new AttributionRepository(storage.db).readAll()[0];assert.deepEqual(codexAdapter.resolve(row),row.decision);
  assert.equal(row.native.status,'not_required');
  storage.rebuildRecordIdentities();assert.equal(storage.getRecords({sessionId:'thread-b'}).length,1);
});
test('Codex: header changes invalidate decisions, missing identities clear indexes, raw transport stays absent',async t=>{
  const {storage}=fixture(t);
  const b=body();delete b.type;
  const headers={'user-agent':ua,'content-type':'application/json','thread-id':'thread-a','x-codex-turn-metadata':JSON.stringify(metadata())};
  const id=insert(storage,b,{transport:'',method:'POST',status_code:200,request_headers:headers});
  await storage.getAttributedSessions();assert.equal(storage.getRecordById(id).transport,'');
  assert.equal(storage.getRecordById(id).protocol_family,'http');
  headers['thread-id']='conflict';storage.db.prepare('UPDATE records SET request_headers=? WHERE id=?').run(JSON.stringify(headers),id);
  storage.attributionChanged();
  const sessions=await storage.getAttributedSessions();assert.equal(sessions[0].kind,'pending');
  assert.equal(storage.getRecords({sessionId:'thread-a'}).length,0);
  assert.equal(storage.getRecordById(id).thread_id,'');
});
test('Codex: projection transaction rolls back indexes and evidence together on failure',async t=>{
  const {storage}=fixture(t);const id=insert(storage);
  const original=new AttributionRepository(storage.db).readAll();
  storage.db.prepare('UPDATE records SET request_body=? WHERE id=?').run(JSON.stringify(body('thread-new')),id);
  const before=new AttributionRepository(storage.db).readAll();
  assert.equal(before[0].captureDigest,'','changed capture explicitly invalidates its projection');
  assert.deepEqual(before[0].decision,original[0].decision);
  storage.attributionChanged();
  storage.db.exec("CREATE TRIGGER reject_codex_update BEFORE UPDATE OF session_id ON records BEGIN SELECT RAISE(ABORT,'projection failure'); END");
  await assert.rejects(storage.getAttributedSessions(),/projection failure/);
  assert.deepEqual(new AttributionRepository(storage.db).readAll(),before);
  assert.equal(storage.getRecordById(id).session_id,'thread-a');
  storage.db.exec('DROP TRIGGER reject_codex_update');
  assert.equal((await storage.getAttributedSessions())[0].session_id,'thread-new');
});
test('Codex: cleared records cannot be resurrected by a stale projection job',async t=>{
  const {storage}=fixture(t);insert(storage);const repo=new AttributionRepository(storage.db),saved=repo.readAll();
  storage.clearRecords();repo.saveBatch(saved);
  assert.equal(repo.readAll().length,0);
  const sessions=await storage.getAttributedSessions();
  assert.equal(sessions[0].kind,'pending');assert.equal(sessions[0].tasks_count,0);
  assert.equal(storage.getRequestBody(saved[0].recordId),'');
  storage.deleteAllData();repo.saveBatch(saved);assert.equal((await storage.getAttributedSessions()).length,0);
});

test('Codex: a stale capture snapshot cannot overwrite newer persisted identity',async t=>{
  const {storage}=fixture(t);const id=insert(storage);const repo=new AttributionRepository(storage.db),old=repo.readAll();
  storage.db.prepare('UPDATE records SET request_body=? WHERE id=?').run(JSON.stringify(body('thread-new','turn-new')),id);
  storage.attributionChanged();await storage.getAttributedSessions();
  repo.saveBatch(old);
  assert.equal(storage.getRecordById(id).thread_id,'thread-new');assert.equal(repo.readAll()[0].decision.turn.value.id,'turn-new');
});
test('Codex: reopening v14 queues unprojected history and replays without any native log source',async t=>{
  const {storage,root}=fixture(t);const id=insert(storage);const raw=storage.getRequestBody(id);
  storage.db.exec('DELETE FROM request_attributions; DELETE FROM attribution_jobs');
  storage.db.prepare("UPDATE records SET session_id='obsolete', thread_id='obsolete', turn_id='obsolete'").run();
  const file=path.join(root,'lens.db');storage.close();const reopened=new StorageEngine(file);t.after(()=>reopened.close());
  assert.equal(reopened.db.pragma('user_version',{simple:true}), 19);
  assert.equal(reopened.getRecordById(id).session_confidence,'unknown','old indexes cannot link histories before replay');
  assert.deepEqual(new AttributionRepository(reopened.db).dueJobs(Date.now(),100),[id]);
  await reopened.collectAttributionEvidence('/synthetic/nonexistent/source',[id]);
  assert.equal(reopened.getRecordById(id).thread_id,'thread-a');assert.equal(reopened.getRequestBody(id),raw);
  assert.equal((await reopened.getAttributedSessions())[0].tasks_count,1);
  reopened.clearRecords();assert.equal(reopened.getRecordById(id).thread_id,'');
  assert.equal(reopened.getRecordById(id).turn_id,'');assert.equal(reopened.getRecords({sessionId:'thread-a'}).length,0);
});

test('Codex: HTTP header-only capture reaches indexed storage and the session API',async t=>{
  const {storage}=fixture(t);const {CoreManager}=require('../dist/main/core');const {WebServer}=require('../dist/main/web');
  const core=new CoreManager(storage);
  const id=core.handleCapturePayload({schema_version:'2.0.0',event_id:'http-error',request_id:'http-error',transport:'https',attribution:'request',method:'POST',status_code:502,capture_status:'error',url_path:'/backend-api/codex/responses',request_headers:{'user-agent':ua,'thread-id':'http-thread','x-codex-turn-metadata':JSON.stringify(metadata('http-thread','http-turn'))},request_body:'',response_body:''});
  assert.equal(storage.getRecordById(id).turn_id,'http-turn');assert.equal(storage.getRecords({sessionId:'http-thread'}).length,1);
  const web=new WebServer(storage,{},0);t.after(()=>web.app.close());
  const response=await web.app.inject({method:'GET',url:'/api/sessions'});
  assert.equal(response.statusCode,200);assert.equal(response.json().sessions[0].session_id,'http-thread');
  assert.equal(response.json().sessions[0].tasks[0].turns[0].record_id,id);
  const record=await web.app.inject({method:'GET',url:`/api/records/${id}`});
  assert.equal(record.json().protocol_family,'http');
  assert.equal(storage.getRecordsByIds([id],{lightweight:true})[0].protocol_family,'http');
});


test('Codex: current persisted projections never reread historical bodies for navigation',async t=>{
  const {storage}=fixture(t);
  for(let n=0;n<40;n++)insert(storage,{...body('thread-a','turn-'+n),input:'synthetic '.repeat(20000)});
  const {ContentStore}=require('../dist/main/content-store');
  const original=ContentStore.prototype.read;let reads=0;
  ContentStore.prototype.read=function(...args){if(args[1]==='request_body')reads++;return original.apply(this,args);};
  t.after(()=>{ContentStore.prototype.read=original;});
  const before=storage.db.prepare('SELECT total_changes() n').get().n;
  const first=await storage.getAttributedSessions();
  assert.equal(reads,0,'cold navigation uses persisted facts, not full captures');
  assert.deepEqual(await storage.getAttributedSessions(),first);
  assert.equal(reads,0,'unchanged refresh does not decode historical bodies');
  assert.equal(storage.db.prepare('SELECT total_changes() n').get().n,before);
  insert(storage,body('thread-b','turn-new'));reads=0;
  assert.equal((await storage.getAttributedSessions()).length,2);
  assert.equal(reads,0,'a new capture does not invalidate facts for the whole library');
});


test('Codex: changed inputs invalidate only their projection, including writes from another connection',async t=>{
  const {storage,root}=fixture(t);const ids=[];
  for(let n=0;n<24;n++)ids.push(insert(storage,body('thread-a','turn-'+n)));
  await storage.getAttributedSessions();
  const Database=require('better-sqlite3');const writer=new Database(path.join(root,'lens.db'));
  try {writer.prepare('UPDATE records SET request_body=? WHERE id=?').run(JSON.stringify(body('thread-other','turn-changed')),ids[0]);}finally{writer.close();}
  assert.equal(storage.db.prepare('SELECT capture_digest FROM request_attributions WHERE record_id=?').get(ids[0]).capture_digest,'');
  const {ContentStore}=require('../dist/main/content-store');const original=ContentStore.prototype.read;const readIds=[];
  ContentStore.prototype.read=function(...args){if(args[1]==='request_body')readIds.push(args[0]);return original.apply(this,args);};
  t.after(()=>{ContentStore.prototype.read=original;});
  const sessions=await storage.getAttributedSessions();
  assert.equal(sessions.find(s=>s.session_id==='thread-other').turns_count,1);
  assert.deepEqual([...new Set(readIds)],[ids[0]],'unchanged captures are not decoded');
  readIds.length=0;await storage.getAttributedSessions();assert.equal(readIds.length,0);
});

test('Codex: uncached replay yields and concurrent changes cannot be adopted into the list cache',async t=>{
  const {storage}=fixture(t);const ids=[];
  for(let n=0;n<24;n++)ids.push(insert(storage,body('thread-a','turn-'+n)));
  storage.db.exec('DELETE FROM request_attributions');let yielded=false;
  setImmediate(()=>{yielded=true;});
  const first=await storage.getAttributedSessions();assert.equal(yielded,true,'replay gives the event loop a turn before completing');
  assert.equal(first[0].turns_count,24);
  storage.attributionChanged();
  setImmediate(()=>storage.db.prepare('UPDATE records SET request_body=? WHERE id=?').run(JSON.stringify(body('thread-new','turn-new')),ids[0]));
  await storage.getAttributedSessions();
  const latest=await storage.getAttributedSessions();
  assert.equal(latest.find(s=>s.session_id==='thread-new').turns_count,1,'changes during a yielded query are not cached as old results');
});

test('Codex: collection reads projections only for its requested batch',async t=>{
  const {storage}=fixture(t);const ids=[];for(let n=0;n<20;n++)ids.push(insert(storage,body('thread-a','turn-'+n)));
  const original=AttributionRepository.prototype.readAll;const batches=[];
  AttributionRepository.prototype.readAll=function(selected){batches.push(selected);return original.call(this,selected);};
  t.after(()=>{AttributionRepository.prototype.readAll=original;});
  await storage.collectAttributionEvidence('/source-not-needed',[ids[0]]);
  assert.ok(batches.length>0);for(const batch of batches)assert.deepEqual(batch,[ids[0]]);
});

test('Codex: v14 projection invalidation migration is atomic and repeatable',async t=>{
  const {root}=fixture(t);const file=path.join(root,'v14.db');let db=new StorageEngine(file);
  const id=insert(db);const raw=db.getRequestBody(id);
  db.db.exec('DROP TRIGGER invalidate_capture_attribution');db.db.pragma('user_version=14');db.close();
  const install=AttributionRepository.installCaptureInvalidation;
  try {
    AttributionRepository.installCaptureInvalidation=connection=>{install(connection);throw new Error('synthetic v15 migration failure');};
    assert.throws(()=>new StorageEngine(file),/synthetic v15 migration failure/);
  }finally{AttributionRepository.installCaptureInvalidation=install;}
  const Database=require('better-sqlite3');const check=new Database(file);
  try {
    assert.equal(check.pragma('user_version',{simple:true}),14);
    assert.notEqual(check.prepare('SELECT capture_digest FROM request_attributions').get().capture_digest,'');
    assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='invalidate_capture_attribution'").get(),undefined);
  }finally{check.close();}
  db=new StorageEngine(file);
  try {
    assert.equal(db.db.pragma('user_version',{simple:true}), 19);assert.equal(db.getRequestBody(id),raw);
    assert.equal(db.db.prepare('SELECT capture_digest FROM request_attributions').get().capture_digest,'');
    assert.equal((await db.getAttributedSessions())[0].session_id,'thread-a');
  }finally{db.close();}
  db=new StorageEngine(file);
  try {assert.notEqual(db.db.prepare('SELECT capture_digest FROM request_attributions').get().capture_digest,'');assert.equal(db.getRequestBody(id),raw);}
  finally{db.close();}
});

test('Codex: protocol enrichment batches large lists without changing selection or missing-projection behavior',t=>{
  const {storage}=fixture(t),ids=[],expected=new Map();
  for(let n=0;n<1205;n++){
    const transport=['wss','https','unknown'][n%3];
    const id=insert(storage,body('thread-a','turn-'+n),{transport});
    ids.push(id);expected.set(id,['websocket','http','unknown'][n%3]);
  }
  const other=insert(storage,body(),{agent_name:'Claude'});ids.push(other);expected.set(other,undefined);
  storage.db.prepare('UPDATE records SET content_expired=1 WHERE id=?').run(ids[0]);
  storage.db.prepare('DELETE FROM request_attributions WHERE record_id=?').run(ids[1]);
  storage.db.prepare("UPDATE request_attributions SET decision='{broken' WHERE record_id=?").run(ids[2]);
  storage.db.prepare("UPDATE request_attributions SET rule_version='obsolete' WHERE record_id=?").run(ids[3]);
  for(const id of ids.slice(0,4))expected.set(id,undefined);
  const prepare=storage.db.prepare;let queries=0;
  storage.db.prepare=function(sql){
    const statement=prepare.call(this,sql);
    if(/SELECT\s+(?:record_id,\s*)?decision\s+FROM request_attributions/i.test(sql)){
      for(const method of ['get','all']){
        const execute=statement[method];
        statement[method]=function(...args){queries++;return execute.apply(this,args);};
      }
    }
    return statement;
  };
  t.after(()=>{storage.db.prepare=prepare;});
  const check=records=>{for(const record of records)assert.equal(record.protocol_family,expected.get(record.id),'record '+record.id);};
  const all=storage.getRecords({limit:-1,lightweight:true});check(all);
  assert.deepEqual(all.map(r=>r.id),[...ids].reverse());
  assert.ok(queries<=3,'protocol queries must be bounded by batches, not records: '+queries);
  queries=0;
  const requested=[...ids,ids[10]];
  const selected=storage.getRecordsByIds(requested,{lightweight:true});check(selected);
  assert.deepEqual(selected.map(r=>r.id),[...ids.slice(0,1200),ids[10],...ids.slice(1200)],
    'retain existing database order within chunks and cross-chunk duplicates');
  assert.ok(queries<=3,'batch-by-ID reading must share bounded protocol enrichment: '+queries);
  for(const id of [ids[0],ids[1],ids[2],ids[3],ids[10],other])check([storage.getRecordById(id)]);
  assert.deepEqual(storage.getRecordsByIds([]),[]);
});

test('Codex: saving a batch reuses fixed statements while preserving projection and evidence writes',t=>{
  const {storage}=fixture(t);for(let n=0;n<40;n++)insert(storage,body('thread-a','turn-'+n));
  const repo=new AttributionRepository(storage.db),rows=repo.readAll();
  for(const row of rows)row.native={status:'unavailable',reason:'source_missing'};
  const prepare=storage.db.prepare,counts=new Map();
  storage.db.prepare=function(sql){counts.set(sql,(counts.get(sql)||0)+1);return prepare.call(this,sql);};
  t.after(()=>{storage.db.prepare=prepare;});
  assert.equal(repo.saveBatch(rows),true);
  for(const [sql,count] of counts)assert.equal(count,1,'fixed statement is compiled once per batch: '+sql);
  assert.deepEqual(repo.readAll(),rows);
  assert.equal(repo.saveBatch(rows),false,'identical batch must not rewrite projections');
});

test('Codex: client version is diagnostic and cannot gate HTTP or WS identity',()=>{
  for(const headers of [
    {'user-agent':'Codex Desktop/0.159.2'},
    {'user-agent':'Codex Desktop/0.162.0-alpha.2'},
    {'user-agent':ua},
    {'user-agent':'Codex Desktop/0.163.0-alpha.10.2'},
    {'user-agent':'Codex Desktop/99'},
    {}, {'user-agent':'custom-client'}, {'user-agent':42},
    {'user-agent':'Codex Desktop/99','User-Agent':'Codex Desktop/100'}
  ]) for(const transport of ['wss','https']) {
    const input=capture(body(),{headers,transport});
    const result=decide(input);
    assert.equal(result.session.value,'thread-a',JSON.stringify({headers,transport}));
    assert.equal(result.turn.value.id,'turn-a');
    const facts=codexAdapter.extract(input);
    if(headers['user-agent']==='Codex Desktop/0.163.0-alpha.10.2')assert.equal(facts.fields.sourceVersion,'0.163.0-alpha.10.2');
    if(!Object.keys(headers).length)assert.equal(facts.fields.sourceVersion,undefined);
  }
});

test('Codex: new clients still require valid scoped identity and capture contracts',()=>{
  const headers={'user-agent':'Codex Desktop/0.163.0-alpha.10.2','thread-id':'handshake-thread','x-codex-turn-metadata':JSON.stringify(metadata('handshake-thread','handshake-turn'))};
  const check=(b,extra={})=>decide(capture(b,{headers,...extra}));
  assert.equal(check({type:'response.create'}).session.reason,'missing_session');
  assert.equal(check(body()).turn.value.id,'turn-a','WS ignores handshake identities');
  assert.equal(check(body(),{transport:'https'}).session.status,'conflict','HTTP checks current request headers');
  for(const invalid of [null,42,[],{}]){
    const b=body();b.client_metadata.turn_id=invalid;
    assert.equal(check(b).turn.reason,'invalid_metadata');
  }
  const b=body();b.client_metadata.turn_id='different';
  assert.equal(check(b).turn.status,'conflict');
  assert.equal(check({type:'response.create',client_metadata:{thread_id:'thread-a'}}).turn.reason,'missing_turn');
  assert.equal(check({...body(),type:'other'}).session.reason,'unsupported_format');
  assert.equal(check(body(),{schemaVersion:'unknown'}).session.reason,'unsupported_format');
  assert.equal(check(body(),{transport:'unknown'}).session.reason,'unknown_protocol');
  assert.equal(check(body(),{attribution:'connection'}).session.reason,'connection_only');
  assert.equal(check(body(),{contentExpired:true}).session.reason,'content_unavailable');
  const warm=body('thread-a','','prewarm');warm.generate=false;
  assert.equal(check(warm).turn.reason,'prewarm');
});

test('Codex: version-rejected v2 history replays into new turns on reopen without altering captures',async t=>{
  const {storage,root}=fixture(t);
  const headers={'user-agent':'Codex Desktop/0.163.0-alpha.10.2'};
  const requests=[body('thread-a','first'),body('thread-a','','prewarm'),body('thread-a','second')];
  requests[1].generate=false;
  const ids=requests.map(b=>insert(storage,b,{request_headers:headers}));
  const raw=ids.map(id=>storage.getRequestBody(id));
  const rejected={status:'unresolved',reason:'unsupported_version',evidence:[]};
  for(const row of new AttributionRepository(storage.db).readAll()){
    const facts={session:rejected,fields:{},codex:{format:'codex-capture-v2',turn:rejected,requestKind:rejected,protocol:row.facts.codex.protocol}};
    const decision={agentId:'codex',ruleVersion:'2',session:rejected,turn:rejected,lifecycle:'unknown',protocol:row.decision.protocol};
    storage.db.prepare("UPDATE request_attributions SET rule_version='2', facts=?, decision=? WHERE record_id=?").run(JSON.stringify(facts),JSON.stringify(decision),row.recordId);
  }
  storage.db.exec("UPDATE records SET session_id='unknown:record:' || id,thread_id='',turn_id='',session_confidence='unknown',session_id_source='unknown'; DELETE FROM attribution_jobs");
  storage.close();
  let reopened=new StorageEngine(path.join(root,'lens.db'));t.after(()=>reopened.close());
  const result=await reopened.getAttributedSessions();
  assert.equal(result.length,1);assert.equal(result[0].session_id,'thread-a');
  assert.equal(result[0].tasks_count,2);
  const assigned=result[0].tasks.flatMap(task=>task.turns);
  assert.equal(assigned.find(r=>r.record_id===ids[0]).assignment.turn.value.id,'first');
  assert.equal(assigned.find(r=>r.record_id===ids[2]).assignment.turn.value.id,'second');
  assert.equal(assigned.find(r=>r.record_id===ids[1]).assignment.turn.reason,'prewarm');
  assert.deepEqual(reopened.getRecords({sessionId:'thread-a'}).map(r=>r.id).sort((a,b)=>a-b),ids);
  assert.deepEqual(ids.map(id=>reopened.getRequestBody(id)),raw);
  const current=new AttributionRepository(reopened.db).readAll().filter(row=>row.version===codexAdapter.version);
  assert.notEqual(codexAdapter.version,'2');assert.equal(current.length,3);
  assert.ok(current.every(row=>row.decision.session.value==='thread-a'));
  reopened.close();reopened=new StorageEngine(path.join(root,'lens.db'));
  assert.deepEqual(await reopened.getAttributedSessions(),result);
});
