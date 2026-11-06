const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StorageEngine, compressBody, decompressBody } = require('../dist/main/storage');

test('new raw payloads above 5 MiB remain byte-exact through staging, blocks and reopen', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-raw-preserve-'));
  const file = path.join(dir, 'lens.db');
  let storage = new StorageEngine(file);
  t.after(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const raw = JSON.stringify({ input: '中文😀\n'.repeat(700000), suffix: 'end' });
  assert.ok(Buffer.byteLength(raw) > 5 * 1024 * 1024);
  assert.equal(decompressBody(compressBody(raw)), raw);
  const id = storage.insertRecord({ session_id: 'synthetic', request_body: raw, response_body: raw });
  assert.equal(storage.getRecordById(id).request_body, raw);
  while (storage.migrateContentBatch(100)) {}
  storage.close(); storage = new StorageEngine(file);
  assert.equal(storage.getRecordById(id).request_body, raw);
  assert.equal(storage.getRecordById(id).response_body, raw);
});

const { CoreManager } = require('../dist/main/core');
const { extractResponseInfo } = require('../dist/main/parser');
const { WebServer } = require('../dist/main/web');
const Database = require('better-sqlite3');
const zlib = require('node:zlib');
function isolated(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-capture-regression-'));
  const storage = new StorageEngine(path.join(dir, 'lens.db'));
  t.after(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return storage;
}
function wsBody(messages) { return JSON.stringify({ format: 'ws-messages-v1', messages: messages.map((payload, i) => ({ direction: 'server', sequence: i + 2, payload: JSON.stringify(payload) })) }); }
function event(id, input, response, extra = {}) {
  return { event_id: id, request_id: id, capture_status: 'complete', status_code: 101, body_format: 'ws-messages-v1', transport: 'wss',
    address: 'wss://fixture.invalid/v1/responses?secret=fixture-only', url_path: '/v1/responses',
    request_headers: { 'user-agent': 'Codex Desktop/0.162.0-alpha.17.2' },
    request_body: JSON.stringify({ type: 'response.create', model: 'fixture', input, client_metadata: { thread_id: 'thread-A', turn_id: 'turn-A' } }), response_body: wsBody(response), ...extra };
}
function terminal(id, text='answer') {
  return { type: 'response.completed', response: { id, status: 'completed', output: [{type:'message',role:'assistant',content:[{type:'output_text',text}]}], usage:{input_tokens:10,output_tokens:2,total_tokens:12} } };
}

test('WS parser consumes exact messages, deduplicates sequence deltas and keeps usage/tool/thinking separate', t => {
  const storage = isolated(t), core = new CoreManager(storage);
  const delta = {type:'response.output_text.delta',sequence_number:1,delta:'answer'};
  const done = terminal('r1');
  done.response.output.push({type:'function_call',id:'tool-item',call_id:'call-one',name:'fixture_tool',arguments:'{"value":1}'},
    {type:'reasoning',summary:[{type:'summary_text',text:'reasoning'}]},
    {type:'message',content:[{type:'output_text',text:' plus second output'}]});
  const capture = event('first', 'question', [delta,delta,done]);
  const id = core.handleCapturePayload(capture);
  const row = storage.getRecordById(id);
  assert.equal(row.response_text, 'answer plus second output');
  assert.equal(row.thinking_text, 'reasoning');
  assert.equal(JSON.parse(row.tool_calls_json)[0].name,'fixture_tool');
  assert.equal(row.total_tokens,12);
  assert.equal(row.token_source,'reported');
  assert.equal(row.response_body,capture.response_body);
  assert.equal(row.response_id,'r1');
  assert.ok(!row.address.includes('fixture-only'));
  assert.equal(core.handleCapturePayload(capture),id);
  assert.equal(storage.getStats().total_tokens,12);
  storage.migrateContentBatch(100);
  assert.equal(storage.getRecordById(id).response_body,capture.response_body);
  assert.equal(storage.getRecordsByIds([id],{lightweight:true})[0].response_text,'');
  const zero=terminal('zero','text');zero.response.usage={input_tokens:0,output_tokens:0,total_tokens:0};
  assert.equal(extractResponseInfo('openai',wsBody([zero]),'/v1/responses','ws-messages-v1').usage.token_source,'reported');
  assert.equal(extractResponseInfo('openai',wsBody([{type:'error',error:{message:'failed'}}]),'/v1/responses','ws-messages-v1').usage.token_source,'unavailable');
  assert.equal(extractResponseInfo('openai','broken','/v1/responses','ws-messages-v1').usage.token_source,'parse_error');
  const diagnostic=event('connection-diagnostic','',[{type:'error',error:{message:'synthetic connection error'}}],{attribution:'connection',capture_status:'error',request_body:''});
  const before=storage.getStats();
  const diagnosticId=core.handleCapturePayload(diagnostic);
  assert.equal(storage.getRecordById(diagnosticId).token_source,'unavailable');
  assert.notEqual(storage.getRecordById(diagnosticId).session_id,row.session_id);
  assert.equal(core.handleCapturePayload(diagnostic),diagnosticId);
  assert.equal(storage.getStats().total_requests,before.total_requests);
  assert.equal(storage.getStats().total_tokens,before.total_tokens);
  storage.rebuildRecordIdentities();
  assert.notEqual(storage.getRecordById(diagnosticId).session_id,storage.getRecordById(id).session_id);
  assert.equal(storage.getRecordById(diagnosticId).session_confidence,'unknown');
  assert.equal(storage.getStats().total_requests,before.total_requests);
  storage.clearRecords();
  assert.equal(core.handleCapturePayload(diagnostic),diagnosticId);
  assert.equal(storage.getStats().total_requests,before.total_requests);
});

test('history follows response branches only in exact Agent/session/namespace, with expiry, cycles and budgets', async t => {
  const storage = isolated(t), core = new CoreManager(storage);
  const root=core.handleCapturePayload(event('root','first question',[terminal('root-response')]));
  const createChild=(id,parent,session='thread-A')=>core.handleCapturePayload(event(id,'new input',[terminal(id+'-response')],{
    request_headers:{'user-agent':'Codex Desktop/0.162.0-alpha.17.2'},
    request_body:JSON.stringify({type:'response.create',model:'fixture',client_metadata:{thread_id:session,turn_id:'turn-A'},input:[{type:'function_call_output',call_id:'call-one',output:'result'},{role:'user',content:'new input'}],previous_response_id:parent})
  }));
  const left=createChild('left','root-response'), right=createChild('right','root-response');
  const before=storage.getStats().total_tokens;
  for(const id of [left,right]) {
    const history=storage.getRelatedHistory(id);
    assert.equal(history.status,'complete');assert.equal(history.records.length,1);
    assert.equal(history.records[0].record_id,root);assert.equal(history.messageCount,2);
    assert.deepEqual(history.records[0].messages.map(m=>m.text),['first question','answer']);
  }
  const outside=createChild('outside','root-response','thread-B');
  assert.equal(storage.getRelatedHistory(outside).status,'missing');
  storage.db.prepare('UPDATE records SET session_namespace = ? WHERE id = ?').run('other-namespace',outside);
  assert.equal(storage.getRelatedHistory(outside).records.length,0);
  storage.db.prepare('UPDATE records SET session_confidence = ? WHERE id = ?').run('unknown',outside);
  assert.equal(storage.getRelatedHistory(outside).status,'untrusted');
  const web=new WebServer(storage,{},0); t.after(()=>web.app.close());
  const historyReply=await web.app.inject({method:'GET',url:`/api/records/${left}/history`});
  assert.deepEqual(historyReply.json(),storage.getRelatedHistory(left));
  const exportReply=await web.app.inject({method:'GET',url:`/api/records/${left}/fixture`});
  assert.equal(exportReply.json().body_format,'ws-messages-v1');
  assert.ok(!exportReply.json().request_body.includes('first question'));
  assert.equal(storage.getStats().total_tokens,before+12);
  const toolParent=core.handleCapturePayload(event('tool-parent',[{type:'function_call',name:'fixture_tool',call_id:'fixture-call',arguments:'{"value":42}'}],[terminal('tool-response')]));
  const toolChild=createChild('tool-child','tool-response');
  const toolHistory=storage.getRelatedHistory(toolChild);
  assert.equal(toolHistory.status,'complete');
  assert.equal(toolHistory.records[0].record_id,toolParent);
  assert.ok(toolHistory.records[0].messages[0].text.includes('fixture_tool'));
  assert.ok(toolHistory.records[0].messages[0].text.includes('42'));
  storage.db.prepare('UPDATE records SET previous_response_id = ? WHERE id = ?').run('left-response',root);
  assert.equal(storage.getRelatedHistory(left).status,'cycle');
  storage.db.prepare('UPDATE records SET previous_response_id = ?, request_body = ? WHERE id = ?').run('',JSON.stringify({input:'x'.repeat(1024*1024)}),root);
  assert.equal(storage.getRelatedHistory(left).status,'budget');
  storage.db.prepare('UPDATE records SET content_expired = 1 WHERE id = ?').run(root);
  assert.equal(storage.getRelatedHistory(left).status,'expired');
  storage.db.prepare('DELETE FROM records WHERE id = ?').run(root);
  assert.equal(storage.getRelatedHistory(left).status,'missing');
});

test('schema 11 upgrade only adds capture metadata, preserves Deflate/raw blocks, and rolls back failed upgrades', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'lens-schema12-'));
  const file = path.join(dir,'lens.db');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let storage=new StorageEngine(file);
  const raw='data: {"type":"response.completed","response":{"id":"legacy"}}\n\n';
  const id=storage.insertRecord({event_id:'legacy',session_id:'synthetic',response_text:'saved',request_body:'legacy request',response_body:raw});
  storage.migrateContentBatch(100);
  storage.db.prepare('UPDATE records SET request_body = ? WHERE id = ?').run(zlib.deflateRawSync(Buffer.from('legacy request')),id);
  storage.db.exec('DROP TRIGGER IF EXISTS invalidate_capture_attribution; DROP TRIGGER IF EXISTS invalidate_connection_attribution');
  for(const column of ['transport','address','body_format','body_encoding','connection_id','stream_id','response_id','previous_response_id','attribution','response_headers']) {
    if(column==='response_id') storage.db.exec('DROP INDEX idx_records_response_relation');
    storage.db.exec(`ALTER TABLE records DROP COLUMN ${column}`);
  }
  storage.db.pragma('user_version = 11');storage.close();
  const originalExec=Database.prototype.exec;
  Database.prototype.exec=function(sql) { if(sql.includes('ADD COLUMN body_encoding')) throw new Error('synthetic migration failure'); return originalExec.call(this,sql); };
  try { assert.throws(()=>new StorageEngine(file),/synthetic migration failure/); } finally { Database.prototype.exec=originalExec; }
  const db=new Database(file);
  assert.equal(db.pragma('user_version',{simple:true}),11);
  assert.ok(!db.pragma('table_info(records)').some(c=>c.name==='transport'));db.close();
  storage=new StorageEngine(file);
  try {
    assert.equal(storage.db.pragma('user_version',{simple:true}), 19);
    const row=storage.getRecordById(id);assert.equal(row.request_body,'legacy request');assert.equal(row.response_body,raw);
    assert.equal(row.body_format,'');assert.equal(row.response_id,'');assert.equal(row.response_text,'saved');
  } finally { storage.close(); }
  storage=new StorageEngine(file);assert.equal(storage.getRecordById(id).response_body,raw);storage.close();
});

