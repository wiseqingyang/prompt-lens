const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {StorageEngine}=require('../dist/main/storage');
const {AttributionRepository,digest}=require('../dist/main/attribution/repository');
const {antigravityAdapter}=require('../dist/main/attribution/adapters/antigravity');
const {decodeAntigravityArchive}=require('../dist/main/attribution/adapters/antigravityArchive');
const {fixture,SID,TRAJ}=require('./fixtures/antigravity-search.cjs');
const {ContentStore}=require('../dist/main/content-store');
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'lens-attribution-perf-')),file=path.join(root,'fixture.db');const s=new StorageEngine(file);t.after(()=>{s.close();fs.rmSync(root,{recursive:true,force:true});});const f=fixture();
 const add=(body,response)=>s.insertRecord({agent_name:'Antigravity',status_code:200,capture_status:'complete',request_body:JSON.stringify(body),response_body:typeof response==='string'?response:JSON.stringify(response),token_source:'reported',total_tokens:7});
 const origin=add(f.origin,f.originResponse),search=add(f.search,f.result),consumer=add(f.consumer,{});
 const repo=new AttributionRepository(s.db),native=decodeAntigravityArchive(f.native,'synthetic-source');
 repo.saveObservations([{recordId:origin,adapterId:'antigravity',scope:JSON.stringify(['antigravity',SID,TRAJ]),native,observedAt:'2026-01-02T00:00:00Z'}]);
 return {s,file,f,repo,origin,search,consumer};}
