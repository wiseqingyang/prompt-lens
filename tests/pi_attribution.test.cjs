const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {StorageEngine} = require('../dist/main/storage');
const {AttributionRepository, evidenceScope} = require('../dist/main/attribution/repository');
const {piAdapter, PI_RULE_VERSION} = require('../dist/main/attribution/adapters/pi');
const {PiEvidenceSource} = require('../dist/main/attribution/sources/pi');
const {detectAgent} = require('../dist/main/parser');
const {ConfigManager, validateConfigPatch} = require('../dist/main/config');
const {AdapterRegistry} = require('../dist/main/attribution/registry');
function fixture(t,options={}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-pi-'));
  const file = path.join(root, 'lens.db'), source = path.join(root, 'sessions');
  const storage = new StorageEngine(file,options), stores = [storage];
  t.after(async () => { for(const store of stores){await store.stopAttributionCollection(); store.close();} fs.rmSync(root,{recursive:true,force:true}); });
  return {root,file,source,storage,roots:{antigravityDataDir:'',piSessionsDir:source},reopen(){const s=new StorageEngine(file);stores.push(s);return s;}};
}
function log(source, session='session-a', responses=['resp-a'], extra={}) {
  const file=path.join(source,'--synthetic--',session+'.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});
  const header={type:'session',version:3,id:session,timestamp:'2026-01-01T00:00:00Z',cwd:'/synthetic'};
  const entries=responses.map((responseId,n)=>({type:'message',id:'a'+n,parentId:null,timestamp:'2026-01-01T00:00:00Z',message:{role:'assistant',api:'openai-responses',responseId,content:[{type:'text',text:'synthetic reply'}],...extra}}));
  const raw=[header,...entries].map(JSON.stringify).join('\n')+'\n';fs.writeFileSync(file,raw);return {file,raw,header,entries};
}
function capture(responseId='resp-a',extra={}) {
  return {agentName:'Pi Agent',schemaVersion:'3.0.0',transport:'https',attribution:'request',capturedAt:'2026-01-01T00:00:00Z',body:{model:'synthetic',input:[]},headers:{'user-agent':'pi/1.3.0'},responseEvidence:{body:JSON.stringify({object:'response',id:responseId}),complete:true},...extra};
}
function insert(storage,response='resp-a',extra={}) {
  return storage.insertRecord({agent_name:'Pi Agent',provider:'openai',model:'synthetic',schema_version:'3.0.0',transport:'https',attribution:'request',capture_status:'complete',status_code:200,request_headers:{'user-agent':'pi/1.3.0'},request_body:JSON.stringify({model:'synthetic',input:[{role:'user',content:'same prompt'}]}),response_body:JSON.stringify({object:'response',id:response}),...extra});
}
const assigned = (sessions,id) => sessions.flatMap(s=>s.tasks).flatMap(t=>t.turns).find(r=>r.record_id===id).assignment;

test('Pi identity: provider route/account never overrides client; user text and conflicting clients do not match',()=>{
  assert.equal(detectAgent({'user-agent':'pi/1.3.0',originator:'pi','chatgpt-account-id':'synthetic'},'/backend-api/codex/responses'),'Pi Agent');
  assert.notEqual(detectAgent({},'/v1/messages',{messages:[{role:'user',content:'operating inside pi'}]}),'Pi Agent');
  for(const headers of [{'user-agent':'Codex Desktop/1',originator:'pi'},{'user-agent':'pi/1',originator:'codex'},{'user-agent':'pi/1','User-Agent':'Codex/1'}])assert.equal(detectAgent(headers),'Unknown');
  const registry=new AdapterRegistry();assert.equal(registry.select(capture()).adapter.id,'pi');
  assert.equal(new AdapterRegistry([piAdapter,{...piAdapter,id:'duplicate-match'}]).select(capture()).status,'conflict');
  assert.equal(piAdapter.extract(capture('resp-a',{headers:{}})).session.reason,'agent_identity_unconfirmed');
});

test('Pi capture contracts: HTTP JSON/SSE, WS current server events, and Anthropic IDs',()=>{
  const sse='event: response.created\ndata: {"type":"response.created","response":{"id":"resp-a"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-a"}}\n\n';
  for(const responseEvidence of [{body:sse,complete:true},{body:JSON.stringify({object:'response',id:'resp-a',output:[{id:'history-id'}]}),complete:true}]) {
    assert.deepEqual(piAdapter.extract(capture('unused',{responseEvidence})).locator,{kind:'pi',api:'responses',responseId:'resp-a'});
  }
  const ws=JSON.stringify({format:'ws-messages-v1',messages:[{direction:'client',sequence:0,payload:'{"type":"response.create","previous_response_id":"old"}'},{direction:'server',sequence:1,payload:'{"type":"response.completed","response":{"id":"resp-a"}}'}]});
  const facts=piAdapter.extract(capture('unused',{transport:'wss',body:{type:'response.create'},responseEvidence:{body:ws,complete:true}}));
  assert.equal(facts.locator.responseId,'resp-a');assert.equal(facts.pi.protocol.family,'websocket');
  const anthropic='event: message_start\ndata: {"type":"message_start","message":{"role":"assistant","id":"msg-a"}}\n\n';
  assert.equal(piAdapter.extract(capture('unused',{responseEvidence:{body:anthropic,complete:true}})).locator.api,'anthropic');
});

test('Pi malformed, truncated, conflicting, missing and connection captures never invent IDs',()=>{
  for(const body of ['broken','data: {broken}\n\n',JSON.stringify({input:[{id:'history'}]}),JSON.stringify({object:'response',id:0})])assert.equal(piAdapter.extract(capture('',{responseEvidence:{body,complete:true}})).locator,undefined);
  const body='data: {"type":"response.created","response":{"id":"a"}}\n\ndata: {"type":"response.completed","response":{"id":"b"}}\n\n';
  assert.equal(piAdapter.extract(capture('',{responseEvidence:{body,complete:true}})).pi.responseId.status,'conflict');
  for(const extra of [{attribution:'connection'},{contentExpired:true},{schemaVersion:'unknown'},{transport:'unknown'},{responseEvidence:{body:'{"object":"response","id":"a"}',complete:false}}])assert.equal(piAdapter.extract(capture('a',extra)).locator,undefined);
});

test('Pi source: exact v3 matches, API separation and explicit fork conflict',async t=>{
  const h=fixture(t);log(h.source);const a=insert(h.storage);await h.storage.collectAttributionEvidence(h.roots);
  let sessions=await h.storage.getAttributedSessions();assert.equal(sessions.length,1);assert.equal(sessions[0].kind,'session');
  assert.equal(sessions[0].session_id_source,'pi_native');assert.equal(sessions[0].title,'未识别名称');assert.equal(sessions[0].tasks_count,1);
  assert.equal(assigned(sessions,a).turn.reason,'missing_turn');assert.equal(h.storage.getRecordById(a).session_id,sessions[0].session_id);
  assert.equal(h.storage.getRecords({sessionId:sessions[0].session_id}).length,1);
  log(h.source,'anthropic-copy',['resp-a'],{api:'anthropic-messages'});
  await h.storage.collectAttributionEvidence(h.roots);assert.equal((await h.storage.getAttributedSessions())[0].kind,'session');
  log(h.source,'fork');await h.storage.collectAttributionEvidence(h.roots);
  sessions=await h.storage.getAttributedSessions();assert.equal(assigned(sessions,a).session.status,'conflict');assert.equal(h.storage.getRecordById(a).session_confidence,'unknown');
});

test('Pi missing evidence arrives later, source deletion/reopen preserve raw observations; queries never read source',async t=>{
  const h=fixture(t);const id=insert(h.storage);await h.storage.collectAttributionEvidence(h.roots);
  assert.equal(assigned(await h.storage.getAttributedSessions(),id).session.status,'unresolved');
  const native=log(h.source);await h.storage.collectAttributionEvidence(h.roots);const before=await h.storage.getAttributedSessions();
  const repo=new AttributionRepository(h.storage.db),saved=repo.readAll()[0];assert.equal(saved.native.raw.records[0].entry,JSON.stringify(native.entries[0]));
  fs.rmSync(h.source,{recursive:true});await h.storage.collectAttributionEvidence(h.roots);assert.deepEqual(await h.storage.getAttributedSessions(),before);
  h.storage.close();const reopened=h.reopen();assert.deepEqual(await reopened.getAttributedSessions(),before);
  reopened.clearRecords();assert.equal(new AttributionRepository(reopened.db).readAll().length,0);
  assert.equal(reopened.db.prepare('SELECT count(*) n FROM attribution_observations').get().n,0);
  assert.equal(reopened.getRecordById(id).session_confidence,'unknown');
});

test('Pi rewritten source entry conflicts even when its response ID changes; shortened logs retain evidence',async t=>{
  const h=fixture(t);const native=log(h.source),id=insert(h.storage);await h.storage.collectAttributionEvidence(h.roots);
  fs.writeFileSync(native.file,JSON.stringify(native.header)+'\n');await h.storage.collectAttributionEvidence(h.roots);
  assert.equal(assigned(await h.storage.getAttributedSessions(),id).session.status,'resolved');
  log(h.source,'session-a',['changed-response']);await h.storage.collectAttributionEvidence(h.roots);
  assert.equal(assigned(await h.storage.getAttributedSessions(),id).session.reason,'source_changed');
  h.storage.close();assert.equal(assigned(await h.reopen().getAttributedSessions(),id).session.reason,'source_changed');
});

test('Pi same prompts and user-role context never create native turns; usage is counted once',async t=>{
  const h=fixture(t);const a=log(h.source,'one',['a','b']),b=log(h.source,'two',['c']);
  fs.appendFileSync(a.file,JSON.stringify({type:'message',id:'user-1',parentId:'a1',message:{role:'user',content:'same prompt'}})+'\n');
  const ids=['a','b','c'].map(id=>insert(h.storage,id,{input_tokens:10,output_tokens:2,total_tokens:12,token_source:'reported'}));
  await h.storage.collectAttributionEvidence(h.roots);const sessions=await h.storage.getAttributedSessions();
  assert.equal(sessions.length,2);assert.deepEqual(sessions.map(s=>s.tasks_count),[1,1]);
  assert.equal(sessions.reduce((n,s)=>n+s.total_input_tokens,0),30);
  for(const id of ids)assert.equal(assigned(sessions,id).turn.reason,'missing_turn');
  const counts=h.storage.db.prepare('SELECT count(*) n FROM usage_ledger').get().n;await h.storage.collectAttributionEvidence(h.roots);assert.equal(h.storage.db.prepare('SELECT count(*) n FROM usage_ledger').get().n,counts);
});

test('Pi budgets, malformed JSONL and symlink candidates prevent new unique attribution',async t=>{
  const h=fixture(t),native=log(h.source),locator={kind:'pi',api:'responses',responseId:'resp-a'};
  const check=()=>new PiEvidenceSource(h.source).read(locator);
  fs.writeFileSync(path.join(h.source,'bad.jsonl'),'{broken');assert.equal((await check()).reason,'source_invalid');fs.unlinkSync(path.join(h.source,'bad.jsonl'));
  fs.symlinkSync(native.file,path.join(h.source,'link.jsonl'));assert.equal((await check()).reason,'source_invalid');fs.unlinkSync(path.join(h.source,'link.jsonl'));
  fs.writeFileSync(path.join(h.source,'huge.jsonl'),' '.repeat(8*1024*1024+1));assert.equal((await check()).reason,'source_limit');
});

test('Pi response updates invalidate one projection and late evidence updates indexes without stale overwrite',async t=>{
  const h=fixture(t);log(h.source,'one',['a']);log(h.source,'two',['b']);const id=insert(h.storage,'a'),other=insert(h.storage,'a');
  await h.storage.collectAttributionEvidence(h.roots);const repo=new AttributionRepository(h.storage.db),old=repo.readAll();
  h.storage.db.prepare('UPDATE records SET response_body=? WHERE id=?').run(JSON.stringify({object:'response',id:'b'}),id);
  assert.equal(repo.readAll().find(r=>r.recordId===id).captureDigest,'');assert.notEqual(repo.readAll().find(r=>r.recordId===other).captureDigest,'');
  await h.storage.collectAttributionEvidence(h.roots,[id]);repo.saveBatch(old);
  assert.match(h.storage.getRecordById(id).session_id,/two/);assert.match(h.storage.getRecordById(other).session_id,/one/);
});

test('Pi config auto discovers without creating directories; custom paths persist and validate',t=>{
  const h=fixture(t),file=path.join(h.root,'config.json'),config=new ConfigManager(file,'',h.root);
  assert.equal(config.getConfig().attribution.piSessionsDir,'');assert.equal(fs.existsSync(path.join(h.root,'.pi')),false);
  const sessions=path.join(h.root,'.pi','agent','sessions');fs.mkdirSync(sessions,{recursive:true});assert.equal(config.getConfig().attribution.piSessionsDir,sessions);
  config.save({attribution:{antigravityDataDir:'',piSessionsDir:h.source}});assert.equal(new ConfigManager(file,'',h.root).getConfig().attribution.piSessionsDir,h.source);
  for(const value of [42,'relative','/bad\0path'])assert.throws(()=>validateConfigPatch({attribution:{piSessionsDir:value}}));
});

test('Pi schema v19 migration rolls back atomically and preserves original captures',async t=>{
  const h=fixture(t);const id=insert(h.storage),raw=h.storage.getRequestBody(id);
  h.storage.db.exec('DROP TRIGGER invalidate_pi_attribution');h.storage.db.pragma('user_version=18');h.storage.close();
  const install=AttributionRepository.installPiInvalidation;
  try{AttributionRepository.installPiInvalidation=db=>{install(db);throw new Error('synthetic migration failure');};assert.throws(()=>h.reopen(),/synthetic migration failure/);}finally{AttributionRepository.installPiInvalidation=install;}
  const Database=require('better-sqlite3'),check=new Database(h.file);
  assert.equal(check.pragma('user_version',{simple:true}),18);assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='invalidate_pi_attribution'").get(),undefined);check.close();
  const reopened=h.reopen();assert.equal(reopened.db.pragma('user_version',{simple:true}),19);assert.equal(reopened.getRequestBody(id),raw);
});

test('Pi collector and worker persist late evidence and survive ordinary session queries',async t=>{
  const h=fixture(t,{backgroundAttribution:true});
  const id=insert(h.storage);h.storage.getAttributionCapture=()=>{throw new Error('worker must not parse on host');};
  let ticks=0;const timer=setInterval(()=>ticks++,1);t.after(()=>clearInterval(timer));
  const notifications=[];
  h.storage.startAttributionCollection(()=>h.roots,{retryBaseMs:10,pollMs:10,onCollected:ids=>notifications.push(...ids)});
  log(h.source);const deadline=Date.now()+5000;
  while(h.storage.getRecordById(id).session_confidence!=='exact'){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal((await h.storage.getAttributedSessions())[0].tasks_count,1);
  assert.ok(notifications.includes(id),'late session evidence must notify the desktop even while monitoring remains scheduled');
  assert.ok(ticks>0,'host event loop remains responsive during worker collection');
  await h.storage.stopAttributionCollection();
});

test('Pi scan and navigation budgets: unchanged files are not reread, new files are incremental',async t=>{
  const h=fixture(t);log(h.source,'bulk',Array.from({length:160},(_,i)=>'resp-'+i),{content:[{type:'text',text:'x'.repeat(8000)}]});
  for(let i=0;i<160;i++)insert(h.storage,'resp-'+i);
  const original=fs.promises.open, canonicalSource=fs.realpathSync(h.source);let reads=0;
  fs.promises.open=async function(file,...args){if(String(file).startsWith(canonicalSource))reads++;return original.call(this,file,...args);};
  t.after(()=>{fs.promises.open=original;});
  let start=performance.now();await h.storage.collectAttributionEvidence(h.roots);const cold=performance.now()-start;assert.equal(reads,1);
  reads=0;start=performance.now();await h.storage.collectAttributionEvidence(h.roots);const warm=performance.now()-start;assert.equal(reads,0);
  start=performance.now();const sessions=await h.storage.getAttributedSessions();const query=performance.now()-start;assert.equal(sessions[0].turns_count,160);assert.equal(reads,0);
  start=performance.now();assert.deepEqual(await h.storage.getAttributedSessions(),sessions);const hot=performance.now()-start;
  log(h.source,'new',['new-response']);const id=insert(h.storage,'new-response');start=performance.now();await h.storage.collectAttributionEvidence(h.roots,[id]);const incremental=performance.now()-start;assert.equal(reads,1);
  assert.equal((await h.storage.getAttributedSessions()).length,2);
  t.diagnostic(JSON.stringify({requests:160,sourceBytes:fs.statSync(path.join(h.source,'--synthetic--','bulk.jsonl')).size,coldMs:cold,warmMs:warm,queryMs:query,hotMs:hot,incrementalMs:incremental}));
});

test('Pi ingestion, API, protocol and reported usage share the persisted result; config does not restart proxy',async t=>{
  const h=fixture(t);log(h.source);
  const {CoreManager}=require('../dist/main/core'),{WebServer}=require('../dist/main/web');
  const core=new CoreManager(h.storage);
  const payload={schema_version:'3.0.0',event_id:'pi-event',request_id:'pi-request',transport:'https',attribution:'request',method:'POST',status_code:200,capture_status:'complete',url_path:'/backend-api/codex/responses',request_headers:{'user-agent':'pi/1.3.0',originator:'pi','chatgpt-account-id':'synthetic'},request_body:JSON.stringify({model:'synthetic',input:[]}),response_body:'data: {"type":"response.completed","response":{"id":"resp-a","object":"response","output":[],"usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15}}}\n\n'};
  const id=core.handleCapturePayload(payload);assert.equal(core.handleCapturePayload(payload),id);
  await h.storage.collectAttributionEvidence(h.roots);
  const config=new ConfigManager(path.join(h.root,'config.json'),'',h.root);let restarts=0;
  const web=new WebServer(h.storage,{},0,{restart:async()=>{restarts++;}},undefined,config);t.after(()=>web.app.close());
  let response=await web.app.inject({method:'GET',url:'/api/sessions'});assert.equal(response.statusCode,200);
  assert.equal(response.json().sessions[0].agent_name,'Pi Agent');assert.equal(response.json().sessions[0].total_input_tokens,12);
  response=await web.app.inject({method:'GET',url:`/api/records/${id}`});assert.equal(response.json().protocol_family,'http');assert.equal(response.json().token_source,'reported');assert.equal(response.json().input_tokens,12);
  const zero=core.handleCapturePayload({...payload,event_id:'pi-zero',request_id:'pi-zero',response_body:JSON.stringify({object:'response',id:'zero',output:[],usage:{input_tokens:0,output_tokens:0,total_tokens:0}})});
  const missing=core.handleCapturePayload({...payload,event_id:'pi-missing',request_id:'pi-missing',response_body:JSON.stringify({object:'response',id:'missing',output:[]})});
  assert.equal(h.storage.getRecordById(zero).token_source,'reported');assert.equal(h.storage.getRecordById(zero).total_tokens,0);
  assert.equal(h.storage.getRecordById(missing).token_source,'unavailable');
  const saved=await web.app.inject({method:'POST',url:'/api/config',payload:{attribution:{piSessionsDir:h.source}}});assert.equal(saved.statusCode,200);assert.equal(restarts,0);assert.equal(config.getConfig().attribution.piSessionsDir,h.source);
});

test('Pi repeated custom session IDs in distinct files cannot establish a unique native origin',async t=>{
  const h=fixture(t);const native=log(h.source);fs.copyFileSync(native.file,path.join(h.source,'copy.jsonl'));
  const id=insert(h.storage);await h.storage.collectAttributionEvidence(h.roots);
  assert.equal(assigned(await h.storage.getAttributedSessions(),id).session.reason,'source_changed');
  assert.equal(h.storage.getRecordById(id).session_confidence,'unknown');
});

test('Pi evidence writes reserve the transaction before live checks under a concurrent writer',async t=>{
  const h=fixture(t);log(h.source);const id=insert(h.storage);await h.storage.collectAttributionEvidence(h.roots);
  const Database=require('better-sqlite3'),writer=new Database(h.file);writer.pragma('busy_timeout=0');t.after(()=>writer.close());
  const repo=new AttributionRepository(h.storage.db),observation=repo.readObservations()[0];
  const prepare=h.storage.db.prepare;let attempted=false,blocked=false;
  h.storage.db.prepare=function(sql){
    const statement=prepare.call(this,sql);
    if(sql==='SELECT content_expired FROM records WHERE id = ?'){
      const get=statement.get;statement.get=function(...args){
        const result=get.apply(this,args);
        if(!attempted){attempted=true;try{writer.prepare('UPDATE records SET duration_ms=17 WHERE id=?').run(id);}catch(error){if(error.code!=='SQLITE_BUSY')throw error;blocked=true;}}
        return result;
      };
    }
    return statement;
  };
  t.after(()=>{h.storage.db.prepare=prepare;});
  assert.doesNotThrow(()=>repo.saveObservations([{...observation,observedAt:'synthetic-replay'}]));
  assert.equal(attempted,true);assert.equal(blocked,true,'write reservation serializes evidence and maintenance writes');
  writer.prepare('UPDATE records SET duration_ms=17 WHERE id=?').run(id);
  assert.equal(repo.readObservations().length,1);assert.equal(h.storage.getRecordById(id).duration_ms,17);
});

test('Pi collection and content maintenance run concurrently without losing capture or native evidence',async t=>{
  const h=fixture(t);log(h.source,'concurrent',Array.from({length:24},(_,i)=>'parallel-'+i));
  const ids=Array.from({length:24},(_,i)=>insert(h.storage,'parallel-'+i,{request_body:JSON.stringify({model:'synthetic',input:'x'.repeat(5000)})}));
  h.storage.startMaintenance({retentionDays:0,rawPayloadRetentionDays:0});
  t.after(()=>h.storage.stopMaintenance());
  for(let n=0;n<8;n++)await h.storage.collectAttributionEvidence(h.roots);
  const deadline=Date.now()+12000;
  while(h.storage.db.prepare("SELECT count(*) n FROM records WHERE length(request_body)>0 OR length(response_body)>0").get().n){
    assert.ok(Date.now()<deadline,'maintenance must drain its own synthetic content');
    assert.equal(h.storage.getDbInfo().maintenanceError,'');
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  await h.storage.collectAttributionEvidence(h.roots);
  const sessions=await h.storage.getAttributedSessions();assert.equal(sessions.length,1);assert.equal(sessions[0].turns_count,24);
  assert.equal(h.storage.getDbInfo().maintenanceError,'');
  for(const id of ids){assert.equal(JSON.parse(h.storage.getRequestBody(id)).input.length,5000);assert.equal(assigned(sessions,id).session.status,'resolved');}
  await h.storage.stopMaintenance();
});

test('Pi large session files and directories resolve separate sessions and detect tail duplicates',async t=>{
  const h=fixture(t),big=log(h.source,'large',['large-response']),small=log(h.source,'small',['small-response']);
  // Realistic large tool results: each line is bounded, total file exceeds the former 8 MiB limit.
  const toolText='中'.repeat(180000);
  for(let i=0;i<66;i++)fs.appendFileSync(big.file,JSON.stringify({type:'message',id:'tool-'+i,parentId:i?'tool-'+(i-1):'a0',message:{role:'toolResult',content:[{type:'text',text:toolText}]}})+'\n');
  assert.ok(fs.statSync(big.file).size>32*1024*1024);
  const a=insert(h.storage,'large-response'),b=insert(h.storage,'small-response');
  await h.storage.collectAttributionEvidence(h.roots);
  let sessions=await h.storage.getAttributedSessions();
  assert.equal(sessions.filter(s=>s.kind==='session').length,2);
  assert.notEqual(h.storage.getRecordById(a).session_id,h.storage.getRecordById(b).session_id);
  assert.equal(assigned(sessions,a).session.status,'resolved');assert.equal(assigned(sessions,b).session.status,'resolved');
  fs.appendFileSync(big.file,JSON.stringify({type:'message',id:'tail-copy',parentId:'tool-65',message:{role:'assistant',api:'openai-responses',responseId:'small-response'}})+'\n');
  await h.storage.collectAttributionEvidence(h.roots);
  sessions=await h.storage.getAttributedSessions();
  assert.equal(assigned(sessions,b).session.status,'conflict');assert.equal(assigned(sessions,a).session.status,'resolved');
});

test('Pi bounded payload cache reloads exact UTF-8 lines and detects prefix rewrites in growing files',async t=>{
  const h=fixture(t),native=log(h.source,'eviction',['first'],{content:[{type:'text',text:'原文'.repeat(190000)}]});
  for(let i=0;i<17;i++)fs.appendFileSync(native.file,JSON.stringify({type:'message',id:'extra-'+i,parentId:'a0',message:{role:'assistant',api:'openai-responses',responseId:'extra-'+i,content:[{type:'text',text:'x'.repeat(1024*1024)}]}})+(i===16?'':'\n'));
  const source=new PiEvidenceSource(h.source),locator={kind:'pi',api:'responses',responseId:'first'};
  const original=fs.promises.open,canonical=fs.realpathSync(native.file);let reads=[];
  fs.promises.open=async function(name,...args){const handle=await original.call(this,name,...args);if(String(name)===canonical){const read=handle.read.bind(handle);handle.read=async function(buffer,offset,length,position){reads.push({length,position});return read(buffer,offset,length,position);};}return handle;};
  t.after(()=>{fs.promises.open=original;});
  const evidence=await source.read(locator);assert.equal(evidence.status,'available');assert.equal(evidence.candidates.length,1);
  assert.equal(evidence.raw.records[0].entry,JSON.stringify(native.entries[0]));
  assert.ok(reads.filter(r=>r.position===0).every(r=>r.length<=64*1024),'whole file must not be allocated for a cold scan');
  assert.ok(reads.some(r=>r.length===Buffer.byteLength(JSON.stringify(native.entries[0]))),'evicted raw entry is fetched by its byte offset');
  reads=[];source.beginBatch();assert.deepEqual(await source.read(locator),evidence);assert.equal(reads.length,0);
  const raw=fs.readFileSync(native.file,'utf8');
  fs.writeFileSync(native.file,raw.replace('"responseId":"first"','"responseId":"other"')+'\n'+JSON.stringify({type:'message',id:'last',parentId:null,message:{role:'toolResult',content:'new'}})+'\n');
  source.beginBatch();const current=await source.read(locator,evidence);
  const reconciled=piAdapter.reconcile({},current,{native:evidence});assert.equal(reconciled.conflict.reason,'source_changed');
});

test('Pi streaming scan rejects mid-read changes and recovers on a stable batch',async t=>{
  const h=fixture(t),native=log(h.source),source=new PiEvidenceSource(h.source),locator={kind:'pi',api:'responses',responseId:'resp-a'};
  const original=fs.promises.open,canonical=fs.realpathSync(native.file);let changed=false;
  fs.promises.open=async function(name,...args){const handle=await original.call(this,name,...args);if(String(name)===canonical){const read=handle.read.bind(handle);handle.read=async(...input)=>{const result=await read(...input);if(!changed){changed=true;fs.appendFileSync(native.file,'\n');}return result;};}return handle;};
  try{assert.equal((await source.read(locator)).reason,'source_changed');}finally{fs.promises.open=original;}
  source.beginBatch();assert.equal((await source.read(locator)).candidates.length,1);
});

test('Pi scan budgets bound bytes and total index entries without accepting partial uniqueness',async t=>{
  const h=fixture(t);log(h.source);const locator={kind:'pi',api:'responses',responseId:'resp-a'};
  const huge=path.join(h.source,'too-large.jsonl'),fd=fs.openSync(huge,'w');fs.ftruncateSync(fd,1024*1024*1024+1);fs.closeSync(fd);
  assert.equal((await new PiEvidenceSource(h.source).read(locator)).reason,'source_limit');fs.unlinkSync(huge);
  const many=log(h.source,'many',[]);const out=fs.openSync(many.file,'a');
  try{for(let batch=0;batch<20;batch++)fs.writeSync(out,Array.from({length:10000},(_,i)=>JSON.stringify({type:'custom',id:'entry-'+(batch*10000+i)})).join('\n')+'\n');}finally{fs.closeSync(out);}
  assert.equal((await new PiEvidenceSource(h.source).read(locator)).reason,'source_limit');
});

test('Pi persisted source_limit projections recover through ordinary collection after reopen',async t=>{
  const h=fixture(t),native=log(h.source),id=insert(h.storage);
  for(let i=0;i<12;i++)fs.appendFileSync(native.file,JSON.stringify({type:'message',id:'tool-large-'+i,message:{role:'toolResult',content:'x'.repeat(1024*1024)}})+'\n');
  const repo=new AttributionRepository(h.storage.db),old=repo.readAll().find(row=>row.recordId===id);
  // The persisted v1 state left by the former 8 MiB file cap; preserve its actual capture digest.
  repo.saveBatch([{...old,native:{status:'unavailable',reason:'source_limit'},decision:{...old.decision,session:{status:'unresolved',reason:'source_limit',evidence:[]}}}]);
  assert.equal(repo.readAll().find(row=>row.recordId===id).decision.session.reason,'source_limit');
  const body=h.storage.getRequestBody(id);await h.storage.stopMaintenance();h.storage.close();
  const reopened=h.reopen();reopened.startAttributionCollection(()=>h.roots,{pollMs:10,retryBaseMs:10});
  const deadline=Date.now()+5000;
  while(reopened.getRecordById(id).session_confidence!=='exact'){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,20));}
  await reopened.stopAttributionCollection();
  assert.equal((await reopened.getAttributedSessions()).filter(s=>s.kind==='session').length,1);
  assert.equal(reopened.getRecordById(id).session_id_source,'pi_native');assert.equal(reopened.getRequestBody(id),body);
});

function nativeUser(id,parentId=null,content=[{type:'text',text:'same native input'}]) { return {type:'message',id,parentId,message:{role:'user',content}}; }
function nativeAssistant(id,parentId,responseId=id) { return {type:'message',id,parentId,message:{role:'assistant',api:'openai-responses',responseId,content:[]}}; }
function tree(source,entries,session='tree') {
  const result=log(source,session,[]);fs.writeFileSync(result.file,[result.header,...entries].map(JSON.stringify).join('\n')+'\n');return result;
}
test('Pi native input ancestry: repeated text, tools, injection, compaction and branches survive out-of-order captures',async t=>{
  const h=fixture(t);tree(h.source,[nativeUser('u1'),nativeAssistant('r1','u1'),
    {type:'message',id:'tool',parentId:'r1',message:{role:'toolResult',content:[]}},nativeAssistant('r2','tool'),
    {type:'custom_message',id:'custom',parentId:'r2',message:{role:'user',content:'not input'}},
    {type:'compaction',id:'compact',parentId:'custom'},nativeAssistant('r3','compact'),
    nativeUser('u2','r3'),nativeAssistant('r4','u2'),nativeAssistant('branch','u1')]);
  const ids=['r4','r2','branch','r1','r3'].map(r=>insert(h.storage,r,{input_tokens:10,output_tokens:2,total_tokens:12,token_source:'reported'}));
  await h.storage.collectAttributionEvidence(h.roots);const sessions=await h.storage.getAttributedSessions();
  assert.equal(sessions.length,1);assert.equal(sessions[0].tasks_count,2);
  const turns=ids.map(id=>assigned(sessions,id).turn);assert.ok(turns.every(t=>t.status==='resolved'));
  assert.notEqual(turns[0].value.id,turns[1].value.id);assert.equal(new Set(turns.slice(1).map(t=>t.value.id)).size,1);
  assert.equal(turns[0].value.title,'same native input');assert.equal(sessions[0].total_input_tokens,50);
  const before=await h.storage.getAttributedSessions();
  const count=h.storage.db.prepare('SELECT count(*) n FROM attribution_observations').get().n;
  await h.storage.collectAttributionEvidence(h.roots);
  assert.equal(h.storage.db.prepare('SELECT count(*) n FROM attribution_observations').get().n,count,'unchanged ancestry must reuse the immutable snapshot');
  fs.rmSync(h.source,{recursive:true});
  await h.storage.collectAttributionEvidence(h.roots);h.storage.close();assert.deepEqual(await h.reopen().getAttributedSessions(),before);
});

test('Pi incomplete, cyclic, malformed and conflicting ancestors preserve session without inventing a turn',async t=>{
  const h=fixture(t);tree(h.source,[nativeAssistant('missing','absent'),nativeAssistant('cycle','loop'),
    {type:'custom',id:'loop',parentId:'cycle'},nativeAssistant('invalid',42),
    nativeUser('u1'),nativeUser('u2'),nativeAssistant('c1','u1','conflict'),nativeAssistant('c2','u2','conflict'),
    nativeAssistant('s1','u1','shared'),nativeAssistant('s2','u1','shared')]);
  const ids=['missing','cycle','invalid','conflict','shared'].map(r=>insert(h.storage,r));
  await h.storage.collectAttributionEvidence(h.roots);const sessions=await h.storage.getAttributedSessions();
  const assignments=ids.map(id=>assigned(sessions,id));assert.ok(assignments.every(a=>a.session.status==='resolved'));
  assert.deepEqual(assignments.map(a=>a.turn.status==='resolved'?'resolved':a.turn.reason),['source_incomplete','source_invalid','source_invalid','turn_conflict','resolved']);
  assert.equal(assignments[3].turn.candidates.length,2);
});

test('Pi input IDs are session scoped and non-text inputs have no invented title',async t=>{
  const h=fixture(t);tree(h.source,[nativeUser('u',null,[{type:'image',data:'synthetic'}]),nativeAssistant('a','u')],'one');
  tree(h.source,[nativeUser('u',null,''),nativeAssistant('b','u')],'two');
  const ids=['a','b'].map(r=>insert(h.storage,r));await h.storage.collectAttributionEvidence(h.roots);
  const sessions=await h.storage.getAttributedSessions(),turns=ids.map(id=>assigned(sessions,id).turn);
  assert.equal(sessions.length,2);assert.ok(turns.every(t=>t.status==='resolved' && t.value.title===undefined));assert.notEqual(turns[0].value.id,turns[1].value.id);
});

test('Pi ancestry snapshots cannot splice partial observations; old archives gain turns only after supplementation',async t=>{
  const {decodePiArchive,reconcilePi}=require('../dist/main/attribution/adapters/piArchive');
  const h=fixture(t),native=tree(h.source,[nativeUser('u'),{type:'custom',id:'middle',parentId:'u'},nativeAssistant('a','middle')]);
  const facts=piAdapter.extract(capture('a')),source=new PiEvidenceSource(h.source),complete=await source.read(facts.locator);
  const decide=native=>piAdapter.resolve({facts,native,capturedAt:''});
  const assistant=complete.raw.records.find(r=>JSON.parse(r.entry).id==='a');
  const legacy=decodePiArchive({...complete.raw,records:[assistant],ancestry:undefined});
  assert.equal(decide(legacy).session.status,'resolved');assert.equal(decide(legacy).turn.reason,'missing_turn');
  const first=decodePiArchive({...complete.raw,records:[assistant],ancestry:[{path:assistant.path,entryIds:['a']}]});
  const second=decodePiArchive({...complete.raw,records:complete.raw.records.filter(r=>JSON.parse(r.entry).id!=='a'),ancestry:[]});
  assert.equal(decide(reconcilePi(second,first)).turn.reason,'source_incomplete');
  assert.equal(decide(reconcilePi(complete,legacy)).turn.status,'resolved');
  const id=insert(h.storage,'a');await h.storage.collectAttributionEvidence(h.roots);
  const repo=new AttributionRepository(h.storage.db),saved=repo.readAll()[0];
  // Emulate rule 1 with only its historically saved assistant record, including immutable observations.
  h.storage.db.exec('DELETE FROM attribution_observations');
  repo.saveObservations([{recordId:id,adapterId:'pi',scope:evidenceScope('pi',facts),native:legacy,observedAt:'2026-01-01T00:00:00Z'}]);
  repo.saveBatch([{...saved,version:'1',native:legacy,decision:{...decide(legacy),ruleVersion:'1'}}]);
  h.storage.db.prepare("DELETE FROM request_attributions WHERE adapter_id='pi' AND rule_version=?").run(PI_RULE_VERSION);
  const raw=h.storage.getRequestBody(id);
  const hidden=h.source+'-hidden';fs.renameSync(h.source,hidden);h.storage.close();const reopened=h.reopen();
  const oldAssignment=assigned(await reopened.getAttributedSessions(),id);
  assert.equal(oldAssignment.session.status,'resolved');assert.equal(oldAssignment.turn.reason,'missing_turn');
  fs.renameSync(hidden,h.source);
  await reopened.collectAttributionEvidence(h.roots);assert.equal(assigned(await reopened.getAttributedSessions(),id).turn.status,'resolved');
  assert.equal(reopened.getRequestBody(id),raw);
});

test('Pi resolved turns remain scheduled and a later fork or rewritten ancestor becomes durable conflict',async t=>{
  const h=fixture(t,{backgroundAttribution:true});const native=tree(h.source,[nativeUser('u'),nativeAssistant('a','u')]);
  const id=insert(h.storage,'a');const retry=await h.storage.collectAttributionEvidence(h.roots);assert.ok(retry.has(id));
  assert.equal(assigned(await h.storage.getAttributedSessions(),id).turn.status,'resolved');
  h.storage.startAttributionCollection(()=>h.roots,{retryBaseMs:10,pollMs:10});
  tree(h.source,[nativeUser('v'),nativeAssistant('fork','v','a')],'fork');
  const deadline=Date.now()+5000;
  while(assigned(await h.storage.getAttributedSessions(),id).session.status!=='conflict') { assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,20)); }
  await h.storage.stopAttributionCollection();fs.rmSync(h.source,{recursive:true});h.storage.close();
  assert.equal(assigned(await h.reopen().getAttributedSessions(),id).session.status,'conflict');
  const separate=fixture(t);const original=tree(separate.source,[nativeUser('u'),nativeAssistant('a','u')]);const record=insert(separate.storage,'a');
  await separate.storage.collectAttributionEvidence(separate.roots);
  fs.writeFileSync(original.file,fs.readFileSync(original.file,'utf8').replace('same native input','rewritten input'));
  await separate.storage.collectAttributionEvidence(separate.roots);
  assert.equal(assigned(await separate.storage.getAttributedSessions(),record).session.reason,'source_changed');
});

