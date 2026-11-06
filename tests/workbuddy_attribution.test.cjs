const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectAgent } = require('../dist/main/parser');
const { getAgentCategory } = require('../dist/shared/agent');
const headers = (session='session-a', turn='turn-a') => ({
  'user-agent':'WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0',
  'x-ide-name':'WorkBuddy', 'x-ide-type':'WorkBuddy', 'content-type':'application/json',
  'x-conversation-id':session, 'x-conversation-request-id':turn,
  'x-agent-type':'main', 'x-agent-purpose':'conversation'
});
test('WorkBuddy: client identity wins over provider fallback; host and text alone are not identity', () => {
  assert.equal(detectAgent(headers(), '/v2/chat/completions'), 'WorkBuddy');
  assert.equal(getAgentCategory('WorkBuddy'), 'WorkBuddy');
  assert.notEqual(detectAgent({host:'www.workbuddy.cn'}, '/v2/chat/completions', {messages:[{role:'user',content:'WorkBuddy/5.9.3'}]}), 'WorkBuddy');
  assert.notEqual(detectAgent({'user-agent':'CodeBuddy/5.9.3',host:'www.workbuddy.cn'}, '/v2/chat/completions'), 'WorkBuddy');
});

const { workbuddyAdapter: adapter } = require('../dist/main/attribution/adapters/workbuddy');
const { AdapterRegistry } = require('../dist/main/attribution/registry');
const { captureInput } = require('../dist/main/attribution/capture');
const { attributionView } = require('../dist/main/attribution/view');
const { extractResponseInfo } = require('../dist/main/parser');
const message = (turn='turn-a', text='相同的输入') => ({role:'user',startsNewUserRequest:true,conversationRequestId:turn,content:[{type:'text',text}]});
const capture = (h=headers(), body={messages:[message()]}, extra={}) => ({agentName:'WorkBuddy',headers:h,body,capturedAt:'2026-11-02T00:00:00Z',method:'POST',transport:'https',schemaVersion:'2.0.0',attribution:'request',...extra});
const decide = input => adapter.resolve({facts:adapter.extract(input),native:{status:'not_required'},capturedAt:input.capturedAt});

test('WorkBuddy: duplicate and conflicting client evidence is explicit; registry is unique', () => {
  for (const extra of [{'User-Agent':'pi/1'}, {'x-ide-name':'CodeBuddy'}, {'x-ide-type':'Cursor'}, {originator:'codex'}, {'x-codex-turn-metadata':'{}'}, {'user-agent':'WorkBuddy/5 Codex/1'}]) {
    assert.equal(detectAgent({...headers(),...extra}, '/v2/chat/completions'), 'Unknown');
    assert.equal(decide(capture({...headers(),...extra})).session.reason, 'agent_identity_unconfirmed');
  }
  assert.equal(detectAgent({'User-Agent':'WorkBuddy/99.0'}, '/v2/chat/completions'), 'WorkBuddy');
  assert.equal(new AdapterRegistry().select(capture()).adapter.id,'workbuddy');
  assert.equal(new AdapterRegistry([adapter,{...adapter,id:'duplicate-match'}]).select(capture()).status,'conflict');
  assert.equal(new AdapterRegistry().select(capture(headers(),{}, {agentName:'CodeBuddy'})).status,'unsupported');
});