const requests=sessions=>sessions.flatMap(s=>s.tasks).flatMap(t=>t.turns);
test('unchanged persisted observation proof avoids replay after reopen; changed evidence still conflicts',async t=>{
 const h=setup(t),expected=await h.s.getAttributedSessions();const reopened=new StorageEngine(h.file);t.after(()=>reopened.close());
 const read=AttributionRepository.prototype.readObservations;let reads=0;
 AttributionRepository.prototype.readObservations=function(...args){reads++;return read.apply(this,args)};t.after(()=>{AttributionRepository.prototype.readObservations=read});
 assert.deepEqual(await reopened.getAttributedSessions(),expected);assert.equal(reads,0);
 const changed=structuredClone(h.f.native);changed.transcript=changed.transcript.replace('合成搜索任务','改写后的输入');
 h.repo.saveObservations([{recordId:h.origin,adapterId:'antigravity',scope:JSON.stringify(['antigravity',SID,TRAJ]),native:decodeAntigravityArchive(changed,'synthetic-source'),observedAt:'2026-01-02T00:01:00Z'}]);
 const next=await reopened.getAttributedSessions();assert.ok(reads>0);assert.equal(requests(next).find(r=>r.record_id===h.origin).assignment.turn.reason,'source_changed');assert.notEqual(requests(next).find(r=>r.record_id===h.search).assignment.toolLink?.status,'resolved');
});
test('revision proof skips duplicate reads but concurrent capture changes cannot commit stale facts',async t=>{
 const h=setup(t);await h.s.getAttributedSessions();const input=h.s.getAttributionCapture(h.search),row=h.repo.readAll([h.search])[0];
 const read=ContentStore.prototype.read;let reads=0;ContentStore.prototype.read=function(...args){reads++;return read.apply(this,args)};t.after(()=>{ContentStore.prototype.read=read});
 h.s.db.prepare("UPDATE request_attributions SET capture_digest='' WHERE record_id=?").run(h.search);
 const revision=h.repo.revision();assert.equal(h.repo.saveBatch([{...row,captureDigest:digest(JSON.stringify(input)),captureRevision:revision}]),true);assert.equal(reads,0);
 const other=new StorageEngine(h.file);try{
 const stale={...row,captureRevision:h.repo.revision()};other.db.prepare("UPDATE records SET request_body='{}' WHERE id=?").run(h.search);
 assert.equal(h.repo.saveBatch([stale]),false);assert.ok(reads>0);assert.equal(h.repo.readAll([h.search])[0].captureDigest,'');
 }finally{other.close();}
});
test('worker matches synchronous projection, keeps host responsive and observes external changes',async t=>{
 const h=setup(t),expected=await h.s.getAttributedSessions(),stats=h.s.getStats();
 const background=new StorageEngine(h.file,{backgroundAttribution:true});
 background.getAttributionCapture=()=>{throw new Error('must not parse on host')};
 let ticks=0;const timer=setInterval(()=>ticks++,1);
 try{
 assert.deepEqual(await background.getAttributedSessions(),expected);assert.ok(ticks>0);
 await background.collectAttributionEvidence('',[h.origin,h.search,h.consumer]);
 assert.deepEqual(await background.getAttributedSessions(),expected);
 h.s.db.prepare("UPDATE records SET response_body='{}' WHERE id=?").run(h.search);
 assert.deepEqual(await background.getAttributedSessions(),await h.s.getAttributedSessions());
 assert.deepEqual(background.getStats(),stats);
 h.s.db.prepare('DELETE FROM records WHERE id=?').run(h.origin);
 assert.deepEqual(await background.getAttributedSessions(),await h.s.getAttributedSessions());
 }finally{clearInterval(timer);await background.stopAttributionCollection();background.close();}
});
test('closing a worker rejects queued work, releases resources and never falls back to host parsing',async t=>{
 const h=setup(t),background=new StorageEngine(h.file,{backgroundAttribution:true});
 const pending=background.getAttributedSessions();const rejection=assert.rejects(pending,/closed|stopped/);
 await background.stopAttributionCollection();await rejection;background.close();
 const {AttributionWorkerClient}=require('../dist/main/attribution/workerClient');
 const client=new AttributionWorkerClient(h.file,()=>{});const work=client.sessions();const failed=assert.rejects(work,/stopped/);await client.worker.terminate();await failed;await assert.rejects(client.sessions(),/stopped/);await client.close();
 const reopen=new StorageEngine(h.file);try{assert.equal((await reopen.getAttributedSessions()).length,1)}finally{reopen.close();}
});
test('schema 18 migration preserves capture digests and rolls back a failed cache-column upgrade',async t=>{
 const h=setup(t);await h.s.getAttributedSessions();const before=h.repo.readAll().map(r=>r.captureDigest);
 h.s.db.exec('ALTER TABLE request_attributions DROP COLUMN observation_digest; PRAGMA user_version=17');
 const install=AttributionRepository.installProjectionCache;AttributionRepository.installProjectionCache=db=>{install(db);throw new Error('synthetic failure')};
 try{assert.throws(()=>new StorageEngine(h.file),/synthetic failure/)}finally{AttributionRepository.installProjectionCache=install;}
 assert.equal(h.s.db.pragma('user_version',{simple:true}),17);assert.equal(h.s.db.pragma('table_info(request_attributions)').some(c=>c.name==='observation_digest'),false);
 const reopened=new StorageEngine(h.file);try{assert.equal(reopened.db.pragma('user_version',{simple:true}),19);assert.deepEqual(new AttributionRepository(reopened.db).readAll().map(r=>r.captureDigest),before);assert.equal((await reopened.getAttributedSessions()).length,1)}finally{reopened.close();}
});
test('scoped block cache reuses verified content but detects corrupt replacements and evicts within its budget',t=>{
 const h=setup(t),{ContentReadCache}=require('../dist/main/content-store');
 const body=JSON.stringify({input:'synthetic shared history '.repeat(20000)});
 const first=h.s.insertRecord({request_body:body}),second=h.s.insertRecord({request_body:body});
 while(h.s.migrateContentBatch(100)){}
 const cache=new ContentReadCache(),store=new ContentStore(h.s.db,cache);let hits=0;const get=cache.get.bind(cache);cache.get=(...args)=>{const bytes=get(...args);if(bytes)hits++;return bytes};
 assert.equal(store.read(first,'request_body',''),body);hits=0;assert.equal(store.read(second,'request_body',''),body);assert.ok(hits>0);
 const block=h.s.db.prepare("SELECT hash FROM content_refs WHERE record_id=? AND field='request_body' ORDER BY ordinal LIMIT 1").get(first).hash;
 h.s.db.prepare("UPDATE content_blocks SET data=X'00' WHERE hash=?").run(block);
 assert.throws(()=>store.read(first,'request_body',''),/损坏|校验失败/);
 const bounded=new ContentReadCache(4);bounded.set('a','raw',Buffer.from('a'),Buffer.from('a'));bounded.set('b','raw',Buffer.from('bb'),Buffer.from('bb'));
 assert.equal(bounded.get('a','raw',Buffer.from('a')),undefined);assert.deepEqual(bounded.get('b','raw',Buffer.from('bb')),Buffer.from('bb'));assert.equal(bounded.get('b','raw',Buffer.from('cc')),undefined);
});