test('Pi ancestry byte and depth budgets retain exact session while reporting unresolved turns',async t=>{
  const h=fixture(t);const entries=[nativeUser('u')];let parent='u';
  for(let i=0;i<6;i++){entries.push({type:'message',id:'t'+i,parentId:parent,message:{role:'toolResult',content:'x'.repeat(6*1024*1024)}});parent='t'+i;}
  entries.push(nativeAssistant('large',parent));tree(h.source,entries);
  const facts=piAdapter.extract(capture('large')),native=await new PiEvidenceSource(h.source).read(facts.locator),decision=piAdapter.resolve({facts,native,capturedAt:''});
  assert.equal(decision.session.status,'resolved');assert.equal(decision.turn.reason,'source_limit');
  assert.ok(Buffer.byteLength(JSON.stringify(native.raw))<33*1024*1024);
  const deep=[nativeUser('u')];parent='u';for(let i=0;i<10001;i++){deep.push({type:'custom',id:'d'+i,parentId:parent});parent='d'+i;}
  deep.push(nativeAssistant('deep',parent));tree(h.source,deep);
  const f=piAdapter.extract(capture('deep')),n=await new PiEvidenceSource(h.source).read(f.locator);
  assert.equal(piAdapter.resolve({facts:f,native:n,capturedAt:''}).turn.reason,'source_limit');
});

