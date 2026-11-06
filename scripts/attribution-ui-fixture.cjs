// Synthetic UI rehearsal only: isolated capture/native databases and a random loopback port.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { StorageEngine } = require('../dist/main/storage');
const { ConfigManager } = require('../dist/main/config');
const { WebServer } = require('../dist/main/web');
(async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lens-attribution-ui-'));
  const storage=new StorageEngine(path.join(root,'lens.db'));
  const config=new ConfigManager(path.join(root,'config.json'),'',root);
  const source=path.join(root,'.gemini/antigravity');
  const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222', T='33333333-3333-4333-8333-333333333333';
  let web;
  const close=async()=>{if(web) await web.app.close();storage.close();fs.rmSync(root,{recursive:true,force:true});};
  try {
    fs.mkdirSync(path.join(source,'conversations'),{recursive:true});
    const native=new Database(path.join(source,'conversations',A+'.db'));
    native.exec('CREATE TABLE trajectory_meta(cascade_id TEXT, trajectory_id TEXT)');
    native.prepare('INSERT INTO trajectory_meta VALUES (?,?)').run(A,T);native.close();
    const log=path.join(source,'brain',A,'.system_generated/logs');fs.mkdirSync(log,{recursive:true});
    fs.writeFileSync(path.join(log,'transcript.jsonl'),[0,1,2].map(i=>JSON.stringify({step_index:i,source:i===1?'SYSTEM':'USER_EXPLICIT',type:i===1?'TOOL_CALL':'USER_INPUT',content:'重复输入：检查项目',created_at:'2026-01-01T00:00:00Z'})).join('\n'));
    const body=(id,step)=>({requestId:`agent/${id}/123/${T}/${step+1}`,request:{sessionId:'shared-workspace',labels:{cascade_id:id,trajectory_id:T,last_step_index:String(step)},contents:[{role:'user',parts:[{text:'合成输入 '+step}]}]}});
    const insert=(request)=>storage.insertRecord({agent_name:'Antigravity',provider:'gemini',model:'synthetic-gemini',created_at:'2026-01-02 00:00:00',request_body:JSON.stringify(request),response_text:'合成回复，仅用于验证界面。',response_preview:'合成回复',response_body:JSON.stringify({candidates:[{content:{parts:[{text:'合成回复，仅用于验证界面。'}]}}]}),status_code:200,duration_ms:50,input_tokens:20,output_tokens:5,transport:'https',body_format:'json',url_path:'/v1internal:streamGenerateContent',address:'https://fixture.invalid/v1internal:streamGenerateContent'});
    insert(body(A,0));insert(body(A,1));insert(body(A,2));
    insert({request:{labels:{cascade_id:A}}});
    insert({...body(A,0),request:{labels:{cascade_id:B}}});
    insert({request:{sessionId:'shared-workspace'}});insert(body(B,0));
    web=new WebServer(storage,{getCertPaths:()=>({caCertPath:'',exists:false}),getStatus:()=>({state:'missing',message:'合成环境'})},0,undefined,'synthetic-attribution-ui',config);
    storage.startAttributionCollection(() => config.getConfig().attribution.antigravityDataDir);
    let mode='normal';
    web.app.addHook('onRequest',async(req,reply)=>{
      if(req.url.startsWith('/api/sessions') && mode==='error') return reply.code(503).send({error:'synthetic failure'});
      if(req.url.startsWith('/api/sessions') && mode==='empty') return reply.send({sessions:[],total:0});
    });
    web.app.post('/fixture/mode/:mode',async req=>{mode=req.params.mode;return{mode};});
    web.app.post('/fixture/remove-source',async()=>{fs.rmSync(source,{recursive:true,force:true});return{removed:true};});
    web.app.post('/fixture/append',async()=>({id:insert(body(A,2))}));
    await web.app.listen({port:0,host:'127.0.0.1'});
    console.log('UI_FIXTURE_URL http://127.0.0.1:'+web.app.server.address().port+'/?token=synthetic-attribution-ui');
    process.once('SIGINT',()=>close().then(()=>process.exit(0)));
    process.once('SIGTERM',()=>close().then(()=>process.exit(0)));
  } catch(error) {await close();throw error;}
})().catch(error=>{console.error(error);process.exitCode=1;});
