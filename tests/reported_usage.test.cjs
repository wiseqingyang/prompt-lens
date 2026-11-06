const test = require('node:test');
const assert = require('node:assert/strict');
const {extractResponseInfo, SchemaRegistry} = require('../dist/main/parser');
const {dissectPromptAnatomy} = require('../dist/main/session');
const parse = (provider, body) => extractResponseInfo(provider, JSON.stringify(body));

test('text, thoughts, tool arguments, unknown numeric keys and errors never generate tokens', () => {
  const cases = [
    ['openai', {choices:[{message:{content:'<think>reasoning</think>answer',reasoning_content:'long reasoning'}}]}],
    ['openai', {type:'response.reasoning_text.delta',delta:'reasoning'}],
    ['anthropic', {type:'content_block_delta',delta:{thinking:'reasoning'}}],
    ['unknown', {nested:{message:'answer',thinking:'reasoning',prompt_tokens:99,output_tokens:88}}],
    ['gemini', {error:{code:503,message:'The service is currently unavailable.',status:'UNAVAILABLE'}}],
    ['openai', {type:'response.completed',response:{output:[],usage:{}}}],
    ['openai', {usage:{input_tokens:'3',output_tokens:-1,total_tokens:1.5}}],
    ['openai', {usage:{description:'not usage evidence'}}]
  ];
  for (const [provider, body] of cases) {
    const result = parse(provider,body);
    assert.equal(result.usage.token_source,'unavailable',JSON.stringify(body));
    for (const field of ['input_tokens','output_tokens','thinking_tokens','total_tokens']) assert.equal(result.usage[field],0);
  }
  assert.equal(parse('gemini',cases[4][1]).responseText,'The service is currently unavailable.');
  assert.equal(parse('openai',cases[0][1]).thinkingText,'long reasoning\nreasoning');
  const anatomy = dissectPromptAnatomy({request_body:'{"input":"hello"}',input_tokens:123});
  assert.ok(anatomy.layers.every(layer => !Object.hasOwn(layer,'est_tokens')));
});

test('only declared protocol usage is counted, including explicit zeros and streamed snapshots', () => {
  for (const [provider, body] of [
    ['gemini',{usageMetadata:{promptTokenCount:0,candidatesTokenCount:0,totalTokenCount:0}}],
    ['anthropic',{type:'message_start',message:{usage:{input_tokens:0,output_tokens:0}}}],
    ['openai',{usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}}],
    ['openai',{object:'response',usage:{input_tokens:0,output_tokens:0,total_tokens:0}}]
  ]) {
    const result=parse(provider,body);
    assert.equal(result.usage.token_source,'reported');assert.equal(result.usage.total_tokens,0);
  }
  const frames=[
    {type:'response.reasoning_text.delta',delta:'a'.repeat(100)},
    {type:'response.completed',response:{usage:{input_tokens:12,output_tokens:8,total_tokens:20,output_tokens_details:{reasoning_tokens:3}}}},
    {type:'response.reasoning_text.delta',delta:'b'.repeat(100)}
  ];
  const http=extractResponseInfo('openai',frames.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join(''));
  const ws=extractResponseInfo('openai',JSON.stringify({format:'ws-messages-v1',messages:frames.map((frame,i)=>({direction:'server',sequence:i,payload:JSON.stringify(frame)}))}),'','ws-messages-v1');
  for (const result of [http,ws]) {
    assert.equal(result.usage.thinking_tokens,3);assert.equal(result.usage.total_tokens,20);
  }
  const registry=new SchemaRegistry('/nonexistent/synthetic-schemas.json');
  registry.register({id:'fixture',name:'Explicit custom mapping',provider:'unknown',usage:{input_tokens:'meter.in',output_tokens:'meter.out'}});
  const ctx=registry.extract([{meter:{in:5,out:0}}],'unknown');
  assert.equal(ctx.hasUsage,true);assert.equal(ctx.inTok,5);assert.equal(ctx.outTok,0);
  assert.equal(parse('openai',{usage:{input_tokens:5,output_tokens:2,total_tokens:0}}).usage.total_tokens,0,
    'explicit total zero must not be replaced by a locally derived sum');
});