test('WorkBuddy: only validated per-request headers identify sessions/turns, never body history or handshake', () => {
  const h=headers();delete h['x-conversation-id'];
  assert.equal(decide(capture(h,{conversation_id:'fake',messages:[message()]})).session.reason,'missing_session');
  for (const value of ['',null,[],3,'has space','line\nbreak','x'.repeat(257)]) assert.equal(decide(capture({...headers(),'x-conversation-id':value})).session.reason,'invalid_metadata');
  assert.equal(decide(capture({...headers(),'X-Conversation-ID':'session-b'})).session.status,'conflict');
  assert.equal(decide(capture({...headers(),'X-Conversation-ID':'session-a'})).session.value,'session-a');
  const conflict=decide(capture({...headers(),'X-Conversation-Request-ID':'turn-b'}));
  assert.equal(conflict.session.value,'session-a');assert.equal(conflict.turn.status,'conflict');
  assert.deepEqual(conflict.turn.candidates,[{id:'turn-a'},{id:'turn-b'}]);
  for (const transport of ['ws','wss','quic']) assert.equal(decide(capture(headers(),{}, {transport})).session.reason,'unknown_protocol');
  assert.equal(decide(capture(headers(),{}, {attribution:'connection'})).session.reason,'connection_only');
  assert.equal(decide(capture(headers(),{}, {contentExpired:true})).session.reason,'content_unavailable');
  assert.equal(decide(capture(headers(),{}, {schemaVersion:'99'})).session.reason,'unsupported_format');
  assert.equal(decide(capture(headers(),{}, {method:'GET'})).session.reason,'unsupported_format');
  const input=captureInput({agent_name:'WorkBuddy',request_headers:{...headers(),authorization:'secret','x-device-token':'private'},method:'POST',transport:'https',schema_version:'2.0.0'},'{broken');
  assert.equal(input.body,undefined);assert.equal(input.headers.authorization,undefined);assert.equal(input.headers['x-device-token'],undefined);
  assert.equal(decide(input).session.value,'session-a');assert.equal(decide(input).turn.value.title,undefined);
});

test('WorkBuddy: current explicit input titles exclude tool/history/context and duplicate candidates', () => {
  assert.equal(decide(capture()).turn.value.title,'相同的输入');
  const variants=[{...message(),role:'tool'},{...message(),startsNewUserRequest:false},message('old-turn'),{...message(),isMeta:true},{...message(),isAdditionalData:true}, {...message(),content:[{type:'image_url',image_url:{url:'synthetic'}}]}];
  for (const m of variants) assert.equal(decide(capture(headers(),{messages:[m]})).turn.value.title,undefined);
  assert.equal(decide(capture(headers(),{messages:[message(),message()]})).turn.value.title,undefined);
  assert.equal(decide(capture(headers(),{messages:[message('old-turn'),message('turn-a','新输入'),{role:'tool',content:'fake'}]})).turn.value.title,'新输入');
  assert.equal(Array.from(decide(capture(headers(),{messages:[message('turn-a','字'.repeat(400))]})).turn.value.title).length,256);
});

test('WorkBuddy: purpose needs exact headers, auxiliary and compaction continue without discarding native ID', () => {
  for(const [type,purpose,kind] of [['auxiliary','conversation_topic','conversation_title'],['auxiliary','webfetch','web_content_analysis'],['compaction','context_summary_max_token','context_compaction']]) {
    const d=decide(capture({...headers(),'x-agent-type':type,'x-agent-purpose':purpose}));
    assert.equal(d.purpose.kind,kind);assert.equal(d.turnBehavior,'continue');assert.equal(d.turn.value.id,'turn-a');assert.equal(d.turn.value.title,undefined);
  }
  for(const extra of [{'x-agent-purpose':'conversation_topic'},{'x-agent-type':'auxiliary','x-agent-purpose':'conversation_topic_extra'},{'x-agent-type':'auxiliary','x-agent-purpose':'webfetch','X-Agent-Purpose':'conversation_topic'}]) assert.equal(decide(capture({...headers(),...extra})).purpose,undefined);
  assert.equal(decide(capture(headers(),{messages:[{role:'system',content:'conversation_topic webfetch'}]})).purpose,undefined);
  assert.equal(decide(capture()).parentSessionId,undefined);
});

test('WorkBuddy: deterministic default/active turns, identical inputs, interleaving and late old turn', () => {
  const missing=headers();delete missing['x-conversation-request-id'];
  const inputs=[capture(missing),capture(),capture(headers(),{messages:[{role:'tool',content:'result'}]}),capture(headers('session-a','turn-b'),{messages:[message('turn-b')]}),capture(missing),capture(),capture(missing),capture({...headers('session-a','title-execution'),'x-agent-type':'auxiliary','x-agent-purpose':'conversation_topic'}),capture(headers('session-b','turn-a'))];
  const items=inputs.map((input,index)=>({record:{id:index+1,agent_name:'WorkBuddy',created_at:`2026-11-02T00:00:0${index}Z`,input_tokens:10,output_tokens:2,status_code:200},decision:decide(input)}));
  const result=attributionView(items);assert.deepEqual(attributionView([...items].reverse()),result);
  const a=result.find(x=>x.session_id==='session-a');
  assert.deepEqual(a.tasks.map(x=>x.turns.map(y=>y.record_id)),[[1],[2,3,6],[4,5,7,8]]);
  assert.equal(a.tasks[0].user_prompt,'未识别名称');assert.equal(a.total_input_tokens,80);
  assert.equal(result.find(x=>x.session_id==='session-b').turns_count,1);
  assert.equal(a.tasks[2].turns.at(-1).assignment.turn.value.id,'title-execution');
});