test('unified renderer navigation and readable/current-history semantics use actual session and parser code', async t => {
  const {createServer}=await import('vite');
  const server=await createServer({configFile:false,root:path.resolve(__dirname,'..'),server:{middlewareMode:true,watch:null},appType:'custom'});
  t.after(()=>server.close());
  const {sessionNavigation,shortTitle}=await server.ssrLoadModule('/src/renderer/utils/sessionNavigation.ts');
  const {buildChatTimelineTurns,getTurnReqCopyContent,getTurnResCopyContent}=await server.ssrLoadModule('/src/renderer/utils/messageParser.ts');
  const {describeCommunication}=await server.ssrLoadModule('/src/shared/communication.ts');
  for(const transport of ['http','https','ws','wss']) {
    const description=describeCommunication({transport,body_format:transport.startsWith('ws')?'ws-messages-v1':'sse',url_path:'/v1/responses',address:transport+'://user:password@fixture.invalid/v1/responses?arbitraryCredential=secret'});
    assert.equal(description.transport,transport.toUpperCase());
    assert.equal(description.api,'Responses API');
    assert.equal(description.format,transport.startsWith('ws')?'JSON 消息':'SSE');
    assert.ok(!description.address.includes('password')&&!description.address.includes('secret'));
  }
  assert.equal(describeCommunication({url_path:'/v1/messages'}).transport,'');
  assert.equal(describeCommunication({url_path:'/v1/messages'}).format,'');
  assert.equal(describeCommunication({url_path:'/v1/messages'}).api,'Messages API');
  assert.deepEqual(describeCommunication({}),{transport:'',format:'',api:'',address:''});
  assert.equal(describeCommunication({transport:'unknown',body_format:'unknown'}).transport,'');
  assert.equal(describeCommunication({transport:'unknown',body_format:'unknown'}).format,'');
  const group={id:'session',agent_name:'Codex',turns_count:3,tasks:[{id:'new',user_prompt:'long',turns:[{record_id:3,turn_index:1}]},{id:'old',user_prompt:'# 中文😀\n'.repeat(100),turns:[{record_id:1,turn_index:1},{record_id:2,turn_index:2}]}]};
  const session=sessionNavigation(group);
  assert.deepEqual(session.turns.map(t=>[t.record_id,t.turn_index]),[[1,1],[2,2],[3,3]]);
  assert.ok(Array.from(shortTitle(group.tasks[1].user_prompt)).length<=29);
  const raw=' { "input" : [ {"role":"user","content":"first"}, {"role":"user","content":"second"} ] } ';
  const turns=buildChatTimelineTurns(session,{1:{request_body:raw,response_body:' { "output" : [] } ',user_prompt:'full',related_history:{records:[],messageCount:0,status:'none'}}});
  assert.equal(turns[0].question.historyCount,0);assert.equal(turns[0].question.newText,'first\nsecond');
  assert.equal(getTurnReqCopyContent(turns[0],true),raw);
  assert.equal(getTurnResCopyContent(turns[0],true),' { "output" : [] } ');
  const stringInput=buildChatTimelineTurns(session,{1:{request_body:'{"input":"new question"}'}});
  assert.equal(stringInput[0].question.newText,'new question');
});