test('background exclusion uses exact endpoint evidence; model failures remain capturable', () => {
  const {isExcludedBackgroundRequest} = require('../dist/shared/auditScope');
  const base={method:'GET',address:'https://daily-cloudcode-pa.googleapis.com/v1internal/cascadeNuxes?page_size=10'};
  assert.equal(isExcludedBackgroundRequest(base),true);
  assert.equal(isExcludedBackgroundRequest({method:'GET',url_path:'/v1internal/cascadeNuxes?x=1',request_headers:{Host:'daily-cloudcode-pa.googleapis.com:443'}}),true);
  for(const address of [
    'https://daily-cloudcode-pa.googleapis.com/v1internal/cascadeNuxes/',
    'https://daily-cloudcode-pa.googleapis.com/v1internal/cascadeNuxesExtra',
    'https://daily-cloudcode-pa.googleapis.com/v1internal/%63ascadeNuxes',
    'https://daily-cloudcode-pa.googleapis.com/x/../v1internal/cascadeNuxes',
    'https://cloudcode-pa.googleapis.com/v1internal/cascadeNuxes',
    'https://daily-cloudcode-pa.googleapis.com.example.com/v1internal/cascadeNuxes',
    'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent'
  ]) assert.equal(isExcludedBackgroundRequest({...base,address}),false,address);
  assert.equal(isExcludedBackgroundRequest({...base,method:'POST'}),false);
  assert.equal(isExcludedBackgroundRequest({...base,request_headers:{host:'other.example'}}),false);
  assert.equal(isExcludedBackgroundRequest({method:'GET',url_path:'/v1internal/cascadeNuxes'}),false);
});

test('renderer distinguishes unavailable from reported zero and removes anatomy token estimates',async t=>{
  const {createServer}=await import('vite'),vuePlugin=(await import('@vitejs/plugin-vue')).default;
  const server=await createServer({configFile:false,root:require('node:path').resolve(__dirname,'..'),plugins:[vuePlugin()],server:{middlewareMode:true,watch:null,hmr:false,ws:false},appType:'custom'});
  t.after(()=>server.close());
  const {createSSRApp}=require('vue'),{renderToString}=require('vue/server-renderer');
  const {buildChatTimelineTurns}=await server.ssrLoadModule('/src/renderer/utils/messageParser.ts');
  const {default:Timeline}=await server.ssrLoadModule('/src/renderer/components/timeline/TimelineView.vue');
  const {default:Anatomy}=await server.ssrLoadModule('/src/renderer/components/anatomy/AnatomyView.vue');
  for(const source of ['unavailable','reported']) {
    const record={id:1,model:'synthetic',token_source:source,input_tokens:0,output_tokens:0,cached_tokens:0,thinking_tokens:0,response_text:'synthetic answer',raw_loaded:true};
    const turns=buildChatTimelineTurns({turns:[{record_id:1,turn_index:1,token_source:source,input_tokens:99,output_tokens:99,cached_tokens:99,thinking_tokens:99}]},{1:record});
    for(const field of ['inputTokens','outputTokens','cachedTokens','thinkingTokens']) assert.equal(turns[0][field],0,'fresh zero must replace stale list totals');
    const html=await renderToString(createSSRApp(Timeline,{turns,isLoading:false}));
    assert.equal(html.includes('用量不可用'),source==='unavailable');
    const anatomy=dissectPromptAnatomy({request_body:'{"input":"synthetic user"}',input_tokens:0});
    const rendered=await renderToString(createSSRApp(Anatomy,{record:{...record,anatomy}}));
    assert.match(rendered,/字符占比/);assert.doesNotMatch(rendered,/~| tok| Tokens/);
  }
});