test('WorkBuddy Chat Completions: streamed text/reasoning/tools and cumulative reported usage, zero/missing', () => {
  const usage={prompt_tokens:100,completion_tokens:12,total_tokens:112,prompt_tokens_details:{cached_tokens:60},completion_tokens_details:{reasoning_tokens:4}};
  const chunks=[{choices:[{delta:{content:'回复',reasoning_content:'思考',tool_calls:[{index:0,id:'call-a',type:'function',function:{name:'read_file',arguments:'{"path":'}}]}}]}, {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"synthetic.txt"}'}}]},finish_reason:'tool_calls'}]}, {choices:[],usage},{choices:[],usage}];
  const sse=chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n';
  const parsed=extractResponseInfo('openai',sse,'/v2/chat/completions','sse');
  assert.equal(parsed.responseText,'回复');assert.equal(parsed.thinkingText,'思考');assert.equal(parsed.toolCalls[0].id,'call-a');assert.deepEqual(JSON.parse(parsed.toolCalls[0].args),{path:'synthetic.txt'});
  assert.equal(parsed.usage.input_tokens,100);assert.equal(parsed.usage.cached_tokens,60);assert.equal(parsed.usage.output_tokens,12);assert.equal(parsed.usage.thinking_tokens,4);assert.equal(parsed.usage.total_tokens,112);assert.equal(parsed.usage.token_source,'reported');
  assert.equal(extractResponseInfo('openai',JSON.stringify({choices:[],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}}),'/v2/chat/completions').usage.token_source,'reported');
  assert.equal(extractResponseInfo('openai',JSON.stringify({error:{message:'synthetic failure'}}),'/v2/chat/completions').usage.token_source,'unavailable');
});

const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const { StorageEngine } = require('../dist/main/storage');
function fixture(t,options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lens-workbuddy-'));let storage=new StorageEngine(path.join(root,'lens.db'),options);
  t.after(async()=>{await storage.stopAttributionCollection();await storage.stopMaintenance();storage.close();fs.rmSync(root,{recursive:true,force:true});});
  return {get storage(){return storage;},reopen(){storage.close();storage=new StorageEngine(path.join(root,'lens.db'),options);return storage;}};
}
function insert(storage,extra={}) {return storage.insertRecord({agent_name:'WorkBuddy',provider:'openai',model:'synthetic',schema_version:'2.0.0',transport:'https',attribution:'request',method:'POST',url_path:'/v2/chat/completions',status_code:200,capture_status:'complete',request_headers:headers(),request_body:JSON.stringify({messages:[message()]}),input_tokens:10,output_tokens:2,total_tokens:12,token_source:'reported',...extra});}

test('WorkBuddy: storage/index/filter/ledger, invalidation, expiry and reopen use the same evidence',async t=>{
  const f=fixture(t);let s=f.storage;const id=insert(s,{event_id:'evt-a'});assert.equal(insert(s,{event_id:'evt-a'}),id);
  assert.equal(s.getRecordById(id).session_id,'session-a');assert.equal(s.getRecordById(id).turn_id,'turn-a');
  assert.equal(s.getRecords({sessionId:'session-a',limit:-1}).length,1);
  assert.equal((await s.getAttributedSessions())[0].title,'相同的输入');
  const day=s.db.prepare("select date('now','localtime') d").get().d;
  assert.equal(s.getDailyTokenActivity('WorkBuddy').total_tokens,12);assert.equal(s.getDayModelUsage(day,'WorkBuddy')[0].total_tokens,12);assert.equal(s.getDayTokenDetails(day,'WorkBuddy').length,1);
  s.db.prepare('UPDATE records SET request_headers=? WHERE id=?').run(JSON.stringify(headers('session-b','turn-b')),id);
  assert.equal((await s.getAttributedSessions())[0].session_id,'session-b');assert.equal(s.getRecordById(id).turn_id,'turn-b');
  const raw=s.getRequestBody(id);s=f.reopen();assert.equal((await s.getAttributedSessions())[0].session_id,'session-b');assert.equal(s.getRequestBody(id),raw);
  s.db.prepare('UPDATE records SET content_expired=1 WHERE id=?').run(id);s=f.reopen();
  assert.equal(s.getRecordById(id).session_confidence,'unknown');assert.equal(s.getRecordById(id).turn_id,'');
  assert.equal((await s.getAttributedSessions())[0].kind,'pending');assert.equal(s.getDailyTokenActivity('WorkBuddy').total_tokens,12);
});

