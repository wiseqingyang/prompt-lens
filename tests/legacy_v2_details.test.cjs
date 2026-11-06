const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StorageEngine } = require('../dist/main/storage');
const { dissectPromptAnatomy } = require('../dist/main/session');
const { WebServer } = require('../dist/main/web');

const request = JSON.stringify({ model:'fixture-model', messages:[
  {role:'system',content:'Synthetic system instructions'},
  {role:'user',content:'Synthetic user question'}
] });
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lens-legacy-v2-detail-'));
  const storage=new StorageEngine(path.join(dir,'lens.db'));
  t.after(()=>{storage.close();fs.rmSync(dir,{recursive:true,force:true});});
  return storage;
}
function add(storage, overrides={}) {
  return storage.insertRecord({event_id:`synthetic-${Math.random()}`, agent_name:'OpenAI Agent', provider:'unknown',model:'unknown',
    url_path:'/v2/chat/completions', capture_status:'complete', request_body:request, response_body:'data: {"object":"chat.completion.chunk","model":"fixture-model","choices":[]}\n\n',
    input_tokens:12,output_tokens:2,total_tokens:14,token_source:'reported', ...overrides});
}

test('legacy v2 details project retained request without rewriting records or usage', async t=>{
  const storage=fixture(t), id=add(storage);
  const before=storage.db.prepare('select provider, model, system_prompt, prompt_summary, user_prompt, total_tokens from records where id=?').get(id);
  const detail=storage.getRecordById(id);
  assert.equal(detail.system_prompt,'Synthetic system instructions');
  assert.equal(detail.user_prompt,'Synthetic user question');
  assert.equal(detail.prompt_summary,'Synthetic user question');
  assert.equal(detail.request_body,request);
  assert.equal(detail.total_tokens,14);
  assert.ok(dissectPromptAnatomy(detail).layers.some(x=>x.content.includes('Synthetic system instructions')));
  const batch=storage.attachTimelineDetail(storage.getRecordsByIds([id],{lightweight:true})[0]);
  assert.equal(batch.request_body,'');
  assert.equal(batch.raw_loaded,false);
  assert.equal(batch.parsed_question.newText,'Synthetic user question');
  assert.ok(batch.anatomy.layers.some(x=>x.content.includes('Synthetic system instructions')));
  assert.equal(batch.user_prompt,'Synthetic user question');
  assert.deepEqual(storage.db.prepare('select provider, model, system_prompt, prompt_summary, user_prompt, total_tokens from records where id=?').get(id),before);
  assert.equal(storage.getStats().total_tokens,14);
  const web=new WebServer(storage,{},0); t.after(()=>web.stop());
  const res=await web.app.inject({url:`/api/records/${id}`});assert.equal(res.statusCode,200);assert.equal(res.json().system_prompt,'Synthetic system instructions');
  const resp=await web.app.inject({url:'/api/records/batch',method:'POST',payload:{ids:[id],lightweight:true}});assert.equal(resp.statusCode,200);assert.ok(resp.json().records[0].anatomy.layers.some(x=>x.content.includes('Synthetic system instructions')));
});

test('legacy projection leaves unsupported, incomplete, corrupt and existing fields alone', t=>{
  const storage=fixture(t);
  for(const overrides of [
    {url_path:'/v2/chat/completions-other'}, {provider:'gemini'}, {capture_status:'truncated'},
    {request_body:'{"messages":['}, {request_body:JSON.stringify({messages:'not-an-array'})},
    {request_body:''}
  ]) {
    const id=add(storage,overrides), detail=storage.getRecordById(id);
    assert.equal(detail.system_prompt,''); assert.equal(detail.user_prompt,'');assert.equal(detail.prompt_summary,'');
  }
  const expired=add(storage); storage.db.prepare('update records set content_expired=1 where id=?').run(expired);
  assert.equal(storage.getRecordById(expired).system_prompt,'');
  const id=add(storage,{system_prompt:'Saved system',prompt_summary:'Saved summary',user_prompt:'Saved user'});
  const detail=storage.getRecordById(id);
  assert.equal(detail.system_prompt,'Saved system');assert.equal(detail.prompt_summary,'Saved summary');assert.equal(detail.user_prompt,'Saved user');
  while(storage.migrateContentBatch(10)) {}
  const savedBatch=storage.attachTimelineDetail(storage.getRecordsByIds([id],{lightweight:true})[0]);
  assert.equal(savedBatch.system_prompt,'Saved system');
  assert.ok(savedBatch.anatomy.layers.some(x=>x.content.includes('Saved system')));
  const tool=add(storage,{request_body:JSON.stringify({messages:[{role:'user',content:'Earlier question'},{role:'assistant',content:'Earlier response'},{role:'tool',tool_call_id:'abc',content:'Latest tool result'}]})});
  const toolDetail=storage.getRecordById(tool);
  assert.equal(toolDetail.user_prompt,'');
  assert.match(toolDetail.prompt_summary,/Tool Result/);
  assert.doesNotMatch(dissectPromptAnatomy(toolDetail).user_prompt,/Earlier question/);
  const toolBatch=storage.attachTimelineDetail(storage.getRecordsByIds([tool],{lightweight:true})[0]);
  assert.doesNotMatch(toolBatch.anatomy.user_prompt,/Earlier question/);
  assert.match(toolBatch.parsed_question.historyMessages.map(x=>x.text).join(' '),/Earlier question/);
  const parts=add(storage,{request_body:JSON.stringify({messages:[{role:'system',content:'Rules'},{role:'user',content:[{type:'text',text:'Question from text part'}]}]})});
  assert.equal(storage.getRecordById(parts).user_prompt,'Question from text part');
});

test('desktop IPC detail and timeline share the same legacy projection',async t=>{
  const vm=require('node:vm'); const storage=fixture(t); const id=add(storage);
  const source=fs.readFileSync(path.join(__dirname,'../dist/main/index.js'),'utf8');
  const handlers=new Map(); const frame={url:'http://127.0.0.1:8088/'};
  const context={desktop_security_1:require('../dist/main/desktop-security'), mainWindow:{webContents:{id:1}},DASHBOARD_ORIGIN:'http://127.0.0.1:8088',
    ipcMain:{handle:(name,handler)=>handlers.set(name,handler)}, storage,
    storage_1:{default:undefined},electron_1:{ipcMain:{handle:(name,handler)=>handlers.set(name,handler)}},
    session_1:require('../dist/main/session'),sanitizer_1:require('../dist/main/sanitizer')};
  const begin=source.indexOf('function setupIpc()'),end=source.indexOf('function findMacApp',begin);
  assert.ok(begin>=0&&end>begin);vm.runInNewContext(source.slice(begin,end)+'\n}\nsetupIpc();',context);
  const event={sender:{id:1,mainFrame:frame},senderFrame:frame};
  const detail=await handlers.get('api:get-record-detail')(event,id);
  assert.equal(detail.system_prompt,'Synthetic system instructions');
  assert.ok(detail.anatomy.layers.some(x=>x.content.includes('Synthetic system instructions')));
  const [row]=await handlers.get('api:get-records-by-ids')(event,[id],{lightweight:true});
  assert.equal(row.raw_loaded,false);
  assert.ok(row.anatomy.layers.some(x=>x.content.includes('Synthetic system instructions')));
});
