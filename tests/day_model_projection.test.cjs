const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StorageEngine } = require('../dist/main/storage');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-day-model-'));
  const storage = new StorageEngine(path.join(dir, 'lens.db'));
  t.after(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const date = storage.db.prepare("SELECT date('now','localtime') d").get().d;
  const insert = (event, extra) => storage.insertRecord({event_id:event, model:'unknown', input_tokens:90, output_tokens:10, total_tokens:100, token_source:'reported', ...extra});
  return { storage, date, insert };
}
const response = model => `data: ${JSON.stringify({type:'response.completed',response:{model,usage:{input_tokens:90,output_tokens:10,total_tokens:100}}})}\n\n`;

test('daily projection resolves only preserved, unambiguous evidence without changing ledger', async t => {
  const {storage:s,date,insert}=setup(t);
  const v2=insert('v2',{agent_name:'OpenAI Agent',provider:'unknown',url_path:'/v2/chat/completions',request_body:JSON.stringify({model:'deepseek-fixture',messages:[]})});
  const codex=insert('codex',{agent_name:'Codex',provider:'openai',url_path:'/backend-api/codex/responses',request_body:'',response_body:response('codex-fixture'),capture_status:'error'});
  const conflict=insert('conflict',{agent_name:'Codex',provider:'openai',url_path:'/backend-api/codex/responses',request_body:JSON.stringify({model:'a'}),response_body:response('b')});
  const gone=insert('gone',{agent_name:'OpenAI Agent',provider:'unknown',url_path:'/v2/chat/completions',request_body:'{"model":"gone"}'});
  s.db.prepare('DELETE FROM records WHERE id = ?').run(gone);
  const before=s.db.prepare('SELECT id, model, total_tokens FROM usage_events ORDER BY id').all();
  const models=await s.getResolvedDayModelUsage(date,'all');
  assert.deepEqual(Object.fromEntries(models.map(m=>[m.model,m.total_tokens])),{'unknown':200,'deepseek-fixture':100,'codex-fixture':100});
  assert.equal(models.reduce((sum,m)=>sum+m.total_tokens,0),400);
  const details=await s.getResolvedDayTokenDetails(date,'all');
  assert.equal(details.find(x=>x.id===v2).model,'deepseek-fixture');
  assert.equal(details.find(x=>x.id===codex).model,'codex-fixture');
  assert.equal(details.find(x=>x.id===conflict).model,'unknown');
  assert.equal(details.find(x=>x.id===gone).model,'unknown');
  assert.deepEqual(s.db.prepare('SELECT id, model, total_tokens FROM usage_events ORDER BY id').all(),before);
  assert.deepEqual((await s.getResolvedDayModelUsage(date,'Codex')).map(m=>m.model).sort(),['codex-fixture','unknown']);
  s.db.prepare("UPDATE records SET content_expired=1 WHERE id=?").run(v2);
  assert.ok((await s.getResolvedDayModelUsage(date,'all')).some(m=>m.model==='unknown'&&m.total_tokens===300));
});

test('v2 response evidence respects protocol scope and disagreement', async t => {
  const {storage:s,date,insert}=setup(t);
  const base={agent_name:'OpenAI Agent',provider:'unknown',url_path:'/v2/chat/completions'};
  const req=JSON.stringify({model:'request-model',messages:[]});
  const event=(object,model)=>`data: ${JSON.stringify({object,model,choices:[]})}\n\n`;
  const ok=insert('protocol-good',{...base,request_body:req,response_body:event('chat.completion.chunk','request-model')});
  const fake=insert('protocol-fake',{...base,request_body:req,response_body:'data: {"error":{"message":"bad"},"model":"other"}\n\n'});
  const conflict=insert('protocol-conflict',{...base,request_body:req,response_body:event('chat.completion.chunk','other')});
  const truncated=insert('protocol-truncated',{...base,request_body:req,capture_status:'truncated'});
  const details=await s.getResolvedDayTokenDetails(date);
  assert.equal(details.find(x=>x.id===ok).model,'request-model');
  assert.equal(details.find(x=>x.id===fake).model,'request-model');
  assert.equal(details.find(x=>x.id===conflict).model,'unknown');
  assert.equal(details.find(x=>x.id===truncated).model,'unknown');
});

