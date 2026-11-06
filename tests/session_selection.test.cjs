const test = require('node:test');
const assert = require('node:assert/strict');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

// Execute the actual renderer composable using Vite's TS/asset loader.
test('task selection ignores stale replies and owns its loading state', async (t) => {
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: false, root: require('node:path').resolve(__dirname, '..'), server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const originalWindow = global.window;
  try {
    const { useSessions } = await server.ssrLoadModule('/src/renderer/composables/useSessions.ts');
    const task = (id) => ({ id: `task-${id}`, turns: [{ record_id: id }] });
    await t.test('late A reply cannot override selected B', async () => {
      const a = deferred(), b = deferred();
      global.window = { electronAPI: { getRecordsByIds: ids => ids[0] === 1 ? a.promise : b.promise } };
      const state = useSessions();
      const first = state.selectTask(task(1));
      const second = state.selectTask(task(2));
      b.resolve([{ id: 2, raw_loaded: true }]);
      await second;
      a.resolve([{ id: 1, raw_loaded: true }]);
      await first;
      assert.equal(state.selectedTaskId.value, 'task-2');
      assert.equal(state.selectedId.value, 2);
      assert.equal(state.currentRecord.value.id, 2);
    });
    await t.test('A finishing first cannot dismiss B loading', async () => {
      const a = deferred(), b = deferred();
      global.window = { electronAPI: { getRecordsByIds: ids => ids[0] === 1 ? a.promise : b.promise } };
      const state = useSessions();
      const first = state.selectTask(task(1));
      const second = state.selectTask(task(2));
      a.resolve([{ id: 1, raw_loaded: true }]);
      await first;
      assert.equal(state.isLoadingSessionTurns.value, true);
      assert.equal(state.currentRecord.value, null);
      b.resolve([{ id: 2, raw_loaded: true }]);
      await second;
      assert.equal(state.isLoadingSessionTurns.value, false);
      assert.equal(state.currentRecord.value.id, 2);
    });
    await t.test('empty selection invalidates pending detail requests', async () => {
      const a = deferred();
      global.window = { electronAPI: { getRecordsByIds: () => a.promise } };
      const state = useSessions();
      const pending = state.selectTask(task(1));
      state.syncActiveSelection();
      a.resolve([{ id: 1, raw_loaded: true }]);
      await pending;
      assert.equal(state.selectedId.value, null);
      assert.equal(state.currentRecord.value, null);
      assert.equal(state.isLoadingSessionTurns.value, false);
    });
  } finally {
    global.window = originalWindow;
    await server.close();
  }
});

test('whole-session selection keeps late responses, selected request and appended requests consistent', async t => {
  const {createServer}=await import('vite');
  const server=await createServer({configFile:false,root:require('node:path').resolve(__dirname,'..'),server:{middlewareMode:true,watch:null},appType:'custom'});
  const originalWindow=global.window;
  t.after(async()=>{global.window=originalWindow;await server.close();});
  const {useSessions}=await server.ssrLoadModule('/src/renderer/composables/useSessions.ts');
  const group=(id,ids)=>({id,agent_name:'Codex',tasks:[{id:id+'-a',turns:ids.slice(0,1).map(record_id=>({record_id}))},{id:id+'-b',turns:ids.slice(1).map(record_id=>({record_id}))}]});
  const a=deferred(),b=deferred();
  const calls=[];
  global.window={electronAPI:{getRecordsByIds:(ids,options)=>{calls.push({ids,options});return ids[0]===1?a.promise:b.promise;},getRecordDetail:async id=>({id,raw_loaded:true,request_body:JSON.stringify({input:'question '+id})})}};
  const state=useSessions();
  const ga=group('a',[1,2,3]),gb=group('b',[4,5]);state.sessions.value=[ga,gb];
  const first=state.selectSession(ga),second=state.selectSession(gb);
  b.resolve([{id:4},{id:5}]);await second;a.resolve([{id:1},{id:2},{id:3}]);await first;
  assert.equal(state.currentRecord.value.id,4);assert.equal(state.currentSession.value.turns.length,2);
  assert.deepEqual(calls[0].ids,[1,2,3]);assert.equal(calls[0].options.includeRawBody,false);assert.equal(calls[0].options.lightweight,true);
  await state.selectRecord(5);assert.equal(state.currentRecord.value.id,5);
  state.sessions.value=[ga,group('b',[4,5,6])];
  global.window.electronAPI.getRecordsByIds=async ids=>ids.map(id=>({id}));
  await state.selectSession(state.sessions.value[1],false);
  assert.equal(state.selectedId.value,5);assert.deepEqual(state.currentSession.value.turns.map(t=>t.record_id),[4,5,6]);
  const slow=deferred();global.window.electronAPI.getRecordDetail=id=>id===1?slow.promise:Promise.resolve({id,raw_loaded:true});
  const pending=state.selectRecord(1);await state.selectRecord(6);slow.resolve({id:1,raw_loaded:true});await pending;
  assert.equal(state.currentRecord.value.id,6);
  const gc=group('large',Array.from({length:40},(_,i)=>100+i));
  state.sessions.value=[gc];
  const batches=[];
  global.window.electronAPI.getRecordsByIds=async ids=>{batches.push(ids);return ids.map(id=>({id,response_preview:'preview'}));};
  global.window.electronAPI.getRecordDetail=async id=>({id,request_body:'raw '+id,response_text:'reply',raw_loaded:true});
  await state.selectSession(gc);
  assert.equal(batches[0].length,30);
  await state.selectSession(gc,false);
  assert.equal(state.isLoadingSessionTurns.value,false);
  for(let id=101;id<110;id++) await state.selectRecord(id);
  assert.ok(Object.values(state.sessionTurnRecords.value).filter(r=>r.raw_loaded).length<=4);
  const metadata=deferred();
  global.window.electronAPI.getRecordsByIds=()=>metadata.promise;
  const lateMetadata=state.selectRecord(139,false);
  await state.selectRecord(139);
  metadata.resolve([{id:139,request_body:'',response_body:'',raw_loaded:false}]);
  await lateMetadata;
  assert.equal(state.currentRecord.value.request_body,'raw 139');
  assert.equal(state.currentRecord.value.raw_loaded,true);
});

