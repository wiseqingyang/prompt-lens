const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSSRApp } = require('vue');
const { renderToString } = require('@vue/server-renderer');

test('detail header hides absent communication fields and presents available metadata separately', async t => {
  const { createServer } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [vue()],
    server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom' });
  t.after(() => server.close());
  const Header = (await server.ssrLoadModule('/src/renderer/components/session/SessionDetailHeader.vue')).default;
  const session = { id: 'synthetic', agent_name: 'Codex', model: 'synthetic-model', turns_count: 1,
    total_duration_ms: 25, created_at: '2026-10-10T12:00:00Z', total_input_tokens: 10, total_output_tokens: 2 };
  const render = selectedRecord => renderToString(createSSRApp(Header, { session,
    turns: [{ record_id: 1, turn_index: 1, summary: '合成请求' }], selectedRecordId: 1, selectedRecord, activeTab: 'messages' }));
  const old = await render({ url_path: '/v1/responses' });
  assert.ok(!old.includes('protocol-badge') && !old.includes('payload-badge'));
  assert.ok(!old.includes('未知') && !old.includes('旧记录'));
  assert.match(old, /Responses API/);
  assert.match(old, /路径/);
  const empty = await render({});
  assert.ok(!empty.includes('communication-strip'));
  const complete = await render({ transport: 'wss', body_format: 'ws-messages-v1',
    address: 'wss://fixture.invalid/v1/responses?token=fixture-secret', url_path: '/v1/responses', body_encoding: 'UTF-8 WebSocket text payload' });
  assert.match(complete, /protocol-badge/);
  assert.match(complete, /payload-badge/);
  assert.match(complete, /api-name/);
  assert.match(complete, /address-value/);
  assert.match(complete, /WSS/);
  assert.match(complete, /JSON 消息/);
  assert.ok(!complete.includes('fixture-secret'));
  assert.ok(!complete.replace(/<[^>]*>/g, '').includes('UTF-8 WebSocket text payload'), 'encoding belongs in hover information');
});

test('session UI retains requests and usage without exposing attribution diagnostics', async t => {
  const {createServer}=await import('vite');const {default:vue}=await import('@vitejs/plugin-vue');
  const server=await createServer({configFile:false,root:path.resolve(__dirname,'..'),plugins:[vue()],server:{middlewareMode:true,watch:null,hmr:false},appType:'custom'});
  t.after(()=>server.close());
  const Header=(await server.ssrLoadModule('/src/renderer/components/session/SessionDetailHeader.vue')).default;
  const List=(await server.ssrLoadModule('/src/renderer/components/session/SessionList.vue')).default;
  const task={id:'task',kind:'unassigned',agent_name:'Antigravity',model:'fixture',user_prompt:'其他请求',turns_count:1,total_duration_ms:25,total_input_tokens:10,total_output_tokens:2,created_at:'2026-01-01',turns:[{record_id:1,turn_index:1,token_source:'reported',assignment:{agentId:'antigravity',ruleVersion:'internal-v1',session:{status:'resolved',value:'synthetic'},turn:{status:'unresolved',reason:'source_disabled',evidence:['private-proof']}}}]};
  const html=await renderToString(createSSRApp(Header,{session:task,turns:task.turns,selectedRecordId:1,activeTab:'messages'}));
  for(const text of ['归属依据','未配置原生日志目录','internal-v1','private-proof','当前轮次']) assert.ok(!html.includes(text),text+' must not appear');
  assert.match(html,/R1/);assert.match(html,/已报告用量/);assert.ok(!html.includes('用量不可用'));
  const confirmed={...task,kind:'turn',user_prompt:'用户输入',turns:[{...task.turns[0],summary:'3 msgs | Last: [Tool Result: run_command]',assignment:{...task.turns[0].assignment,turn:{status:'resolved',value:{id:'internal-turn'},evidence:['private-proof']}}}]};
  const confirmedHtml=await renderToString(createSSRApp(Header,{session:confirmed,turns:confirmed.turns,selectedRecordId:1,activeTab:'messages'}));
  assert.match(confirmedHtml,/用户输入/);
  assert.match(confirmedHtml,/R1 · 工具结果 run_command/);
  assert.doesNotMatch(confirmedHtml,/3 msgs|Last:/);
  for(const text of ['归属依据','internal-v1','private-proof','internal-turn']) assert.ok(!confirmedHtml.includes(text));
  const group={...task,id:'session',kind:'session',attribution_mode:'verified',title:'测试会话',tasks:[task],tasks_count:0};
  const renderList=group=>renderToString(createSSRApp(List,{currentTabInfo:{label:'Antigravity',iconImg:''},sessions:[group],selectedSessionId:group.id,selectedTaskId:task.id,loadError:null}));
  const single=await renderList(group);
  assert.ok(!single.includes('0 个轮次'));assert.ok(!single.includes('aria-label="会话轮次"'));
  assert.match(single,/1 次请求/);
  const mixed=await renderList({...group,tasks_count:1,tasks:[{...task,id:'turn',kind:'turn',user_prompt:'用户输入'},task]});
  assert.match(mixed,/>用户输入<\/span>/);assert.doesNotMatch(mixed,/轮次\s*1/);assert.match(mixed,/其他请求/);
});
