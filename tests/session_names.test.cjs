const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexAdapter } = require('../dist/main/attribution/adapters/codex');
const { antigravityAdapter } = require('../dist/main/attribution/adapters/antigravity');
const { attributionView } = require('../dist/main/attribution/view');
const { StorageEngine } = require('../dist/main/storage');
const { AttributionRepository } = require('../dist/main/attribution/repository');
const userMessage = (text, turn='turn-a', kind='user.text') => ({type:'message',role:'user',
  content:[{type:'input_text',text}],internal_chat_message_metadata_passthrough:{turn_id:turn,content_item_kinds:[kind]}});
const input = (messages, extra={}) => ({agentName:'Codex',capturedAt:'2026-01-01T00:00:01Z',schemaVersion:'3.0.0',transport:'wss',attribution:'request',
  headers:{'user-agent':'Codex Desktop/0.162.0-alpha.17.2'},body:{type:'response.create',client_metadata:{thread_id:'thread-a',turn_id:'turn-a'},input:messages},...extra});
const resolve = capture => codexAdapter.resolve({facts:codexAdapter.extract(capture),native:{status:'not_required'},capturedAt:capture.capturedAt});
const item = (decision,id=1) => ({record:{id,created_at:`2026-01-01T00:00:0${id}Z`,agent_name:decision.agentId,model:'fixture',status_code:200},decision});

test('Codex names require current-turn user.text evidence and never use historical or injected user messages',()=>{
  const messages=[userMessage('旧轮用户问题','old-turn'),userMessage('工作区规则','turn-a','context.agents_md'),userMessage('修复滚动卡顿'),userMessage('追加指令')];
  const decision=resolve(input(messages));
  assert.equal(decision.turn.value.title,'修复滚动卡顿');
  for(const version of ['0.159.2','0.162.0-alpha.2','0.162.0-alpha.17.2']){
    assert.equal(resolve(input(messages,{headers:{'user-agent':'Codex Desktop/'+version}})).turn.value.title,'修复滚动卡顿');
  }
  assert.equal(resolve(input(messages,{transport:'https'})).turn.value.title,'修复滚动卡顿');
  const mixed=userMessage('用户文字');
  mixed.content.push({type:'input_text',text:'注入上下文'});
  mixed.internal_chat_message_metadata_passthrough.content_item_kinds.push('context.agents_md');
  assert.equal(resolve(input([mixed])).turn.value.title,'用户文字');
  const cases=[
    {...userMessage('无元数据'),internal_chat_message_metadata_passthrough:undefined},
    {...userMessage('无类型'),type:undefined},
    userMessage('旧轮','old-turn'),userMessage('上下文','turn-a','context.agents_md'),
    {...userMessage('错位'),content:[{type:'input_text',text:'错位'},{type:'input_image',image_url:'synthetic'}]},
    {...userMessage('工具'),type:'function_call_output'},
    {...userMessage('助手'),role:'assistant'},
    {...userMessage('损坏'),internal_chat_message_metadata_passthrough:{turn_id:'turn-a',content_item_kinds:'user.text'}},
    {...userMessage('图片'),content:[{type:'input_image',image_url:'synthetic'}]},
    {...userMessage('输出'),content:[{type:'output_text',text:'输出'}]},userMessage('   ')
  ];
  for(const message of cases){
    const result=resolve(input([message]));
    assert.equal(result.turn.value.id,'turn-a','missing title must not affect identity');
    assert.equal(result.turn.value.title,undefined);
  }
  assert.equal(Array.from(resolve(input([userMessage('😀'.repeat(500))])).turn.value.title).length,256);
  assert.equal(resolve(input([userMessage('过期')],{contentExpired:true})).turn.status,'unresolved');
});

test('verified Agents share prompt names and one unnamed placeholder without changing grouping',()=>{
  const codex=resolve(input([userMessage('修复滚动卡顿')]));
  const native={status:'available',sourceId:'fixture',trajectoryId:'trajectory-a',steps:[{index:0,source:'USER_EXPLICIT',type:'USER_INPUT',createdAt:'2026-01-01T00:00:00Z',input:'修复滚动卡顿'}]};
  const antigravity=antigravityAdapter.resolve({facts:{session:{status:'resolved',value:'thread-a',evidence:[]},fields:{},locator:{conversationId:'thread-a',trajectoryId:'trajectory-a',throughStep:0}},native,capturedAt:'2026-01-01T00:00:01Z'});
  for(const decision of [codex,antigravity]){
    const session=attributionView([item(decision)])[0];
    assert.equal(session.title,'修复滚动卡顿');assert.equal(session.tasks[0].user_prompt,session.title);
    assert.equal(session.turns_count,1);
    const empty=structuredClone(decision);delete empty.turn.value.title;
    const unnamed=attributionView([item(empty)])[0];
    assert.equal(unnamed.title,'未识别名称');assert.equal(unnamed.tasks[0].user_prompt,'未识别名称');
  }
  native.steps[0].input='';
  const emptyNative=antigravityAdapter.resolve({facts:{session:{status:'resolved',value:'thread-a',evidence:[]},fields:{},locator:{conversationId:'thread-a',trajectoryId:'trajectory-a',throughStep:0}},native,capturedAt:'2026-01-01T00:00:01Z'});
  assert.equal(attributionView([item(emptyNative)])[0].title,'未识别名称');
});