test('verified sessions select only one turn and preserve turn/request selection through refresh', async t => {
  const {createServer}=await import('vite');
  const server=await createServer({configFile:false,root:require('node:path').resolve(__dirname,'..'),server:{middlewareMode:true,watch:null},appType:'custom'});
  const originalWindow=global.window;
  t.after(async()=>{global.window=originalWindow;await server.close();});
  const {useSessions}=await server.ssrLoadModule('/src/renderer/composables/useSessions.ts');
  const calls=[];
  global.window={electronAPI:{getRecordsByIds:async ids=>{calls.push(ids);return ids.map(id=>({id,raw_loaded:true}));}}};
  const turn=(id,ids,kind='turn')=>({id,kind,turns:ids.map((record_id,i)=>({record_id,turn_index:i+1}))});
  const a=turn('a',[1,2]), b=turn('b',[3,4]), unknown=turn('unknown',[5],'unassigned');
  const group={id:'session',attribution_mode:'verified',agent_name:'Antigravity',tasks:[a,b,unknown]};
  const state=useSessions();state.sessions.value=[group];
  await state.selectSession(group);
  assert.deepEqual(calls,[[1,2]]);assert.equal(state.selectedTaskId.value,'a');
  assert.deepEqual(state.currentSession.value.turns.map(r=>r.record_id),[1,2]);
  await state.selectTask(b);await state.selectRecord(4);
  const refreshed={...group,tasks:[a,turn('b',[3,4,6]),unknown]};state.sessions.value=[refreshed];
  await state.selectSession(refreshed,false);
  assert.equal(state.selectedTaskId.value,'b');assert.equal(state.selectedId.value,4);
  assert.deepEqual(state.currentSession.value.turns.map(r=>r.record_id),[3,4,6]);
  await state.selectTask(unknown);
  assert.deepEqual(state.currentSession.value.turns.map(r=>r.record_id),[5]);
  const removed={...group,tasks:[a]};state.sessions.value=[removed];await state.selectSession(removed,false);
  assert.equal(state.selectedTaskId.value,'a');assert.equal(state.selectedId.value,1);
  state.sessions.value=[];state.syncActiveSelection();assert.equal(state.currentSession.value,null);
});