function chatBody(id='chat-a',stream=true) {
  const response={id,object:stream?'chat.completion.chunk':'chat.completion',choices:[stream?{index:0,delta:{role:'assistant',content:'synthetic reply'},finish_reason:'stop'}:{index:0,message:{role:'assistant',content:'synthetic reply'},finish_reason:'stop'}]};
  return stream ? 'data: '+JSON.stringify(response)+'\n\ndata: '+JSON.stringify({id,object:'chat.completion.chunk',choices:[],usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15}})+'\n\ndata: [DONE]\n\n' : JSON.stringify({...response,usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15}});
}
function chatNative(id,parentId,responseId=id) { const entry=nativeAssistant(id,parentId,responseId);entry.message.api='openai-completions';return entry; }

test('Pi Chat Completions extracts current HTTP JSON and SSE IDs without using tool or history IDs',()=>{
  for(const stream of [true,false]){
    const facts=piAdapter.extract(capture('unused',{transport:stream?'http':'https',body:{messages:[{role:'assistant',id:'old-response'},{role:'user',content:'same prompt'}]},responseEvidence:{body:chatBody('chat-a',stream),complete:true}}));
    assert.deepEqual(facts.locator,{kind:'pi',api:'chat-completions',responseId:'chat-a'});
  }
  const body=JSON.stringify({id:'chat-tool',object:'chat.completion',choices:[{message:{role:'assistant',tool_calls:[{id:'tool-id',type:'function',function:{name:'synthetic',arguments:'{}'}}]}}]});
  assert.equal(piAdapter.extract(capture('',{responseEvidence:{body,complete:true}})).locator.responseId,'chat-tool');
});

