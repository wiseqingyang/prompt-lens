// One-time maintenance; never imported by application startup. Build main first.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const {ContentStore} = require('../dist/main/content-store');
const {extractResponseInfo} = require('../dist/main/parser');
const {isExcludedBackgroundRequest} = require('../dist/shared/auditScope');
const fields = ['input_tokens','output_tokens','cached_tokens','thinking_tokens','total_tokens','cache_ratio','token_source'];
const usageOf = row => Object.fromEntries(fields.map(key => [key,row[key]]));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
// Compare only the snapshot rows we will change; unrelated live captures may continue.
const recordVersion = (db,id) => hash([db.prepare('SELECT * FROM records WHERE id=?').get(id),
  db.prepare('SELECT * FROM content_fields WHERE record_id=? ORDER BY field').all(id),
  db.prepare('SELECT * FROM usage_ledger WHERE id=? ORDER BY event_key').all(id)]);
const unavailable = () => ({input_tokens:0,output_tokens:0,cached_tokens:0,thinking_tokens:0,total_tokens:0,cache_ratio:0,token_source:'unavailable'});

function planRepair(db) {
  const store = new ContentStore(db), remove = [], updates = [], ledger = [];
  let unverifiableReportedLedger = 0;
  const rows = db.prepare(`SELECT id,event_id,method,address,url_path,provider,body_format,content_expired,
    ${fields.join(',')} FROM records ORDER BY id`).all();
  const read = (row,field) => store.read(row.id,field,db.prepare(`SELECT ${field} value FROM records WHERE id=?`).get(row.id).value);
  for (const row of rows) {
    let headers = {};
    if (!row.content_expired) {
      try { headers = JSON.parse(read(row,'request_headers')); } catch (error) {
        // Missing/invalid JSON is not identity evidence; damaged content storage still fails below.
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    if (isExcludedBackgroundRequest({...row,request_headers:headers})) {
      remove.push({id:row.id,event_id:row.event_id,original:recordVersion(db,row.id)});
      continue;
    }
    let usage;
    if (!row.content_expired) {
      const response = read(row,'response_body');
      if (response) usage = extractResponseInfo(row.provider,response,row.url_path,row.body_format).usage;
    }
    // Raw usage survives content expiry; use only declared protocol fields.
    if (!usage || usage.token_source !== 'reported') {
      const raw = read(row,'raw_usage');
      let reported;
      try { reported = JSON.parse(raw); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (reported) {
        const body = row.provider === 'gemini' ? {usageMetadata:reported} : {usage:reported};
        const parsed = extractResponseInfo(row.provider,JSON.stringify(body)).usage;
        if (parsed.token_source === 'reported') usage = parsed;
      }
    }
    if (!usage && row.token_source === 'estimated') usage = unavailable();
    if (!usage) continue;
    const next = usageOf(usage);
    if (JSON.stringify(usageOf(row)) !== JSON.stringify(next)) updates.push({id:row.id,before:usageOf(row),after:next,original:recordVersion(db,row.id)});
  }
  for (const row of db.prepare(`SELECT * FROM usage_ledger
      WHERE id NOT IN (SELECT id FROM records) ORDER BY event_key`).all()) {
    if (row.token_source === 'estimated') ledger.push({key:row.event_key,before:usageOf(row),original:hash(row)});
    else if (row.token_source === 'reported') unverifiableReportedLedger++;
  }
  return {remove,updates,ledger,unverifiableReportedLedger};
}

function summary(plan) {
  return {removedBackgroundRecords:plan.remove.length,correctedRecords:plan.updates.length,
    clearedEstimatedLedgerEntries:plan.ledger.length,unverifiableReportedLedgerEntries:plan.unverifiableReportedLedger};
}

function applyRepair(db, plan) {
  return db.transaction(() => {
    for (const item of [...plan.remove,...plan.updates]) {
      if (recordVersion(db,item.id) !== item.original) throw new Error('Target record changed since backup; no repair applied. Take a new backup and retry.');
    }
    for (const item of plan.ledger) {
      const row=db.prepare('SELECT * FROM usage_ledger WHERE event_key=?').get(item.key);
      if (hash(row) !== item.original || db.prepare('SELECT 1 FROM records WHERE id=?').get(row.id)) {
        throw new Error('Target ledger changed since backup; no repair applied. Take a new backup and retry.');
      }
    }
    const set = fields.map(key=>`${key}=@${key}`).join(',');
    const update = db.prepare(`UPDATE records SET ${set} WHERE id=@id`);
    const clear = db.prepare(`UPDATE usage_ledger SET ${set} WHERE event_key=@key`);
    for (const item of plan.updates) update.run({...item.after,id:item.id});
    for (const item of plan.ledger) clear.run({...unavailable(),key:item.key});
    for (const item of plan.remove) {
      // Existing triggers remove content references/attributions and preserve the event tombstone.
      db.prepare('DELETE FROM records WHERE id=?').run(item.id);
      db.prepare(`UPDATE usage_ledger SET counted=0,${set} WHERE id=@id`).run({...unavailable(),id:item.id});
    }
    return summary(plan);
  }).immediate();
}

async function repairFile(databasePath, backupPath) {
  if (!path.isAbsolute(databasePath) || !path.isAbsolute(backupPath) || databasePath === backupPath) throw new Error('Explicit distinct absolute database and backup paths required');
  const source = new Database(databasePath,{readonly:true,fileMustExist:true});
  source.pragma('query_only=ON');
  // Exclusive creation and private permissions protect the complete raw audit backup.
  try {
    const fd=fs.openSync(backupPath,'wx',0o600);fs.closeSync(fd);
    await source.backup(backupPath);
  } finally { source.close(); }
  const backup = new Database(backupPath,{readonly:true,fileMustExist:true});
  let plan;
  try {
    backup.pragma('query_only=ON');
    if (backup.pragma('integrity_check',{simple:true}) !== 'ok') throw new Error('Backup integrity check failed');
    plan=planRepair(backup);
  } finally { backup.close(); }
  const db = new Database(databasePath,{fileMustExist:true,timeout:5000});
  try { return {backup:backupPath,...applyRepair(db,plan)}; } finally { db.close(); }
}

module.exports={planRepair,applyRepair,repairFile,summary};
if (require.main === module) {
  (async()=>{
    const args=process.argv.slice(2), file=args[0];
    if (!file || !path.isAbsolute(file) || ![1,3].includes(args.length) || (args.length===3 && args[1]!=='--apply')) throw new Error('Usage: node scripts/repair-reported-usage.cjs /absolute/lens.db [--apply /absolute/new-backup.db]');
    if (args[1]==='--apply') console.log(JSON.stringify(await repairFile(file,args[2]),null,2));
    else {
      const db=new Database(file,{readonly:true,fileMustExist:true});
      try { db.pragma('query_only=ON');console.log(JSON.stringify({mode:'dry-run',...db.transaction(()=>summary(planRepair(db)))()},null,2)); }
      finally {db.close();}
    }
  })().catch(error=>{console.error(error.message);process.exitCode=1;});
}