test('verified request presentation never infers another user turn from message roles or list position', async t => {
  const {createServer}=await import('vite');
  const {default:vue}=await import('@vitejs/plugin-vue');
  const server=await createServer({configFile:false,root:require('node:path').resolve(__dirname,'..'),plugins:[vue()],server:{middlewareMode:true,watch:null,hmr:false},appType:'custom'});
  t.after(()=>server.close());
  const {buildChatTimelineTurns}=await server.ssrLoadModule('/src/renderer/utils/messageParser.ts');
  const Timeline=(await server.ssrLoadModule('/src/renderer/components/timeline/TimelineView.vue')).default;
  const {createSSRApp}=require('vue');
  const {renderToString}=require('@vue/server-renderer');
  const assignment={agentId:'antigravity',ruleVersion:'1',turn:{status:'resolved',value:{id:'turn-a'}}};
  const session={agent_name:'Antigravity',user_prompt:'native group title',turns:[
    {record_id:1,turn_index:1,assignment},
    {record_id:2,turn_index:2,assignment},
    {record_id:3,turn_index:3,summary:'3 msgs | Last: [Tool Result: run_command]',assignment}
  ]};
  const result=buildChatTimelineTurns(session,{
    1:{request_body:'{"request":{"contents":[{"role":"user","parts":[{"text":"model-facing text"}]}]}}'},
    3:{prompt_summary:'3 msgs | Last: [Tool Result: run_command]',content_expired:1}
  });
  assert.deepEqual(result.map(r=>r.question.title),['轮次内请求','轮次内请求','执行反馈注入']);
  assert.deepEqual(result.map(r=>r.question.roleLabel),['请求内容','请求内容','工具执行返回']);
  assert.equal(result[0].question.newText,'model-facing text');
  assert.equal(result[1].question.newText,'','group labels must not become fabricated request content');
  assert.equal(result[2].question.newText,'','legacy msgs summary must not leak into newText');
  assert.deepEqual(result[2].question.toolResults,[{name:'run_command',output:''}]);
  const html=await renderToString(createSSRApp(Timeline,{turns:result,isLoading:false}));
  assert.match(html,/工具执行返回: run_command/);
  assert.doesNotMatch(html,/3 msgs|Last:|发送摘要（完整内容按需加载）|本次发送内容/);
});

test('Agent sidebar discovers captures in Web and Electron without depending on search, page size or conversation count', async t => {
  const {createServer}=await import('vite');
  const server=await createServer({configFile:false,root:require('node:path').resolve(__dirname,'..'),server:{middlewareMode:true,watch:null,hmr:false,ws:false},appType:'custom'});
  const previous={window:global.window,fetch:global.fetch};
  t.after(async()=>{global.window=previous.window;global.fetch=previous.fetch;await server.close();});
  const {useSessions}=await server.ssrLoadModule('/src/renderer/composables/useSessions.ts');
  for(const mode of ['Web','Electron']) {
    let agents=[],groups=[],fail=false,statsFail=false;
    const getStats=async()=>{if(statsFail)throw new Error('synthetic stats unavailable');return {agents};};
    const getSessions=async()=>{if(fail)throw new Error('synthetic sessions unavailable');return {sessions:groups};};
    global.window=mode==='Electron'?{electronAPI:{getStats,getSessions,getRecordsByIds:async()=>[]}}:{};
    global.fetch=async url=>({ok:true,json:()=>url==='/api/stats'?getStats():getSessions()});
    const state=useSessions(),ids=()=>state.agentTabs.value.map(tab=>tab.id);
    assert.deepEqual(ids(),['Codex','Other'],mode+' before fetch');
    await state.fetchData();assert.deepEqual(ids(),['Codex','Other']);assert.equal(state.activeAgent.value,'Codex');
    // A global capture can be outside the first 500 sessions and have no reported usage.
    agents=['Pi Agent'];await state.fetchData();assert.deepEqual(ids(),['Codex','Pi','Other']);
    state.selectAgentTab('Pi');state.searchQuery.value='no matching session';
    await state.fetchData();assert.deepEqual(ids(),['Codex','Pi','Other']);assert.equal(state.activeAgent.value,'Pi');
    // Even an unassigned/auxiliary-only record reveals its Agent when stats are unavailable.
    statsFail=true;groups=[{id:'pending',kind:'pending',agent_name:'WorkBuddy',tasks:[],tasks_count:0}];
    await state.fetchData();assert.deepEqual(ids(),['Codex','Pi','WorkBuddy','Other']);
    assert.equal(state.agentTabs.value.find(tab=>tab.id==='WorkBuddy').count,0);
    fail=true;await state.fetchData();assert.ok(state.loadError.value);
    assert.deepEqual(ids(),['Codex','Pi','WorkBuddy','Other']);assert.equal(state.activeAgent.value,'Pi');
    fail=false;statsFail=false;groups=[];agents=['WorkBuddy','Antigravity','Pi Agent','WorkBuddy'];
    await state.fetchData();assert.deepEqual(ids(),['Codex','Antigravity','Pi','WorkBuddy','Other']);
    assert.equal(state.currentTabInfo.value.id,'Pi');
    agents=[];groups=[];
    await state.fetchData({resetDiscovery:true});
    assert.deepEqual(ids(),['Codex','Other']);
    assert.equal(state.activeAgent.value,'Codex');
  }
});