test('WorkBuddy: explicit historical refresh is idempotent, preserves raw data and usage, rolls back failure',async t=>{
  const f=fixture(t);let s=f.storage;const a=insert(s,{agent_name:'OpenAI Agent'}),b=insert(s,{agent_name:'OpenAI Agent'});
  s=f.reopen();assert.equal(s.getRecordById(a).agent_name,'OpenAI Agent','opening current schema never silently repairs real history');
  const before=s.db.prepare('SELECT id,request_headers,request_body,response_body,input_tokens,output_tokens,total_tokens FROM records ORDER BY id').all();
  s.db.exec(`CREATE TRIGGER fail_refresh BEFORE UPDATE ON records WHEN OLD.id=${b} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;`);
  assert.throws(()=>s.rebuildRecordIdentities(),/synthetic failure/);assert.equal(s.getRecordById(a).agent_name,'OpenAI Agent');
  s.db.exec('DROP TRIGGER fail_refresh');assert.equal(s.rebuildRecordIdentities().processed,2);
  assert.equal((await s.getAttributedSessions())[0].turns_count,2);assert.equal(s.getRecordById(a).agent_name,'WorkBuddy');
  assert.equal(s.getDailyTokenActivity('WorkBuddy').total_tokens,24);assert.equal(s.getDailyTokenActivity('Other').total_tokens,0);
  const sessions=await s.getAttributedSessions();s.rebuildRecordIdentities();assert.deepEqual(await s.getAttributedSessions(),sessions);
  assert.deepEqual(s.db.prepare('SELECT id,request_headers,request_body,response_body,input_tokens,output_tokens,total_tokens FROM records ORDER BY id').all(),before);
});

test('WorkBuddy: cold replay, restart, hot cache, single and batch ingestion preserve counts in background',async t=>{
  const f=fixture(t,{backgroundAttribution:true});const times={};let s=f.storage;
  for(let i=0;i<160;i++)insert(s,{request_headers:headers('session-'+Math.floor(i/20),'turn-'+Math.floor(i/5))});
  s.db.exec('DELETE FROM request_attributions');
  let ticks=0;const timer=setInterval(()=>ticks++,1);t.after(()=>clearInterval(timer));
  let start=performance.now();let sessions=await s.getAttributedSessions();assert.ok(ticks>0,'cold replay keeps the host event loop responsive');times.cold=performance.now()-start;assert.equal(sessions.reduce((n,x)=>n+x.turns_count,0),160);
  start=performance.now();assert.deepEqual(await s.getAttributedSessions(),sessions);times.hot=performance.now()-start;
  await s.stopAttributionCollection();s=f.reopen();start=performance.now();assert.deepEqual(await s.getAttributedSessions(),sessions);times.restart=performance.now()-start;
  insert(s);start=performance.now();sessions=await s.getAttributedSessions();times.incremental=performance.now()-start;assert.equal(sessions.reduce((n,x)=>n+x.turns_count,0),161);
  let reads=0;const original=s.getAttributionCapture.bind(s);s.getAttributionCapture=(...args)=>{reads++;return original(...args);};await s.getAttributedSessions();assert.equal(reads,0,'main thread must not decompress captures for background listing');
  for(let i=0;i<40;i++)insert(s,{request_headers:headers('batch-session','turn-'+i)});
  start=performance.now();sessions=await s.getAttributedSessions();times.batch=performance.now()-start;assert.equal(sessions.reduce((n,x)=>n+x.turns_count,0),201);
  t.diagnostic(JSON.stringify({records:201,ms:times}));
});

