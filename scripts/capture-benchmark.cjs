// Synthetic capture measurements only. Every SQLite file lives in a temporary directory.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {StorageEngine}=require('../dist/main/storage');
const {CoreManager}=require('../dist/main/core');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lens-capture-benchmark-'));
const file=path.join(directory,'lens.db');
const storage=new StorageEngine(file),core=new CoreManager(storage);
const report={environment:{node:process.version,platform:process.platform,arch:process.arch},requests:100,sharedInputBytes:256*1024};
const bytes=()=>['','-wal','-shm'].reduce((n,suffix)=>n+(fs.existsSync(file+suffix)?fs.statSync(file+suffix).size:0),0);
try {
  const context=crypto.randomBytes(192*1024).toString('base64');
  const started=performance.now();const ids=[];
  for(let i=0;i<report.requests;i++) {
    const request=JSON.stringify({type:'response.create',model:'synthetic-model',input:context,previous_response_id:i?'response-'+(i-1):null});
    const response=JSON.stringify({type:'response.completed',response:{id:'response-'+i,output:[{type:'message',content:[{type:'output_text',text:'synthetic answer'}]}],usage:{input_tokens:10,output_tokens:2,total_tokens:12}}});
    ids.push(core.handleCapturePayload({event_id:'benchmark-'+i,request_id:'benchmark-'+i,request_headers:{'user-agent':'codex/fixture','x-codex-session-id':'benchmark'},url_path:'/v1/responses',capture_status:'complete',status_code:101,transport:'wss',body_format:'ws-messages-v1',request_body:request,response_body:JSON.stringify({format:'ws-messages-v1',messages:[{direction:'client',sequence:i*2,payload:request},{direction:'server',sequence:i*2+1,payload:response}]})}));
  }
  report.writeTotalMs=performance.now()-started;report.writeMeanMs=report.writeTotalMs/report.requests;
  report.sqliteBeforeBytes=bytes();const migration=performance.now();while(storage.migrateContentBatch(100)){}
  report.contentMigrationMs=performance.now()-migration;storage.db.pragma('wal_checkpoint(TRUNCATE)');storage.db.exec('VACUUM');storage.db.pragma('wal_checkpoint(TRUNCATE)');report.sqliteAfterBytes=bytes();
  const detail=performance.now();for(const id of ids)storage.getRecordById(id);report.detailMeanMs=(performance.now()-detail)/ids.length;
  const light=performance.now();storage.getRecordsByIds(ids,{lightweight:true});report.lightweight100Ms=performance.now()-light;
  const history=performance.now();const result=storage.getRelatedHistory(ids.at(-1));report.historyMs=performance.now()-history;report.historyRecords=result.records.length;report.historyStatus=result.status;
  report.totalTokens=storage.getStats().total_tokens;report.rssBytes=process.memoryUsage().rss;
  report.reusedReferences=storage.db.prepare('SELECT (SELECT COUNT(*) FROM content_refs) refs, (SELECT COUNT(*) FROM content_blocks) blocks').get();
  fs.mkdirSync(path.resolve(__dirname,'../.quality'),{recursive:true});fs.writeFileSync(path.resolve(__dirname,'../.quality/capture-benchmark.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {storage.close();fs.rmSync(directory,{recursive:true,force:true});}
