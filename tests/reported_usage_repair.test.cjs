const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const Database=require('better-sqlite3');
const {StorageEngine}=require('../dist/main/storage');
const {CoreManager}=require('../dist/main/core');
const {ContentStore}=require('../dist/main/content-store');
const {planRepair,applyRepair,repairFile}=require('../scripts/repair-reported-usage.cjs');
const error=JSON.stringify({error:{code:503,message:'Synthetic unavailable',status:'UNAVAILABLE'}});
const host='daily-cloudcode-pa.googleapis.com', endpoint='/v1internal/cascadeNuxes';
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lens-reported-'));
  const file=path.join(root,'lens.db'), storage=new StorageEngine(file);
  t.after(()=>{storage.close();fs.rmSync(root,{recursive:true,force:true});});
  const add=(patch={})=>storage.insertRecord({agent_name:'Antigravity',provider:'gemini',model:'synthetic',
    method:'POST',url_path:'/v1internal:streamGenerateContent',request_body:'{"request":{"contents":[{"role":"user","parts":[{"text":"synthetic"}]}]}}',
    response_body:error,request_headers:{host},input_tokens:0,output_tokens:10,total_tokens:10,token_source:'estimated',...patch});
  return {root,file,storage,db:storage.db,add};
}
test('ingest excludes only proven background endpoint and retains model error with unavailable usage', t=>{
  const h=fixture(t),core=new CoreManager(h.storage,{listenPort:0,receiverPort:0});
  const base={method:'GET',address:`https://${host}${endpoint}?page_size=10`,url_path:endpoint,
    request_headers:{host},status_code:503,response_body:error};
  assert.equal(core.handleCapturePayload(base),0);assert.equal(h.storage.getRecords({limit:-1}).length,0);
  const id=core.handleCapturePayload({...base,method:'POST',url_path:'/v1internal:streamGenerateContent',address:`https://${host}/v1internal:streamGenerateContent`});
  assert.ok(id);const row=h.db.prepare('SELECT * FROM records WHERE id=?').get(id);
  assert.equal(row.status_code,503);assert.equal(row.token_source,'unavailable');assert.equal(row.total_tokens,0);
  assert.equal(row.response_preview,'Synthetic unavailable');
});
test('one-time repair preserves raw content, real usage and event tombstones, and is idempotent', t=>{
  const h=fixture(t);
  const removed=h.add({method:'GET',url_path:endpoint,address:`https://${host}${endpoint}`,event_id:'synthetic-background'});
  const noUsage=h.add({event_id:'synthetic-no-usage'});
  const reported=h.add({token_source:'reported',thinking_tokens:10,input_tokens:20,output_tokens:5,total_tokens:25,
    response_body:JSON.stringify({candidates:[{content:{parts:[{thought:true,text:'reasoning'}]}}],
      usageMetadata:{promptTokenCount:20,candidatesTokenCount:5,totalTokenCount:25,thoughtsTokenCount:0}})});
  const gone=h.add({event_id:'synthetic-deleted-estimate'});h.db.prepare('DELETE FROM records WHERE id=?').run(gone);
  const validGone=h.add({event_id:'synthetic-deleted-reported',token_source:'reported',total_tokens:42});
  h.db.prepare('DELETE FROM records WHERE id=?').run(validGone);
  const original=h.db.prepare('SELECT request_body,response_body FROM records WHERE id=?').get(reported);
  // Exercise block-backed content and old source counts marked reported.
  const content=new ContentStore(h.db);while(content.migrateOne()) {}
  const plan=planRepair(h.db);assert.equal(plan.remove.length,1);assert.equal(plan.ledger.length,1);
  applyRepair(h.db,plan);
  assert.equal(h.db.prepare('SELECT id FROM records WHERE id=?').get(removed),undefined);
  const tomb=h.db.prepare('SELECT counted,total_tokens FROM usage_ledger WHERE id=?').get(removed);
  assert.deepEqual(tomb,{counted:0,total_tokens:0});
  assert.equal(h.storage.insertRecord({event_id:'synthetic-background'}),removed,'duplicate capture cannot resurrect deletion');
  assert.equal(h.db.prepare('SELECT token_source FROM records WHERE id=?').get(noUsage).token_source,'unavailable');
  const correct=h.db.prepare('SELECT * FROM records WHERE id=?').get(reported);
  assert.equal(correct.thinking_tokens,0);assert.equal(correct.total_tokens,25);assert.equal(correct.token_source,'reported');
  assert.equal(content.read(reported,'response_body',correct.response_body),original.response_body);
  assert.equal(content.read(reported,'request_body',correct.request_body),original.request_body);
  assert.equal(h.db.prepare('SELECT token_source FROM usage_ledger WHERE id=?').get(gone).token_source,'unavailable');
  assert.equal(h.db.prepare('SELECT total_tokens FROM usage_ledger WHERE id=?').get(validGone).total_tokens,42);
  const again=planRepair(h.db);
  assert.equal(again.remove.length+again.updates.length+again.ledger.length,0);
});
test('repair rejects stale plans and rolls back on write failure',t=>{
  const h=fixture(t);const id=h.add();
  const stale=planRepair(h.db);h.db.prepare("UPDATE records SET response_body='{}' WHERE id=?").run(id);
  assert.throws(()=>applyRepair(h.db,stale),/changed since backup/);
  h.db.exec("CREATE TRIGGER reject_usage BEFORE UPDATE OF token_source ON records BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END");
  assert.throws(()=>applyRepair(h.db,planRepair(h.db)),/synthetic write failure/);
  assert.equal(h.db.prepare('SELECT token_source FROM records WHERE id=?').get(id).token_source,'estimated');
  assert.equal(h.db.prepare('SELECT token_source FROM usage_ledger WHERE id=?').get(id).token_source,'estimated');
});
test('apply creates private verified backup before changing data, without schema migration',async t=>{
  const h=fixture(t);h.add();
  const before=h.db.pragma('user_version',{simple:true}),backup=path.join(h.root,'backup.db');
  const report=await repairFile(h.file,backup);
  assert.equal(report.correctedRecords,1);assert.equal(fs.statSync(backup).mode&0o777,0o600);
  const copy=new Database(backup,{readonly:true,fileMustExist:true});
  try {
    assert.equal(copy.pragma('integrity_check',{simple:true}),'ok');
    assert.equal(copy.prepare('SELECT token_source FROM records').get().token_source,'estimated');
  } finally {copy.close();}
  assert.equal(h.db.pragma('user_version',{simple:true}),before);
  await assert.rejects(repairFile(h.file,backup),/EEXIST/);
});