test('names fill missing text once, use the first named turn and remain stable across replay order',()=>{
  const unnamed=resolve(input([])),named=resolve(input([userMessage('最初有效输入')])),steer=resolve(input([userMessage('后续追加输入')]));
  const later=structuredClone(named);later.turn.value.id='turn-b';later.turn.value.title='另一个轮次';
  const records=[item(unnamed,1),item(named,2),item(steer,3),item(later,4)];
  const sessions=attributionView(records);
  assert.equal(sessions[0].title,'最初有效输入');
  assert.deepEqual(sessions[0].tasks.map(t=>t.user_prompt),['最初有效输入','另一个轮次']);
  assert.equal(sessions[0].turns_count,4);assert.deepEqual(attributionView(records.reverse()),sessions);
  const missing=structuredClone(unnamed);missing.turn.value.id='earlier-unnamed';
  assert.equal(attributionView([item(missing,1),item(later,2)])[0].title,'另一个轮次');
  const pending=resolve(input([],{body:{type:'response.create'}}));
  assert.equal(attributionView([item(pending)])[0].title,'其他请求');
  const noTurn=resolve(input([],{body:{type:'response.create',client_metadata:{thread_id:'thread-a'}}}));
  const initial=attributionView([item(noTurn)])[0].tasks[0];
  assert.equal(initial.user_prompt,'未识别名称');
  assert.equal(initial.kind,'turn');
});

test('Codex old projections rebuild names from captures, survive reopen and expire with source content',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lens-names-')),file=path.join(root,'lens.db');let storage=new StorageEngine(file);
  t.after(()=>{storage.close();fs.rmSync(root,{recursive:true,force:true});});
  const capture=input([userMessage('持久化名称')]);
  const id=storage.insertRecord({agent_name:'Codex',schema_version:capture.schemaVersion,transport:capture.transport,attribution:'request',request_headers:capture.headers,request_body:JSON.stringify(capture.body),status_code:200});
  const raw=storage.getRequestBody(id);
  const oldFacts=codexAdapter.extract(capture);oldFacts.codex.format='codex-capture-v1';delete oldFacts.codex.title;
  storage.db.prepare("UPDATE request_attributions SET rule_version='1', facts=?, decision=? WHERE record_id=?").run(
    JSON.stringify(oldFacts),
    JSON.stringify({agentId:'codex',ruleVersion:'1',session:{status:'resolved',value:'thread-a',evidence:[]},turn:{status:'resolved',value:{id:'turn-a'},evidence:[]}}),id);
  storage.close();storage=new StorageEngine(file);
  assert.equal((await storage.getAttributedSessions())[0].title,'持久化名称');assert.equal(storage.getRequestBody(id),raw);
  const row=new AttributionRepository(storage.db).readAll().find(r=>r.version===codexAdapter.version);
  assert.ok(JSON.stringify(row.facts).includes('content_item_kinds'),'title extraction keeps source evidence');
  storage.close();storage=new StorageEngine(file);
  assert.equal((await storage.getAttributedSessions())[0].tasks[0].user_prompt,'持久化名称');
  storage.clearRecords();assert.ok(!JSON.stringify(await storage.getAttributedSessions()).includes('持久化名称'));
});

test('renderer displays shared names directly and one placeholder without a turn-number prefix',async()=>{
  const {createServer}=await import('vite');
  const vuePlugin=(await import('@vitejs/plugin-vue')).default;
  const server=await createServer({configFile:false,root:path.resolve(__dirname,'..'),plugins:[vuePlugin()],server:{middlewareMode:true,watch:null,hmr:false},appType:'custom'});
  try{
    const {default:SessionList}=await server.ssrLoadModule('/src/renderer/components/session/SessionList.vue');
    const {shortTitle}=await server.ssrLoadModule('/src/renderer/utils/sessionNavigation.ts');
    assert.equal(shortTitle(''),'未识别名称');
    const {createSSRApp}=require('vue');const {renderToString}=require('vue/server-renderer');
    const group=attributionView([item(resolve(input([userMessage('修复滚动卡顿')])) )])[0];
    const html=await renderToString(createSSRApp(SessionList,{currentTabInfo:{label:'Codex',iconImg:''},sessions:[group],selectedSessionId:group.id,loadError:null}));
    assert.ok(html.includes('修复滚动卡顿'));assert.doesNotMatch(html,/轮次\s*1/);assert.doesNotMatch(html,/会话 thread/);
    const unnamed=attributionView([item(resolve(input([])))])[0];
    const emptyHtml=await renderToString(createSSRApp(SessionList,{currentTabInfo:{label:'Codex',iconImg:''},sessions:[unnamed],selectedSessionId:unnamed.id,loadError:null}));
    assert.ok(emptyHtml.includes('未识别名称'));assert.doesNotMatch(emptyHtml,/轮次\s*1/);
    const long=attributionView([item(resolve(input([userMessage('名'.repeat(100))])))])[0];
    const longHtml=await renderToString(createSSRApp(SessionList,{currentTabInfo:{label:'Codex',iconImg:''},sessions:[long],selectedSessionId:long.id,loadError:null}));
    assert.match(longHtml,/>名{32}…<\/span>/);assert.match(longHtml,/>名{44}…<\/div>/);
  }finally{await server.close();}
});
