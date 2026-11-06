const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveSessionIdentity } = require('../dist/main/session');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const T = '33333333-3333-4333-8333-333333333333';
const body = (cid = A, step = 0) => ({requestType:'agent', requestId:`agent/${cid}/123/${T}/${step+1}`, request:{sessionId:'shared-workspace',labels:{cascade_id:cid,trajectory_id:T,last_step_index:String(step)}}});

test('Antigravity: shared workspace sessionId never merges native conversations', () => {
  const resolve = b => resolveSessionIdentity({},b,'gemini','model',{agent_name:'Antigravity'});
  assert.equal(resolve(body(A)).id, A);
  assert.equal(resolve(body(B)).id, B);
  assert.equal(resolve(body(A)).confidence, 'exact');
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { antigravityAdapter: adapter, antigravityFacts } = require('../dist/main/attribution/adapters/antigravity');
const { AntigravityEvidenceSource } = require('../dist/main/attribution/sources/antigravity');
const { AttributionRepository } = require('../dist/main/attribution/repository');
const { AttributionService } = require('../dist/main/attribution/service');
const { AdapterRegistry } = require('../dist/main/attribution/registry');
const { StorageEngine } = require('../dist/main/storage');
const { ConfigManager } = require('../dist/main/config');
const capturedAt = '2026-01-02 00:00:00';
const step = (index, source='SYSTEM', type='TOOL_CALL', input) => ({ index, source, type, createdAt:'2026-01-01T00:00:00Z', ...(input === undefined ? {} : {input}) });
const user = index => step(index,'USER_EXPLICIT','USER_INPUT','same input');
const native = steps => ({status:'available',sourceId:'/synthetic',trajectoryId:T,steps});
const collectSessions = async (storage, root = '') => { await storage.collectAttributionEvidence(root); return storage.getAttributedSessions(); };
const collectService = async (service, root = '') => { await service.collect(root); return service.sessions(); };
const decide = (b, steps) => adapter.resolve({capturedAt,facts:antigravityFacts(b),native:native(steps)});
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lens-attribution-'));
  const storage=new StorageEngine(path.join(root,'lens.db'));
  t.after(async()=>{await storage.stopMaintenance();await storage.stopAttributionCollection();storage.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,storage,repository:new AttributionRepository(storage.db)};
}
function nativeFiles(root, steps, trajectory=T) {
  fs.mkdirSync(path.join(root,'conversations'),{recursive:true});
  const file=path.join(root,'conversations',A+'.db');
  const db=new Database(file);
  db.exec('CREATE TABLE IF NOT EXISTS trajectory_meta(cascade_id TEXT, trajectory_id TEXT); DELETE FROM trajectory_meta;');
  db.prepare('INSERT INTO trajectory_meta VALUES (?,?)').run(A,trajectory);db.close();
  const log=path.join(root,'brain',A,'.system_generated/logs/transcript.jsonl');
  fs.mkdirSync(path.dirname(log),{recursive:true});
  fs.writeFileSync(log,steps.map(s=>JSON.stringify({step_index:s.index,source:s.source,type:s.type,created_at:s.createdAt,content:s.input || 'not retained'})).join('\n')+'\n');
  return {file,log};
}
const insert = (storage,b,extra={}) => storage.insertRecord({agent_name:'Antigravity',provider:'gemini',model:'fixture',status_code:200,created_at:capturedAt,request_body:JSON.stringify(b),...extra});

test('exact session fields: either valid field works, conflicts and missing fields remain explicit', () => {
  const labelOnly=body();delete labelOnly.requestId;
  assert.equal(antigravityFacts(labelOnly).session.value,A);
  const requestOnly=body();delete requestOnly.request.labels;
  assert.equal(antigravityFacts(requestOnly).session.value,A);
  const conflict=body();conflict.request.labels.cascade_id=B;
  assert.deepEqual(antigravityFacts(conflict).session.candidates,[B,A]);
  assert.equal(antigravityFacts(conflict).session.status,'conflict');
  const missing={request:{sessionId:A,contents:[{text:`cascade_id: ${B}`}],labels:{cascade_id:'not-a-uuid'}}};
  assert.equal(antigravityFacts(missing).session.reason,'missing_session');
  assert.equal(antigravityFacts({...body(),requestId:'checkpoint/'+A,request:{}}).session.reason,'missing_session');
});

test('AND boundary: only explicit user input events start turns; positions and repeated text do not', () => {
  const steps=[user(0),step(1),step(2,'USER_EXPLICIT','TOOL_RESULT'),step(3,'SYSTEM','USER_INPUT'),user(4),step(5)];
  const first=decide(body(A,0),steps).turn.value.id;
  for (const position of [1,2,3]) assert.equal(decide(body(A,position),steps).turn.value.id,first);
  const second=decide(body(A,4),steps).turn.value.id;
  assert.notEqual(first,second,'same text at a distinct user event is another turn');
  assert.equal(decide(body(A,5),steps).turn.value.id,second);
  const retry=body(A,5);retry.request.labels.last_execution_id='different-execution';retry.request.labels.request_id=T+'-999';
  assert.equal(decide(retry,steps).turn.value.id,second);
  assert.equal(decide(body(A,1),[step(0,'USER_EXPLICIT','OTHER'),step(1,'SYSTEM','USER_INPUT')]).turn.reason,'no_user_input');
});

test('turn rules preserve matching identities and a deterministic snapshot', () => {
  const mismatch=body();mismatch.request.labels.last_step_index='5';
  assert.equal(decide(mismatch,[user(0)]).turn.reason,'position_conflict');
  const snapshot={capturedAt,facts:antigravityFacts(body()),native:native([user(0)])};
  snapshot.native.trajectoryId=B;
  assert.equal(adapter.resolve(snapshot).turn.reason,'trajectory_mismatch');
  snapshot.native.trajectoryId=T;snapshot.native.steps[0].createdAt='2026-01-03T00:00:00Z';
  assert.equal(adapter.resolve(snapshot).turn.reason,'source_changed');
  snapshot.native.steps[0].createdAt='2026-01-01T00:00:00Z';
  const serialized=JSON.stringify(snapshot), result=adapter.resolve(snapshot);
  assert.deepEqual(adapter.resolve(JSON.parse(serialized)),result);
  assert.equal(JSON.stringify(snapshot),serialized,'pure rule must not mutate evidence');
});

test('native source reads only configured files; validates trajectory, shape, size and containment', async t => {
  const {root}=fixture(t), sourceRoot=path.join(root,'native');
  const locator=antigravityFacts(body()).locator;
  assert.equal((await new AntigravityEvidenceSource('').read(locator)).reason,'source_disabled');
  assert.equal((await new AntigravityEvidenceSource(sourceRoot).read(locator)).reason,'source_missing');
  const {file,log}=nativeFiles(sourceRoot,[step(1),user(0)]);
  const before=fs.readFileSync(file);
  const source=new AntigravityEvidenceSource(sourceRoot), result=await source.read(locator);
  assert.equal(result.status,'available');assert.deepEqual(result.steps.map(s=>s.index),[0,1]);
  assert.equal(result.steps[1].input,undefined,'tool content is excluded from parsed rule facts');
  assert.deepEqual(fs.readFileSync(file),before,'native database is read-only');
  fs.appendFileSync(log,'{partial');
  assert.deepEqual(await source.read(locator),result,'one query observes one snapshot');
  assert.equal((await new AntigravityEvidenceSource(sourceRoot).read(locator)).reason,'source_invalid');
  nativeFiles(sourceRoot,[user(0),user(0)]);
  assert.equal((await new AntigravityEvidenceSource(sourceRoot).read(locator)).reason,'source_invalid');
  nativeFiles(sourceRoot,[user(0)],B);
  assert.equal((await new AntigravityEvidenceSource(sourceRoot).read(locator)).reason,'trajectory_mismatch');
  nativeFiles(sourceRoot,[user(0)]);
  fs.truncateSync(log,16*1024*1024+1);
  assert.equal((await new AntigravityEvidenceSource(sourceRoot).read(locator)).reason,'source_limit');
  const outside=path.join(root,'outside.jsonl');fs.writeFileSync(outside,'private');fs.unlinkSync(log);fs.symlinkSync(outside,log);
  assert.equal((await new AntigravityEvidenceSource(sourceRoot).read(locator)).reason,'source_invalid');
  assert.equal((await source.read({...locator,conversationId:'../escape'})).reason,'source_invalid');
});

test('service isolates sessions, native turns and pending requests, with replay and raw preservation', async t => {
  const {root,storage,repository}=fixture(t), sourceRoot=path.join(root,'native');
  nativeFiles(sourceRoot,[user(0),step(1),user(2)]);
  const third=insert(storage,body(A,2)),first=insert(storage,body(A,0)),retry=insert(storage,body(A,1));
  const other=insert(storage,body(B)),missing=insert(storage,{request:{sessionId:'shared-workspace'}});
  const conflict=body();conflict.request.labels.cascade_id=B;const conflicting=insert(storage,conflict);
  const raw=storage.getRequestBody(first);
  const result=await collectSessions(storage, sourceRoot);
  assert.equal(result.length,3);
  const session=result.find(s=>s.session_id===A), pending=result.find(s=>s.kind==='pending');
  assert.equal(session.tasks_count,2);assert.equal(session.turns_count,3);
  assert.deepEqual(session.tasks.find(s=>s.native_input_index===0).turns.map(r=>r.record_id),[first,retry]);
  assert.deepEqual(session.tasks.find(s=>s.native_input_index===2).turns.map(r=>r.record_id),[third]);
  assert.equal(pending.tasks_count,0);assert.deepEqual(pending.tasks[0].turns.map(r=>r.record_id),[missing,conflicting]);
  assert.equal(result.find(s=>s.session_id===B).tasks[0].turns[0].record_id,other);
  assert.equal(result.find(s=>s.session_id===B).tasks[0].turns[0].assignment.turn.reason,'source_missing');
  const snapshots=repository.readAll();
  for(const row of snapshots) assert.deepEqual(adapter.resolve(row),row.decision,'saved evidence replays without local files');
  const changes=storage.db.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual(await collectSessions(storage, sourceRoot),result);
  assert.equal(storage.db.prepare('SELECT total_changes() n').get().n,changes,'unchanged refresh does not rewrite projection rows');
  assert.equal(storage.getRequestBody(first),raw);
  assert.equal(snapshots.length,6);
  assert.ok(storage.db.prepare('SELECT COUNT(*) n FROM attribution_evidence').get().n < snapshots.length,'shared evidence is deduplicated');
  storage.clearRecords();
  assert.equal(repository.readAll().length,0);
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM attribution_evidence').get().n,0);
  await collectSessions(storage, sourceRoot);
  assert.equal(repository.readAll().length,0,'expired raw content never recreates retained snapshots');
});

test('late evidence may resolve unknown turns; rewrites remain unresolved across disabled source and reopen', async t => {
  const {root,storage,repository}=fixture(t), sourceRoot=path.join(root,'native');
  insert(storage,body(A,1));
  const reason = result => result[0].tasks[0].turns[0].assignment.turn;
  assert.equal(reason(await collectSessions(storage)).reason,'source_disabled');
  nativeFiles(sourceRoot,[user(0)]);
  assert.equal(reason(await collectSessions(storage, sourceRoot)).value.inputIndex,0,'known user input remains active while later log steps are missing');
  nativeFiles(sourceRoot,[user(0),step(1)]);
  assert.equal(reason(await collectSessions(storage, sourceRoot)).status,'resolved');
  await collectSessions(storage);
  nativeFiles(sourceRoot,[{...user(0),input:'rewritten'},step(1)]);
  assert.equal(reason(await collectSessions(storage, sourceRoot)).reason,'source_changed');
  assert.equal(reason(await collectService(new AttributionService(storage,repository), sourceRoot)).reason,'source_changed');
  for(const row of repository.readAll()) assert.deepEqual(adapter.resolve(row),row.decision);
});

test('registry is explicit and versioned; new adapters need no service branch and conflicts do not select by order', async t => {
  const {storage,repository}=fixture(t);
  insert(storage,body());
  assert.throws(()=>new AdapterRegistry([adapter,adapter]),/Duplicate/);
  const alternate={...adapter,id:'fixture-agent',version:'2',resolve:s=>({...adapter.resolve(s),agentId:'fixture-agent',ruleVersion:'2'})};
  assert.equal(new AdapterRegistry([adapter,alternate]).select({agentName:'Antigravity'}).status,'conflict');
  const sourceFactory=()=>({read:async()=>native([user(0)])});
  const one=await collectService(new AttributionService(storage,repository,new AdapterRegistry([adapter]),sourceFactory));
  const two=await collectService(new AttributionService(storage,repository,new AdapterRegistry([alternate]),sourceFactory));
  assert.equal(one[0].tasks_count,1);assert.equal(two[0].tasks_count,1);
  assert.equal(two[0].tasks[0].turns[0].assignment.ruleVersion,'2');
  assert.equal(repository.readAll().length,2,'different adapter versions coexist');
  const conflict=await collectService(new AttributionService(storage,repository,new AdapterRegistry([adapter,alternate]),sourceFactory));
  assert.equal(conflict[0].kind,'pending');
  assert.equal(conflict[0].tasks[0].turns[0].assignment.session.reason,'adapter_conflict');
});

test('projection commits are atomic and record deletion removes retained evidence', async t => {
  const {storage,repository}=fixture(t);
  const id=insert(storage,body());await collectSessions(storage);
  const original=repository.readAll()[0];
  assert.throws(()=>repository.saveBatch([{...original,version:'new'},{...original,adapterId:undefined}]),/NOT NULL/);
  assert.deepEqual(repository.readAll(),[original]);
  storage.db.prepare('DELETE FROM records WHERE id=?').run(id);
  assert.equal(repository.readAll().length,0);
  assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM attribution_evidence').get().n,0);
});

test('schema 12 upgrade is repeatable, preserves originals and rolls back failed migration', t => {
  const {root,storage}=fixture(t), file=path.join(root,'old.db');
  let db=new StorageEngine(file);const id=insert(db,body());const original=db.getRequestBody(id);
  db.db.exec('DROP TRIGGER delete_record_attribution; DROP TRIGGER expire_record_attribution; DROP TABLE request_attributions; DROP TABLE attribution_evidence;');
  db.db.pragma('user_version = 12');db.close();
  db=new StorageEngine(file);assert.equal(db.db.pragma('user_version',{simple:true}), 19);assert.equal(db.getRequestBody(id),original);db.close();
  db=new StorageEngine(file);assert.equal(db.getRequestBody(id),original);db.close();
  const bad=new Database(file);bad.pragma('user_version = 12');bad.close();
  const create=AttributionRepository.createSchema;
  try {
    AttributionRepository.createSchema=database=>{database.exec('CREATE TABLE should_rollback(id)');throw new Error('synthetic migration failure');};
    assert.throws(()=>new StorageEngine(file),/synthetic migration failure/);
  } finally {AttributionRepository.createSchema=create;}
  const check=new Database(file);
  try {assert.equal(check.pragma('user_version',{simple:true}),12);assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='should_rollback'").get(),undefined);}
  finally {check.close();}
});

test('native directory stays empty without an installation, validates absolute paths and preserves custom settings', t => {
  const {root}=fixture(t), file=path.join(root,'config.json'),config=new ConfigManager(file,'',root);
  assert.equal(config.getConfig().attribution.antigravityDataDir,'');
  for(const value of ['relative/path',123,'/bad\0path']) assert.throws(()=>config.save({attribution:{antigravityDataDir:value}}));
  config.save({attribution:{antigravityDataDir:root}});config.save({privacy:{maskApiKeys:false}});
  assert.equal(new ConfigManager(file,'',root).getConfig().attribution.antigravityDataDir,root);
});

test('session HTTP API automatically discovers the same native source as desktop configuration', async t => {
  const {root,storage}=fixture(t),sourceRoot=path.join(root,'.gemini/antigravity');nativeFiles(sourceRoot,[user(0)]);
  insert(storage,body());insert(storage,{request:{sessionId:'shared-workspace'}});
  const config=new ConfigManager(path.join(root,'config.json'),'',root);
  assert.equal(config.getConfig().attribution.antigravityDataDir,sourceRoot);
  assert.equal(fs.existsSync(path.join(root,'config.json')),false);
  const {WebServer}=require('../dist/main/web');
  const web=new WebServer(storage,{getCertPaths:()=>({caCertPath:'',exists:false})},0,undefined,undefined,config);
  t.after(()=>web.stop());
  await storage.collectAttributionEvidence(config.getConfig().attribution.antigravityDataDir);
  const response=await web.app.inject({method:'GET',url:'/api/sessions?limit=1',headers:{host:'127.0.0.1'}});
  assert.equal(response.statusCode,200);const data=response.json();assert.equal(data.total,2);assert.equal(data.sessions.length,1);
  const all=await web.app.inject({method:'GET',url:'/api/sessions',headers:{host:'127.0.0.1'}});
  assert.deepEqual(all.json().sessions,JSON.parse(JSON.stringify(await collectSessions(storage, sourceRoot))));
  assert.equal(all.json().sessions.find(s=>s.session_id===A).tasks_count,1);
});

test('parent conversation is an explicit relationship, not a guessed parent request or user turn', async t => {
  const {storage,repository}=fixture(t),child=body(B);child.request.labels.parent_cascade_id=A;
  const parentId=insert(storage,body(A)),childId=insert(storage,child);
  const sourceFactory=()=>({read:async locator=>native(locator.conversationId===A?[user(0)]:[step(0)])});
  const result=await collectService(new AttributionService(storage,repository,new AdapterRegistry(),sourceFactory));
  const session=result.find(s=>s.session_id===B);
  assert.equal(session.parent_session_id,A);assert.equal(session.tasks_count,1);
  assert.equal(session.tasks[0].user_prompt,'未识别名称');
  assert.equal(session.tasks[0].turns[0].record_id,childId);
  assert.equal(session.tasks[0].turns[0].assignment.turn.reason,'no_user_input');
  assert.deepEqual(result.find(s=>s.session_id===A).tasks[0].turns.map(r=>r.record_id),[parentId]);
});

test('changing attribution settings through HTTP never restarts business traffic', async t => {
  const {root,storage}=fixture(t), config=new ConfigManager(path.join(root,'config.json'),'',root);
  const {WebServer}=require('../dist/main/web');let restarts=0;
  const core={restart:async()=>{restarts++;}};
  const web=new WebServer(storage,{},0,core,undefined,config);t.after(()=>web.stop());
  const save=body=>web.app.inject({method:'POST',url:'/api/config',headers:{host:'127.0.0.1'},payload:body});
  assert.equal((await save({attribution:{antigravityDataDir:root}})).statusCode,200);
  assert.equal(restarts,0);
  assert.equal((await save({attribution:{antigravityDataDir:'relative'}})).statusCode,400);
  assert.equal(restarts,0);
  assert.equal((await save({proxy:{upstreamMode:'direct'}})).statusCode,200);
  assert.equal(restarts,1,'actual network setting changes still apply');
});

test('late ingestion orders native turns by numeric event position, never by text or record ID', async t => {
  const {storage,repository}=fixture(t);
  insert(storage,body(A,10));insert(storage,body(A,2));insert(storage,body(A,0));
  const steps=Array.from({length:11},(_,i)=>[0,2,10].includes(i)?{...user(i),input:'input '+i}:step(i));
  const sourceFactory=()=>({read:async()=>native(steps)});
  const result=await collectService(new AttributionService(storage,repository,new AdapterRegistry(),sourceFactory));
  assert.deepEqual(result[0].tasks.map(task=>task.native_input_index),[0,2,10]);
  assert.equal(result[0].title,'input 0');
});

test('capture changes during native reads publish a fresh atomic projection', async t => {
  const {storage,repository}=fixture(t);insert(storage,body(A));let inserted=false;
  const sourceFactory=()=>({read:async()=>{
    if(!inserted) {inserted=true;insert(storage,body(B));}
    return native([user(0)]);
  }});
  const result=await collectService(new AttributionService(storage,repository,new AdapterRegistry(),sourceFactory));
  assert.deepEqual(result.map(s=>s.session_id).sort(),[A,B]);
  assert.equal(repository.readAll().length,2);
});

test('native directory is discovered for new and empty configurations, including a later installation', t => {
  const {root}=fixture(t),home=path.join(root,'home'),file=path.join(root,'auto.json');
  const config=new ConfigManager(file,'',home);
  assert.equal(config.getConfig().attribution.antigravityDataDir,'');
  assert.equal(fs.existsSync(home),false,'discovery must not create Agent directories');
  const nativeRoot=path.join(home,'.gemini/antigravity');
  fs.mkdirSync(path.join(nativeRoot,'brain'),{recursive:true});
  assert.equal(config.getConfig().attribution.antigravityDataDir,'','partial installation is not a source');
  fs.mkdirSync(path.join(nativeRoot,'conversations'));
  assert.equal(config.getConfig().attribution.antigravityDataDir,nativeRoot,'new installation is discovered without restart');
  fs.writeFileSync(file,JSON.stringify({privacy:{maskApiKeys:false}}));
  assert.equal(new ConfigManager(file,'',home).getConfig().attribution.antigravityDataDir,nativeRoot);
  assert.equal(JSON.parse(fs.readFileSync(file)).attribution,undefined,'discovery does not rewrite unrelated user settings');
  config.save({attribution:{antigravityDataDir:''}});
  assert.equal(new ConfigManager(file,'',home).getConfig().attribution.antigravityDataDir,nativeRoot);
  const custom=path.join(root,'custom');config.save({attribution:{antigravityDataDir:custom}});
  assert.equal(config.getConfig().attribution.antigravityDataDir,custom,'explicit paths are never replaced even when unavailable');
  config.save({privacy:{maskApiKeys:false}});
  assert.equal(new ConfigManager(file,'',home).getConfig().attribution.antigravityDataDir,custom);
});


test('observed user boundaries persist across gaps, checkpoints and a missing log tail', () => {
  const steps=[user(209),step(213),step(215,'SYSTEM','CHECKPOINT'),
    step(216,'USER_EXPLICIT','TOOL_RESULT'),step(217,'SYSTEM','USER_INPUT'),user(220)];
  for(const position of [209,214,215,216,217,219]) {
    const turn=decide(body(A,position),steps).turn;
    assert.equal(turn.status,'resolved');assert.equal(turn.value.inputIndex,209);
  }
  for(const position of [220,221,300]) assert.equal(decide(body(A,position),steps).turn.value.inputIndex,220);
  assert.equal(decide(body(A,208),steps).turn.reason,'no_user_input','later user input never applies backwards');
  assert.equal(decide(body(A,215),[step(213),step(215)]).turn.reason,'no_user_input');
  assert.equal(decide(body(A,2),[user(0),step(2)]).turn.value.inputIndex,0);
});

test('late explicit input splits a gap-derived turn and persisted evidence replays after restart', async t => {
  const {root,storage,repository}=fixture(t),sourceRoot=path.join(root,'native');
  nativeFiles(sourceRoot,[user(209),step(215)]);
  const before=insert(storage,body(A,213)),after=insert(storage,body(A,215));
  const raw=storage.getRequestBody(after);
  let sessions=await collectSessions(storage,sourceRoot);
  assert.equal(sessions[0].tasks_count,1);assert.equal(sessions[0].tasks[0].native_input_index,209);
  assert.deepEqual(sessions[0].tasks[0].turns.map(r=>r.record_id),[before,after]);
  nativeFiles(sourceRoot,[user(209),user(214),step(215)]);
  sessions=await collectSessions(storage,sourceRoot);
  assert.deepEqual(sessions[0].tasks.map(task=>[task.native_input_index,task.turns.map(r=>r.record_id)]),[[209,[before]],[214,[after]]]);
  assert.equal(storage.getRequestBody(after),raw);
  fs.rmSync(sourceRoot,{recursive:true});
  const reopened=new StorageEngine(path.join(root,'lens.db'));
  try {assert.deepEqual(await reopened.getAttributedSessions(),sessions);} finally {reopened.close();}
  assert.deepEqual(await collectSessions(storage,sourceRoot),sessions);
  for(const row of repository.readAll()) assert.deepEqual(adapter.resolve(row),row.decision);
});


test('known sessions start with one default turn and continue it until an observed input', () => {
  const {attributionView}=require('../dist/main/attribution/view');
  const unresolved=(cid=A)=>adapter.resolve({capturedAt,facts:antigravityFacts({request:{labels:{cascade_id:cid}}}),native:{status:'unavailable',reason:'source_missing'}});
  const first=decide(body(A,4),[user(4)]),next=decide(body(A,8),[user(4),user(8)]);
  const row=(id,decision)=>({record:{id,agent_name:'Antigravity',created_at:capturedAt,status_code:200,input_tokens:1,output_tokens:2},decision});
  const items=[row(1,unresolved()),row(2,unresolved()),row(3,first),row(4,unresolved()),row(5,next),row(6,unresolved()),row(7,unresolved(B))];
  const original=structuredClone(items),groups=attributionView(items);
  const session=groups.find(s=>s.session_id===A),other=groups.find(s=>s.session_id===B);
  assert.equal(session.tasks_count,3);assert.equal(session.turns_count,6);
  assert.deepEqual(session.tasks.map(t=>t.turns.map(r=>r.record_id)),[[1,2],[3,4],[5,6]]);
  assert.deepEqual(session.tasks.map(t=>t.kind),['turn','turn','turn']);
  assert.equal(session.tasks[0].user_prompt,'未识别名称');assert.equal(session.tasks[0].native_input_index,undefined);
  assert.equal(session.tasks[0].turns[0].assignment.turn.reason,'missing_position','product default does not invent native evidence');
  assert.equal(other.tasks_count,1);assert.deepEqual(other.tasks[0].turns.map(r=>r.record_id),[7]);
  assert.notEqual(other.tasks[0].id,session.tasks[0].id);
  assert.equal(session.total_input_tokens,6);assert.equal(session.total_output_tokens,12);
  assert.deepEqual(items,original);assert.deepEqual(attributionView([...items].reverse()),groups);
  const conflict=body();conflict.request.labels.cascade_id=B;
  assert.equal(attributionView([row(8,decide(conflict,[user(0)]))])[0].kind,'pending');
});