test('Pi Chat Completions rejects malformed, conflicting, mixed API and unsupported WS evidence',()=>{
  const extract=body=>piAdapter.extract(capture('',{responseEvidence:{body,complete:true}}));
  for(const id of [undefined,'',0,'x'.repeat(513)])assert.equal(extract(JSON.stringify({object:'chat.completion',id,choices:[]})).pi.responseId.reason,'invalid_metadata');
  assert.equal(extract(JSON.stringify({object:'chat.completion',id:'a',choices:{}})).pi.responseId.reason,'unsupported_format');
  assert.equal(extract(chatBody('a')+'data: {"object":"chat.completion.chunk","id":"b","choices":[]}\n\n').pi.responseId.status,'conflict');
  assert.equal(extract(chatBody('a')+'data: {"object":"response","id":"a"}\n\n').pi.responseId.status,'conflict');
  assert.equal(extract('{"id":"history","choices":[]}').locator,undefined);
  const ws=JSON.stringify({format:'ws-messages-v1',messages:[{direction:'server',sequence:0,payload:chatBody('a',false)}]});
  assert.equal(piAdapter.extract(capture('',{transport:'wss',responseEvidence:{body:ws,complete:true}})).pi.responseId.reason,'unsupported_format');
  assert.equal(piAdapter.extract(capture('',{responseEvidence:{body:chatBody(),complete:false}})).pi.responseId.reason,'content_unavailable');
});

