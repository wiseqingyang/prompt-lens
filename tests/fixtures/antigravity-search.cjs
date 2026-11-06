// Synthetic protocol examples; no captured user data or live network resources.
const templates=require('./antigravity-purpose.json');
const SID='11111111-1111-4111-8111-111111111111',TRAJ='22222222-2222-4222-8222-222222222222';
function fixture(){
 const query='synthetic "资料" query',id='call_synthetic_search',text='合成资料😀 已核验。';
 const chunks=[{web:{title:'one.example',uri:'https://vertexaisearch.cloud.google.com/grounding-api-redirect/synthetic-one'}},{web:{title:'two.example',uri:'https://vertexaisearch.cloud.google.com/grounding-api-redirect/synthetic-two'}}];
 const result={response:{candidates:[{content:{role:'model',parts:[{text}]},finishReason:'STOP',groundingMetadata:{groundingChunks:chunks,groundingSupports:[{segment:{endIndex:Buffer.byteLength(text),text},groundingChunkIndices:[0,1]}]}}]}};
 const call={name:'search_web',id,args:{query}};
 const rendered=text+'[1][2]\n\nSources:\n'+chunks.map((g,i)=>`[${i+1}] [${g.web.title}](${g.web.uri})`).join('\n')+'\n\nNote: Source URLs are HTTP redirects; check where they resolve if you need the direct link.';
 const output=`Created At: 2026-01-01T00:00:01Z\nCompleted At: 2026-01-01T00:00:02Z\nThe search for "${query}" returned the following summary:\n${rendered}`;
 const main=(step,contents=[],sid=SID)=>({requestId:`agent/${sid}/1/${TRAJ}/${step+1}`,request:{labels:{cascade_id:sid,trajectory_id:TRAJ,last_step_index:String(step)},contents}});
 const history=[{role:'model',parts:[{functionCall:call}]},{role:'model',parts:[{functionResponse:{name:call.name,id,response:{output}}}]}];
 const native={format:'antigravity-jsonl-v1',sourceId:'synthetic-source',metadata:{cascade_id:SID,trajectory_id:TRAJ},transcript:[
  {step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',created_at:'2026-01-01T00:00:00Z',content:'合成搜索任务'},
  {step_index:1,source:'MODEL',type:'PLANNER_RESPONSE',created_at:'2026-01-01T00:00:01Z'},
  {step_index:2,source:'MODEL',type:'GENERIC',created_at:'2026-01-01T00:00:02Z'},
  {step_index:3,source:'USER_EXPLICIT',type:'USER_INPUT',created_at:'2026-01-01T00:00:03Z',content:'后续新轮次'}].map(x=>JSON.stringify(x)).join('\n')};
 return {query,id,text,result,call,rendered,output,history,main,native,
  search:{request:{systemInstruction:{parts:[{text:templates.web_search}]},contents:[{role:'user',parts:[{text:query}]}]}},
  origin:main(0),consumer:main(2,history),later:main(3,history),
  originResponse:'data: '+JSON.stringify({response:{candidates:[{content:{role:'model',parts:[{functionCall:call}]},finishReason:'STOP'}]}})+'\n\n'};
}
module.exports={fixture,SID,TRAJ};
