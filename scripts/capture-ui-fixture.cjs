// Isolated synthetic UI fixture. Does not start Electron, Go, agents or system proxy.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StorageEngine } = require('../dist/main/storage');
const { CoreManager } = require('../dist/main/core');
const { CertManager } = require('../dist/main/cert');
const { ConfigManager } = require('../dist/main/config');
const { WebServer } = require('../dist/main/web');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-capture-ui-'));
  const storage = new StorageEngine(path.join(directory,'synthetic.db'));
  const core = new CoreManager(storage);
  const cert = new CertManager(path.join(directory, 'cert'));
  cert.ensureCertDir();
  const config = new ConfigManager(path.join(directory, 'config.json'), '', directory);
  const web = new WebServer(storage, cert, 0, undefined, 'synthetic-ui-fixture-only', config);
  let mode='normal';
  web.app.addHook('onRequest',async(req,reply)=>{
    if(req.url.startsWith('/api/sessions') && mode==='error') return reply.code(503).send({error:'synthetic UI failure'});
    if(req.url.startsWith('/api/sessions') && mode==='empty') return reply.send({sessions:[]});
  });
  web.app.get('/fixture/mode/:mode', async req => { mode=req.params.mode; return {mode}; });
  const add = (i,session='UI-thread',options={}) => {
    const isWS=i%3===0;
    const input=options.input ?? (i%4===0 ? [{type:'function_call_output',call_id:'fixture-call',output:'合成工具结果 '+i}] : '合成请求 '+i+'：# 中文😀\n **长标题与完整输入验证** '.repeat(20));
    const request=JSON.stringify({...(isWS?{type:'response.create'}:{}),model:'synthetic-model',input,
      previous_response_id:i>1?'UI-response-'+(i-1):null,
      client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:session,turn_id:'UI-turn-'+Math.ceil(i/4)})}});
    const response={type:'response.completed',response:{id:'UI-response-'+i,status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'合成回复 '+i+'。用于 UI 验证，未发出真实请求。'}]}],usage:{input_tokens:10,output_tokens:2,total_tokens:12}}};
    const payload=JSON.stringify(response);
    core.handleCapturePayload({event_id:'UI-event-'+session+i,request_id:'UI-request-'+session+i,request_headers:{'user-agent':'codex/fixture'},
      response_headers:{'content-type':isWS?'application/json':i%2===0?'text/event-stream':'application/json'},url_path:'/v1/responses',
      request_body:request,response_body:isWS?JSON.stringify({format:'ws-messages-v1',messages:[{direction:'client',sequence:i*2-1,payload:request},{direction:'server',sequence:i*2,payload}]}):i%2===0?'data: '+payload+'\n\n':payload,
      transport:isWS?'wss':'https',body_format:isWS?'ws-messages-v1':i%2===0?'sse':'json',address:(isWS?'wss':'https')+'://synthetic.invalid/v1/responses?credential=fixture-only',capture_status:'complete',status_code:isWS?101:200,duration_ms:25,...options.capture});
  };
  for(let i=1;i<=64;i++) add(i);
  add(100,'UI-other-thread');
  add(200,'UI-short-thread',{input:'短请求一'});
  add(201,'UI-short-thread',{input:'短请求二'});
  add(301,'UI-legacy-thread',{input:'合成旧记录',capture:{transport:'',body_format:'',address:'',body_encoding:''}});
  web.app.get('/fixture/append', async()=>{add(65);return {added:65};});
  await web.app.listen({port:0,host:'127.0.0.1'});
  console.log('UI_FIXTURE_URL http://127.0.0.1:'+web.app.server.address().port+'/?token=synthetic-ui-fixture-only');
  const close=async()=>{await web.app.close();storage.close();fs.rmSync(directory,{recursive:true,force:true});process.exit(0);};
  process.once('SIGINT',close);process.once('SIGTERM',close);
})().catch(error=>{console.error(error);process.exitCode=1;});