test('Pi Chat Completions groups native sessions and inputs across tools, isolates APIs, and preserves usage',async t=>{
  const h=fixture(t);tree(h.source,[nativeUser('u1'),chatNative('a','u1'),{type:'message',id:'tool',parentId:'a',message:{role:'toolResult',content:[]}},chatNative('b','tool'),nativeUser('u2','b'),chatNative('c','u2')],'chat-one');
  tree(h.source,[nativeUser('u1'),chatNative('d','u1')],'chat-two');
  log(h.source,'responses-same-id',['a']);log(h.source,'anthropic-same-id',['a'],{api:'anthropic-messages'});
  const {CoreManager}=require('../dist/main/core'),core=new CoreManager(h.storage);
  const ids=['a','b','c','d'].map((id,i)=>core.handleCapturePayload({schema_version:'3.0.0',event_id:'chat-event-'+id,request_id:'chat-request-'+id,transport:'http',attribution:'request',method:'POST',status_code:200,capture_status:'complete',url_path:'/v1/chat/completions',request_headers:{'user-agent':'pi/1.3.0'},request_body:JSON.stringify({model:'synthetic',messages:[{role:'user',content:'same prompt'}]}),response_body:chatBody(id,i!==2)}));
  const bodies=ids.map(id=>h.storage.getRecordById(id).response_body);await h.storage.collectAttributionEvidence(h.roots);
  const sessions=await h.storage.getAttributedSessions();assert.equal(sessions.length,2);assert.deepEqual(sessions.map(s=>s.tasks_count).sort(),[1,2]);
  const assignments=ids.map(id=>assigned(sessions,id));assert.ok(assignments.every(a=>a.session.status==='resolved'&&a.turn.status==='resolved'));
  assert.equal(assignments[0].turn.value.id,assignments[1].turn.value.id);assert.notEqual(assignments[1].turn.value.id,assignments[2].turn.value.id);assert.notEqual(assignments[0].session.value,assignments[3].session.value);
  assert.equal(sessions.reduce((n,s)=>n+s.total_input_tokens,0),48);assert.equal(sessions.reduce((n,s)=>n+s.total_output_tokens,0),12);
  assert.deepEqual(ids.map(id=>h.storage.getRecordById(id).response_body),bodies);
  fs.rmSync(h.source,{recursive:true});h.storage.close();assert.deepEqual(await h.reopen().getAttributedSessions(),sessions);
});