test('WorkBuddy: IPC access is explicitly allowed; malformed Agent commands remain rejected',()=>{
  const {assertIpcArguments}=require('../dist/main/desktop-security');
  assert.doesNotThrow(()=>assertIpcArguments('api:check-agent',[{agent:'workbuddy'}]));
  assert.doesNotThrow(()=>assertIpcArguments('api:launch-agent',[{agent:'workbuddy'}]));
  assert.throws(()=>assertIpcArguments('api:launch-agent',[{agent:'workbuddy; malicious'}]));
});

test('WorkBuddy: new rule version replays original captures; stale concurrent snapshots cannot commit',async t=>{
  const {AttributionRepository,digest}=require('../dist/main/attribution/repository');
  const {AttributionService}=require('../dist/main/attribution/service');
  const {storage:s}=fixture(t),id=insert(s),repo=new AttributionRepository(s.db);
  await s.getAttributedSessions();const old=repo.readAll([id])[0];
  const next={...adapter,version:'synthetic-next',resolve(snapshot){return {...adapter.resolve(snapshot),ruleVersion:'synthetic-next'};}};
  const service=new AttributionService(s,repo,new AdapterRegistry([next]));
  try{assert.equal((await service.sessions())[0].tasks[0].turns[0].assignment.ruleVersion,'synthetic-next');assert.ok(repo.readAll([id]).some(row=>row.version==='synthetic-next'));}finally{service.close();}
  const stale={...old,captureRevision:repo.revision()};
  s.db.prepare('UPDATE records SET request_headers=? WHERE id=?').run(JSON.stringify(headers('changed','changed-turn')),id);
  assert.equal(repo.saveBatch([stale]),false);
  assert.equal((await s.getAttributedSessions())[0].session_id,'changed');
  assert.notEqual(digest(JSON.stringify(s.getAttributionCapture(id))),old.captureDigest);
  s.db.prepare('DELETE FROM records WHERE id=?').run(id);assert.deepEqual(await s.getAttributedSessions(),[]);assert.equal(repo.readAll([id]).length,0);
});

test('WorkBuddy: wrapped user_query supplies the title and prompt, preserving user XML, context literals and raw capture', () => {
  const { extractUserPromptFromRecord } = require('../dist/main/session');
  const query = '检查 <widget>内容</widget>\n保留 `<system-reminder>示例</system-reminder>` 与 `<user_query>内嵌</user_query>`';
  const prefix = '<system-reminder data-role="user-context">预制规则</system-reminder>\n<system-reminder data-role="additional-data">文件含 <system-reminder data-role="user-context">字面量</system-reminder> 内容</system-reminder>\n';
  for (const content of [prefix+'<user_query>'+query+'</user_query>', [{type:'text',text:prefix},{type:'text',text:'<user_query>'+query+'</user_query>'}]]) {
    const body={messages:[{...message(),content}]}, raw=JSON.stringify(body);
    assert.equal(decide(capture(headers(),body)).turn.value.title,query.replace(/\s+/g,' '));
    assert.equal(extractUserPromptFromRecord({agent_name:'WorkBuddy',request_headers:headers(),request_body:raw,prompt_summary:'摘要'}),query);
    assert.equal(JSON.stringify(body),raw);
  }
  for (const text of [prefix, prefix+'<user_query></user_query>', prefix+'<user_query>截断', '<system-reminder data-role="user-context">未闭合', prefix+'未知边界<user_query>不猜</user_query>']) {
    const body={messages:[message('turn-a',text)]};
    assert.equal(decide(capture(headers(),body)).turn.value.title,undefined);
    assert.equal(extractUserPromptFromRecord({agent_name:'WorkBuddy',request_headers:headers(),request_body:JSON.stringify(body),prompt_summary:'摘要'}),'');
  }
});