test('Web and IPC share read-only worker projection, handle missing dates and release workers', async t => {
  const {storage:s,date,insert}=setup(t);
  insert('api',{agent_name:'OpenAI Agent',provider:'unknown',url_path:'/v2/chat/completions',request_body:'{"model":"fixture-api"}'});
  const { WebServer } = require('../dist/main/web');
  const web=new WebServer(s,{},0,undefined,'');
  t.after(()=>web.stop());
  let reply=await web.app.inject({url:'/api/stats/day-model-usage?date='+date});
  assert.equal(reply.statusCode,200); assert.equal(reply.json()[0].model,'fixture-api');
  reply=await web.app.inject({url:'/api/stats/day-details?date='+date});
  assert.equal(reply.statusCode,200); assert.equal(reply.json()[0].model,'fixture-api');
  reply=await web.app.inject({url:'/api/stats/day-model-usage'});
  assert.deepEqual(reply.json(),[]);
  const vm=require('node:vm');
  const source=fs.readFileSync(path.join(__dirname,'../dist/main/index.js'),'utf8');
  const handlers=new Map(), frame={url:'http://127.0.0.1:8088/'};
  const context={desktop_security_1:require('../dist/main/desktop-security'),mainWindow:{webContents:{id:1}},DASHBOARD_ORIGIN:frame.url.slice(0,-1),electron_1:{ipcMain:{handle:(name,handler)=>handlers.set(name,handler)}},storage:s,storage_1:{},session_1:{},sanitizer_1:{}};
  const start=source.indexOf('function setupIpc()'), end=source.indexOf('function findMacApp',start);
  vm.runInNewContext(source.slice(start,end)+'\n}\nsetupIpc();',context);
  const event={sender:{id:1,mainFrame:frame},senderFrame:frame};
  const results=await Promise.all([handlers.get('api:get-day-model-usage')(event,{date}),handlers.get('api:get-day-token-details')(event,{date})]);
  assert.equal(results[0][0].model,'fixture-api');assert.equal(results[1][0].model,'fixture-api');
  assert.throws(()=>handlers.get('api:get-day-model-usage')(event,{date:'invalid'}),/Invalid/);
  const active=s.getResolvedDayModelUsage(date);
  s.close();
  await assert.rejects(active,/closed/);
});

test('oversized and corrupted evidence returns an explicit error without changing usage', async t => {
  const {storage:s,date,insert}=setup(t);
  const id=insert('oversized',{agent_name:'OpenAI Agent',provider:'unknown',url_path:'/v2/chat/completions',request_body:'x'.repeat(8*1024*1024+1)});
  await assert.rejects(s.getResolvedDayModelUsage(date),/budget/);
  assert.equal(s.getStats().total_tokens,100);
  s.db.prepare("UPDATE records SET request_body = ? WHERE id = ?").run(Buffer.from('not-deflate'),id);
  await assert.rejects(s.getResolvedDayModelUsage(date));
  assert.equal(s.getStats().total_tokens,100);
});

test('simultaneous requests share a snapshot and later reads see writes', async t => {
  const {storage:s,date,insert}=setup(t);
  insert('one',{agent_name:'OpenAI Agent',provider:'unknown',url_path:'/v2/chat/completions',request_body:'{"model":"fixture"}'});
  const [models,details]=await Promise.all([s.getResolvedDayModelUsage(date),s.getResolvedDayTokenDetails(date)]);
  assert.equal(models.reduce((n,r)=>n+r.total_tokens,0),details.reduce((n,r)=>n+r.total_tokens,0));
  insert('two',{agent_name:'OpenAI Agent',provider:'unknown',url_path:'/v2/chat/completions',request_body:'{"model":"fixture"}'});
  assert.equal((await s.getResolvedDayModelUsage(date))[0].total_tokens,200);
});

test('daily model totals resolve evidence beyond 64 MiB without dropping tokens', async t => {
  const {storage:s,date,insert}=setup(t);
  const request=JSON.stringify({model:'large-fixture',messages:[],padding:'x'.repeat(4*1024*1024)});
  for(let i=0;i<17;i++) insert(`large-day-${i}`,{agent_name:'OpenAI Agent',provider:'unknown',url_path:'/v2/chat/completions',request_body:request,capture_status:'complete'});
  const result=await s.getResolvedDayModelUsage(date);
  assert.deepEqual(result.map(({model,total_tokens,request_count})=>({model,total_tokens,request_count})),
    [{model:'large-fixture',total_tokens:1700,request_count:17}]);
  assert.equal(s.getStats().total_tokens,1700);
});