test('repair allows unrelated captures but rejects changed target content metadata or ledger',t=>{
  const h=fixture(t);const id=h.add();
  const plan=planRepair(h.db);
  const live=h.add({event_id:'synthetic-concurrent-capture'});
  applyRepair(h.db,plan);
  assert.equal(h.db.prepare('SELECT token_source FROM records WHERE id=?').get(id).token_source,'unavailable');
  assert.equal(h.db.prepare('SELECT token_source FROM records WHERE id=?').get(live).token_source,'estimated');
  const store=new ContentStore(h.db);while(store.migrateOne()) {}
  const contentPlan=planRepair(h.db);
  const original=h.db.prepare("SELECT digest FROM content_fields WHERE record_id=? AND field='response_body'").get(live).digest;
  h.db.prepare("UPDATE content_fields SET digest='synthetic-changed-digest' WHERE record_id=? AND field='response_body'").run(live);
  assert.throws(()=>applyRepair(h.db,contentPlan),/changed since backup/);
  h.db.prepare("UPDATE content_fields SET digest=? WHERE record_id=? AND field='response_body'").run(original,live);
  const stale=planRepair(h.db);
  h.db.prepare('UPDATE usage_ledger SET counted=0 WHERE id=?').run(live);
  assert.throws(()=>applyRepair(h.db,stale),/changed since backup/);
  assert.equal(h.db.prepare('SELECT token_source FROM records WHERE id=?').get(live).token_source,'estimated');
  const gone=h.add({event_id:'synthetic-concurrent-delete'});h.db.prepare('DELETE FROM records WHERE id=?').run(gone);
  const ledgerPlan=planRepair(h.db);
  h.db.prepare('DELETE FROM usage_ledger WHERE id=?').run(gone);
  assert.throws(()=>applyRepair(h.db,ledgerPlan),/changed since backup/);
});
