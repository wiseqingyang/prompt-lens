const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fixture,SID,TRAJ}=require('./fixtures/antigravity-search.cjs');
const {antigravityAdapter:adapter}=require('../dist/main/attribution/adapters/antigravity');
const {decodeAntigravityArchive}=require('../dist/main/attribution/adapters/antigravityArchive');
const {captureInput}=require('../dist/main/attribution/capture');
const {StorageEngine}=require('../dist/main/storage');
const {AttributionRepository}=require('../dist/main/attribution/repository');
const {attributionView}=require('../dist/main/attribution/view');
function scenario(){
 const f=fixture(),native=decodeAntigravityArchive(f.native,'synthetic-source');
 const make=(recordId,body,response,patch={})=>{const input=captureInput({agent_name:'Antigravity',status_code:200,capture_status:'complete',created_at:'2026-01-02 00:00:00',...patch},JSON.stringify(body),typeof response==='string'?response:JSON.stringify(response));const facts=adapter.extract(input);return {recordId,contentExpired:!!patch.content_expired,facts,decision:adapter.resolve({facts,native,capturedAt:input.capturedAt})};};
 return {f,make,items:[make(1,f.origin,f.originResponse),make(2,f.search,f.result),make(3,f.consumer,{}),make(4,f.later,{})]};
}
test('search result links to originating native turn, using exact UTF-8 result and sources, without rewriting identity',()=>{
 const {items}=scenario(),before=structuredClone(items);const links=adapter.relate(items),link=links.get(2);
 assert.equal(link.status,'resolved');assert.equal(link.value.parentRecordId,1);assert.equal(link.value.sessionId,SID);assert.equal(link.value.turn.inputIndex,0);assert.deepEqual(link.value.consumerRecordIds,[3,4]);assert.equal(items[1].decision.session.status,'unresolved');assert.deepEqual(items,before);
 assert.deepEqual(adapter.relate([...items].reverse()).get(2),link);
 assert.equal(adapter.relate(items.filter(i=>i.recordId!==1)).get(2),undefined,'consumer current turn cannot stand in for missing origin');
});
test('only complete exact search evidence links: failures, changed templates, queries, citations, sources and wrappers stay separate',()=>{
 for(const mutate of [
  (f)=>f.search.request.systemInstruction.parts[0].text+=' ',
  (f)=>f.search.request.contents[0].parts[0].text+=' ',
  (f)=>f.result.response.candidates[0].finishReason='MAX_TOKENS',
  (f)=>delete f.result.response.candidates[0].groundingMetadata,
  (f)=>f.result.response.candidates[0].groundingMetadata.groundingChunks[0].web.uri+='different',
  (f)=>f.result.response.candidates[0].groundingMetadata.groundingSupports[0].segment.endIndex=f.text.length,
  (f)=>f.result.response.candidates[0].groundingMetadata.groundingSupports[0].groundingChunkIndices=[9],
  (f)=>f.consumer.request.contents[1].parts[0].functionResponse.response.output+=' ',
  (f)=>f.consumer.request.contents[1].parts[0].functionResponse.id='unpaired',
  (f)=>f.consumer.request.contents[1].parts[0].functionResponse.response.output=f.output.replace('Completed At:','Unknown:')
 ]){const {f,make}=scenario();mutate(f);assert.notEqual(adapter.relate([make(1,f.origin,f.originResponse),make(2,f.search,f.result),make(3,f.consumer,{})]).get(2)?.status,'resolved');}
 for(const patch of [{status_code:503},{capture_status:'error'},{capture_status:'partial',truncated_reason:'limit'},{content_expired:1}]){const {f,make,items}=scenario();items[1]=make(2,f.search,f.result,patch);assert.notEqual(adapter.relate(items).get(2)?.status,'resolved');}
});
test('multiple searches, cross-session copies, duplicate origins and contradictory IDs cannot auto-link',()=>{
 for(const kind of ['search','session','failed-consumer','origin','unknown','query','position']){
  const {f,make,items}=scenario();
  if(kind==='position'){const search={...f.search,...f.main(0)};search.request={...f.search.request,labels:{...f.main(0).request.labels,last_step_index:'2'}};items[1]=make(2,search,f.result);}
  if(kind==='search')items.push(make(5,f.search,f.result));
  if(kind==='session')items.push(make(5,f.main(2,f.history,'33333333-3333-4333-8333-333333333333'),{}));
  if(kind==='failed-consumer')items.push(make(5,f.main(2,f.history,'33333333-3333-4333-8333-333333333333'),{}, {status_code:503,capture_status:'error'}));
  if(kind==='origin')items.push(make(5,f.origin,f.originResponse));
  if(kind==='unknown')items.push(make(5,{request:{contents:f.history}},{}));
  if(kind==='query'){const response={response:{candidates:[{content:{parts:[{functionCall:f.call},{functionCall:{...f.call,args:{query:'conflicting'}}}]}}]}};items[0]=make(1,f.origin,response);}
  assert.equal(adapter.relate(items).get(2)?.status,'conflict',kind);
  assert.deepEqual(adapter.relate([...items].reverse()).get(2),adapter.relate(items).get(2));
 }
});
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'lens-search-links-')),file=path.join(root,'fixture.db');let storage=new StorageEngine(file);t.after(()=>{storage.close();fs.rmSync(root,{recursive:true,force:true});});const f=fixture();
 const add=(body,response,created_at)=>storage.insertRecord({agent_name:'Antigravity',model:'synthetic',status_code:200,capture_status:'complete',token_source:'reported',input_tokens:5,output_tokens:2,total_tokens:7,created_at,request_body:JSON.stringify(body),response_body:typeof response==='string'?response:JSON.stringify(response)});
 const origin=add(f.origin,f.originResponse,'2026-01-02 00:00:00'),search=add(f.search,f.result,'2026-01-02 00:00:01'),consumer=add(f.consumer,{},'2026-01-02 00:00:02'),later=add(f.later,{},'2026-01-02 00:00:03');
 new AttributionRepository(storage.db).saveObservations([{recordId:origin,adapterId:'antigravity',scope:JSON.stringify(['antigravity',SID,TRAJ]),native:decodeAntigravityArchive(f.native,'synthetic-source'),observedAt:'2026-01-02T00:00:00Z'}]);
 return {f,origin,search,consumer,later,file,get storage(){return storage;},reopen(){storage.close();storage=new StorageEngine(file);}};
}
const request=(sessions,id)=>sessions.flatMap(s=>s.tasks).flatMap(t=>t.turns).find(r=>r.record_id===id);
test('stored facts replay links without source logs, keep accounting/raw identity, invalidate changed responses and deletion',async t=>{
 const h=setup(t),stats=h.storage.getStats(),raw=h.storage.getRequestBody(h.search);let sessions=await h.storage.getAttributedSessions();
 assert.equal(sessions.length,1);assert.deepEqual(sessions[0].tasks[0].turns.map(r=>r.record_id),[h.origin,h.search,h.consumer]);assert.deepEqual(sessions[0].tasks[1].turns.map(r=>r.record_id),[h.later]);assert.equal(sessions[0].turns_count,4);
 assert.equal(request(sessions,h.search).assignment.toolLink.status,'resolved');assert.equal(h.storage.getRequestBody(h.search),raw);assert.deepEqual(h.storage.getStats(),stats);
 h.reopen();assert.equal(request(await h.storage.getAttributedSessions(),h.search).assignment.toolLink.status,'resolved');
 const load=h.storage.getAttributionCapture.bind(h.storage);let reads=0;h.storage.getAttributionCapture=(id)=>{reads++;return load(id);};
 await h.storage.getAttributedSessions();assert.equal(reads,0,'warm queries do not read raw responses');
 h.storage.db.prepare("UPDATE records SET response_body='{}' WHERE id=?").run(h.search);
 sessions=await h.storage.getAttributedSessions();assert.equal(request(sessions,h.search).assignment.toolLink,undefined);
 h.storage.db.prepare('UPDATE records SET response_body=? WHERE id=?').run(JSON.stringify(h.f.result),h.search);
 assert.equal(request(await h.storage.getAttributedSessions(),h.search).assignment.toolLink.status,'resolved');
 h.storage.db.prepare('DELETE FROM records WHERE id=?').run(h.origin);
 assert.equal(request(await h.storage.getAttributedSessions(),h.search).assignment.toolLink,undefined);
});
test('v16 migration installs response invalidation; expiry cannot retain stale edges',async t=>{
 const h=setup(t);await h.storage.getAttributedSessions();h.storage.db.exec('DROP TRIGGER invalidate_search_attribution; PRAGMA user_version=16');h.reopen();
 assert.equal(h.storage.db.pragma('user_version',{simple:true}), 19);assert.equal(request(await h.storage.getAttributedSessions(),h.search).assignment.toolLink.status,'resolved');
 h.storage.db.prepare('UPDATE records SET content_expired=1 WHERE id=?').run(h.consumer);h.storage.db.prepare('UPDATE records SET content_expired=1 WHERE id=?').run(h.later);
 assert.equal(request(await h.storage.getAttributedSessions(),h.search).assignment.toolLink,undefined);
});
test('navigation and timeline display linked search exactly once with its own usage and raw details',async t=>{
 const h=setup(t),canonical=await h.storage.getAttributedSessions();const {createServer}=await import('vite');const vuePlugin=(await import('@vitejs/plugin-vue')).default;
 const server=await createServer({configFile:false,root:path.resolve(__dirname,'..'),plugins:[vuePlugin()],server:{middlewareMode:true,watch:null,hmr:false,ws:false},appType:'custom'});
 try{const {requestNavigationGroups}=await server.ssrLoadModule('/src/renderer/utils/requestNavigation.ts');const groups=requestNavigationGroups(canonical);assert.equal(groups.length,1);assert.equal(groups[0].kind,'session');
 const {buildChatTimelineTurns}=await server.ssrLoadModule('/src/renderer/utils/messageParser.ts');const task=groups[0].tasks[0];const records=Object.fromEntries(h.storage.getRecordsByIds(task.turns.map(r=>r.record_id),{includeRawBody:true}).map(r=>[r.id,r]));const turns=buildChatTimelineTurns(task,records);const search=turns.find(r=>r.recordId===h.search);assert.equal(search.toolLink.parentRecordId,h.origin);assert.equal(search.inputTokens,5);assert.ok(search.rawRequestBody.includes('synthetic'));
 const {default:Timeline}=await server.ssrLoadModule('/src/renderer/components/timeline/TimelineView.vue');const {createSSRApp}=require('vue'),{renderToString}=require('vue/server-renderer');const html=await renderToString(createSSRApp(Timeline,{turns,isLoading:false}));assert.match(html,/关联网页搜索/);assert.match(html,new RegExp('来自请求 #'+h.origin));assert.equal((html.match(/data-search-parent=/g)||[]).length,1);
 }finally{await server.close();}
});
test('failed v17 migration leaves v16 schema and raw records intact for retry',async t=>{
 const h=setup(t);await h.storage.getAttributedSessions();h.storage.db.exec('DROP TRIGGER invalidate_search_attribution; PRAGMA user_version=16');h.storage.close();
 const original=AttributionRepository.installSearchInvalidation;
 AttributionRepository.installSearchInvalidation=db=>{original(db);throw new Error('synthetic migration failure');};
 try{assert.throws(()=>new StorageEngine(h.file),/synthetic migration failure/);}finally{AttributionRepository.installSearchInvalidation=original;}
 const D=require('better-sqlite3'),db=new D(h.file,{readonly:true});try{assert.equal(db.pragma('user_version',{simple:true}),16);assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='invalidate_search_attribution'").get(),undefined);assert.equal(db.prepare('SELECT COUNT(*) n FROM records').get().n,4);}finally{db.close();}
 h.reopen();assert.equal(request(await h.storage.getAttributedSessions(),h.search).assignment.toolLink.status,'resolved');
});
test('partial collection never persists a cross-request edge and later full projection restores it',async t=>{
 const h=setup(t);const {AttributionService}=require('../dist/main/attribution/service');
 const service=new AttributionService(h.storage,new AttributionRepository(h.storage.db));
 try{await service.collect('',[h.search]);const sessions=await service.sessions();assert.equal(request(sessions,h.search).assignment.toolLink.status,'resolved');
 const stored=new AttributionRepository(h.storage.db).readAll([h.search]);assert.ok(stored.every(r=>r.decision.toolLink===undefined),'single-request decisions remain distinct from collection relations');
 }finally{service.close();}
});