test('WorkBuddy: ingestion and anatomy use the explicit query; other Agents and tool summaries are preserved', () => {
  const { CoreManager } = require('../dist/main/core');
  const { extractUserPromptFromRecord, dissectPromptAnatomy } = require('../dist/main/session');
  const text='<system-reminder data-role="user-context">预制模板</system-reminder>\n<system-reminder data-role="additional-data">环境</system-reminder>\n<user_query>真正的输入\n第二行</user_query>';
  const body={model:'synthetic',messages:[message('turn-a',text)]},raw=JSON.stringify(body),records=[];
  const core=new CoreManager({insertRecord:r=>{records.push(r);return records.length;}});
  core.handleCapturePayload({schema_version:'2.0.0',transport:'https',attribution:'request',method:'POST',url_path:'/v2/chat/completions',status_code:200,capture_status:'complete',request_headers:headers(),request_body:raw,response_body:JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})});
  const r=records[0];assert.equal(r.user_prompt,'真正的输入\n第二行');assert.equal(r.request_body,raw);assert.equal(r.total_tokens,12);
  assert.equal(dissectPromptAnatomy(r).user_prompt,'真正的输入\n第二行');
  assert.equal(dissectPromptAnatomy({...r,request_body:''}).user_prompt,'真正的输入\n第二行','pruned payload retains extracted user_prompt');
  assert.equal(dissectPromptAnatomy({...r,request_body:'',user_prompt:''}).user_prompt,'(未识别用户输入)');
  for(const h of [{...headers(),'x-agent-type':'auxiliary'},{...headers(),'X-Conversation-Request-ID':'conflict'},{...headers(),'x-ide-name':'CodeBuddy'}]) {
    assert.equal(extractUserPromptFromRecord({...r,request_headers:h}),'');
  }
  const other={agent_name:'OpenAI Agent',request_headers:{},request_body:JSON.stringify({messages:[{role:'user',content:'普通用户输入'}]})};
  assert.equal(extractUserPromptFromRecord(other),'普通用户输入');
  const missing={...r,request_body:JSON.stringify({messages:[message('old-turn','历史输入'),{role:'tool',content:'工具输出'}]})};
  assert.equal(extractUserPromptFromRecord(missing),'');
});

test('WorkBuddy: new capture summaries strip long envelopes, preserve Unicode, and leave other Agent/tool previews intact', () => {
  const {CoreManager}=require('../dist/main/core');
  const {workbuddyRequestSummary}=require('../dist/shared/workbuddyPrompt');
  const prefix='<system-reminder data-role="user-context">'+'template '.repeat(100)+'</system-reminder>\n';
  const text='真实输入\n'+'😀'.repeat(350),body={messages:[{...message(),content:[{type:'text',text:prefix},{type:'text',text:'<user_query>'+text+'</user_query>'}]}]};
  const raw=JSON.stringify(body),records=[];
  const core=new CoreManager({insertRecord:r=>{records.push(r);return records.length;}});
  const ingest=(h,b)=>core.handleCapturePayload({schema_version:'2.0.0',transport:'https',attribution:'request',method:'POST',url_path:'/v2/chat/completions',status_code:200,capture_status:'complete',request_headers:h,request_body:JSON.stringify(b),response_body:JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})});
  ingest(headers(),body);
  assert.equal(records[0].prompt_summary,'真实输入 '+'😀'.repeat(295));
  assert.equal(Array.from(records[0].prompt_summary).length,300);assert.equal(records[0].request_body,raw);assert.equal(records[0].total_tokens,12);
  assert.equal(workbuddyRequestSummary(headers(),body).text,records[0].prompt_summary);
  assert.equal(attributionView([{record:{id:1,...records[0]},decision:decide(capture(headers(),body))}])[0].tasks[0].turns[0].summary,records[0].prompt_summary);
  ingest({},body);assert.ok(records[1].prompt_summary.startsWith('<system-reminder'));assert.notEqual(records[1].agent_name,'WorkBuddy');
  const toolBody={messages:[...body.messages,{role:'tool',tool_call_id:'call-1',name:'read_file',content:'合成工具返回'}]};
  ingest(headers(),toolBody);ingest({},toolBody);
  assert.ok(records[2].prompt_summary);assert.ok(!records[2].prompt_summary.includes('真实输入'));
  assert.equal(records[2].prompt_summary,records[3].prompt_summary,'tool previews retain the existing parser behavior');
  for(const last of [{role:'tool',content:'工具结果'},{role:'assistant',content:'助手消息'},{...message('turn-a','注入'),startsNewUserRequest:false},message('old-turn','历史输入')]) {
    assert.equal(workbuddyRequestSummary(headers(),{messages:[...body.messages,last]}),undefined);
  }
});