test('Pi rule 2 missing-response records queue and recover as Chat Completions after upgrade without clearing captures',async t=>{
  const h=fixture(t);tree(h.source,[nativeUser('u'),chatNative('a','u')]);const id=insert(h.storage,'unused',{url_path:'/v1/chat/completions',response_body:chatBody('a')});
  const repo=new AttributionRepository(h.storage.db),saved=repo.readAll()[0],missing={status:'unresolved',reason:'missing_response',evidence:[]};
  const oldFacts={...saved.facts,locator:undefined,session:missing,pi:{...saved.facts.pi,api:undefined,responseId:missing}};
  h.storage.db.prepare('DELETE FROM request_attributions WHERE record_id=?').run(id);
  repo.saveBatch([{...saved,version:'2',facts:oldFacts,native:{status:'unavailable',reason:'source_missing'},decision:{...saved.decision,ruleVersion:'2',session:missing,turn:{status:'unresolved',reason:'missing_turn',evidence:[]}}}]);
  h.storage.db.prepare('DELETE FROM attribution_jobs WHERE record_id=?').run(id);
  const raw=h.storage.getRecordById(id).response_body;h.storage.close();const reopened=h.reopen();
  assert.ok(new AttributionRepository(reopened.db).dueJobs(Date.now(),100).includes(id),'version upgrade must queue records without an old locator');
  await reopened.collectAttributionEvidence(h.roots);const result=assigned(await reopened.getAttributedSessions(),id);
  assert.equal(result.ruleVersion,PI_RULE_VERSION);assert.equal(result.session.status,'resolved');assert.equal(result.turn.status,'resolved');assert.equal(reopened.getRecordById(id).response_body,raw);
});
