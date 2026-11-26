import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ulid } from '../service/ids.ts';
import { registrationDir } from '../service/releases.ts';
import { materialProject } from './project-handoff-helpers.ts';
import { create, output, WHY, OWNER, OWNER_SAYS, EVIDENCE } from './knowledge-helpers.ts';
import { USER, LOGIN } from './helpers.ts';
import { knowledgeTaskMaterial } from '../service/knowledge-brief.ts';
import { openLedger } from '../service/ledger.ts';
import { exportProjectHandoff, stageProjectHandoff, freezeProjectHandoff, importProjectHandoff } from '../service/project-home-transfer.ts';

// Seeds a legacy pre-refactor gating task on an awaiting_owner proposal so portable handoff
// of historical gate tasks (service/project-handoff-knowledge.ts) remains thoroughly tested.
function attachLegacyGate(dataDir: string, proposalId: string, writers: readonly string[]): string {
 const gateId = ulid();
 const at = new Date().toISOString();
 const db = new DatabaseSync(join(dataDir, 'ledger.db'));
 try {
  db.prepare(`INSERT INTO task (id, project_id, title, goal, acceptance, state, role_id, knowledge_json, revision, created_at, created_by)
   VALUES (?, NULL, ?, ?, ?, 'queued', 'analyse', ?, 1, ?, 'service')`).run(
   gateId,
   `把关提议 ${proposalId}`,
   '核验知识提议',
   '给出 knowledge_verdict',
   JSON.stringify({ kind: 'gate', proposal_id: proposalId, writers }),
   at,
  );
  db.prepare(`UPDATE knowledge_proposal SET state = 'gating', gate_task_id = ?, final_json = NULL, final_digest = NULL, owner_reasons_json = NULL WHERE id = ?`).run(gateId, proposalId);
 } finally {
  db.close();
 }
 return gateId;
}

async function prepared(t: Parameters<typeof materialProject>[0], origin: 'worker' | 'router' = 'worker', failedFirst = false) {
 const f=await materialProject(t); for(const ledger of [f.s,f.target,f.third])ledger.putRole({...ledger.getRole('analyse')!,permission:'read'},USER);
 const pinned=f.s.propose(create({title:'Pinned input',body:'pinned@1',project_ids:[f.p]}),OWNER_SAYS,OWNER);
 const pinnedId=f.s.listEntries().find(row=>row.proposal_id===pinned.id)!.id;
 const change=create({title:'Worker learned',body:'learned body',loading:'resident'});
 let call: string | undefined, message: string | undefined;
 if(origin==='router') {
  message=f.s.receiveMessage({channel:'console',externalId:'learning-trace',actor:'user',text:'Learn within P',projectId:f.p}).id;
  call='learning-call';f.s.startRouterCall({id:call,projectId:f.p,messageId:message,messageIds:[message],contextId:null,name:'propose_learning',request:'{}'});
 }
 const proposal=f.s.propose(change,origin==='worker'?{source:'worker',by:f.run.id,client:'run:'+f.run.id,writers:['codex'],taskId:f.task.id,runId:f.run.id}:{source:'router',by:'router',client:'router',writers:['codex'],projectId:f.p},{actor:origin,messageId:message,toolCallId:call});
 if(call) f.s.finishRouterCall(call,'returned',JSON.stringify(proposal));
 const gateId=attachLegacyGate(f.a,proposal.id,['codex']);
 const gate=f.s.getTask(gateId);
 const material=knowledgeTaskMaterial(f.s,{kind:'gate',proposal_id:proposal.id,writers:['codex']});
 if(failedFirst){
  const failed=f.s.createRun(gate.id,{...LOGIN,login:f.s.getAccount('account')!,machine:f.s.getMachine('h1')!,snapshot:{...LOGIN.snapshot,access:{permission:'read',layer:'tools',args:[]},knowledge:[],knowledge_task:{kind:material.kind,files:material.files}}},USER);
  f.s.markRunRunning(failed.id);f.s.settleRun(failed.id,1,null);if(f.s.getTask(gate.id).state==='held')f.s.resumeTask(gate.id,USER);
 }
 const run=f.s.createRun(gate.id,{...LOGIN,login:f.s.getAccount('account')!,machine:f.s.getMachine('h1')!,snapshot:{...LOGIN.snapshot,access:{permission:'read',layer:'tools',args:[]},knowledge:[],knowledge_task:{kind:material.kind,files:material.files}}},USER);
 f.s.markRunRunning(run.id);
 f.s.settleRun(run.id,0,{status:'done',summary:'gate accepted within P',artifacts:[{kind:'report',ref:'最后一条消息'}],knowledge_verdict:{result:'pass',reason:'only P',change:{inputs:[{knowledge_id:pinnedId,revision:1,disposition:'keep',note:'retained'}],outputs:[output({title:'Worker learned',body:'learned body',project_ids:[f.p]})]}}},{finalReply:'gate formal report',codeCheck:{result:'no-code'}});
 assert.equal(f.s.getTask(gate.id).state,'done');
 f.s.propose({inputs:[{knowledge_id:pinnedId,revision:1,disposition:'revise'}],outputs:[output({revises:pinnedId,title:'Pinned input',body:'pinned@2',project_ids:[f.p]})],why:WHY,evidence:EVIDENCE},OWNER_SAYS,OWNER);
 return {...f,pinnedId,proposal: f.s.getProposal(proposal.id),gate:f.s.getTask(gate.id),gateRun:f.s.getRun(run.id)};
}

test('ended Worker gate and exact frozen materials travel with P without rewriting global proposal scope',async t=>{
 const f=await prepared(t);assert.ok(f.gateRun.capture_result_json,'public gate settlement holds source custody');f.ready();const bytes=exportProjectHandoff(f.a,f.p),wire=JSON.parse(bytes.toString());
 assert.ok(wire.rows.run.every((row:any)=>row.capture_result_json===null),'all appended gate histories discard source release authority');assert.ok(wire.rows.change.every((row:any)=>row.action!=='run.capture_release'));
 assert.ok(wire.rows.task.some((r:any)=>r.id===f.gate.id&&r.project_id===null));
 assert.ok(wire.roles.some((r:any)=>r.id==='analyse'));
 const staged=stageProjectHandoff(f.b,bytes,f.ah.identity),receipt=freezeProjectHandoff(f.a,bytes,staged.id);
 importProjectHandoff(f.b,bytes,receipt);importProjectHandoff(f.b,bytes,receipt);
 const target=openLedger(join(f.b,'ledger.db'),{projectHome:f.bh});try{
  assert.deepEqual(target.getProposal(f.proposal.id),f.proposal);
  assert.equal(target.getEntry(f.pinnedId)?.revision,2);
  assert.equal(target.revisionsOf(f.pinnedId).find(r=>r.revision===1)?.body,'pinned@1');
  assert.equal(target.getTask(f.gate.id).project_id,null);
  assert.equal(readFileSync(join(registrationDir(f.b,f.run.id,f.registered.registration),f.file.name)).equals(f.binary),true);
  assert.ok(f.gateRun.snapshot_json.includes(f.pinnedId+'@1'));
  assert.deepEqual(f.proposal.change.outputs[0].project_ids,null);
  assert.deepEqual(f.proposal.final?.outputs[0].project_ids,[f.p]);
  assert.equal(target.getRun(f.gateRun.id).snapshot_json,f.gateRun.snapshot_json);
  assert.equal(target.getRun(f.gateRun.id).receipt_json,f.gateRun.receipt_json);
  assert.equal(target.runReport(f.gateRun.id)?.text,'gate formal report');
  assert.throws(()=>target.resumeTask(f.gate.id,USER));
  assert.throws(()=>target.runReport(f.gateRun.id,f.p),/不属于/);
  assert.throws(()=>target.updateTask(f.gate.id,{goal:'rewrite'},USER));
 }finally{target.close();}
});


test('stage rejects forged auxiliary tasks, wrong provenance, in-flight gates and unauthorized frozen material',async t=>{
 const f=await prepared(t);f.ready();const bytes=exportProjectHandoff(f.a,f.p),original=JSON.parse(bytes.toString());
 const proposal=(v:any)=>v.rows.knowledge_proposal.find((r:any)=>r.id===f.proposal.id);
 const task=(v:any)=>v.rows.task.find((r:any)=>r.id===f.gate.id);
 const run=(v:any)=>v.rows.run.find((r:any)=>r.id===f.gateRun.id);
 const snapshot=(v:any,edit:(s:any)=>void)=>{const r=run(v),s=JSON.parse(r.snapshot_json);edit(s);r.snapshot_json=JSON.stringify(s);};
 const cases:[string,(v:any)=>void][]=[
  ['unrelated null task',v=>v.rows.task.push({...task(v),id:'unrelated-null'})],
  ['wrong job proposal',v=>task(v).knowledge_json=JSON.stringify({kind:'gate',proposal_id:'other',writers:[]})],
  ['wrong verdict run',v=>{const r=proposal(v),g=JSON.parse(r.gate_json);g.run_id=f.run.id;r.gate_json=JSON.stringify(g);}],
  ['worker wrong task',v=>proposal(v).task_id=f.review.id],
  ['worker absent run',v=>proposal(v).run_id=null],
  ['router no causal call',v=>proposal(v).source='router'],
  ['unsupported MCP',v=>proposal(v).source='mcp'],
  ['gate ready',v=>task(v).state='ready'],
  ['gate queued',v=>task(v).state='queued'],
  ['proposal pending',v=>proposal(v).state='awaiting_owner'],
  ['run active',v=>run(v).state='running'],
  ['gate parent',v=>task(v).parent_id=f.task.id],
  ['ordinary run claims gate material',v=>{v.rows.run.find((r:any)=>r.id===f.run.id).snapshot_json=run(v).snapshot_json;}],
  ['missing gate material',v=>snapshot(v,s=>delete s.knowledge_task)],
  ['null material',v=>snapshot(v,s=>s.knowledge_task=null)],
  ['false material',v=>snapshot(v,s=>s.knowledge_task=false)],
  ['unknown material',v=>snapshot(v,s=>s.knowledge_task.files.push({path:'knowledge-task/unknown.json',text:'{}'}))],
  ['missing proposal material',v=>snapshot(v,s=>s.knowledge_task.files=s.knowledge_task.files.filter((r:any)=>!r.path.endsWith('proposal.json')))],
  ['unlicensed related knowledge',v=>snapshot(v,s=>s.knowledge_task.files.push({path:'knowledge-task/entries/01M7FKPRX92QQ1DNYP1KKVNN81@1.md',text:'opaque foreign text'}))],
  ['historical Q',v=>v.rows.knowledge_revision[0].projects_json='["Q"]'],
  ['global current',v=>{const r=v.rows.knowledge_revision.find((r:any)=>r.proposal_id===f.proposal.id);r.projects_json='null';}],
  ['missing source task',v=>v.rows.task=v.rows.task.filter((r:any)=>r.id!==f.task.id)],
  ['missing gate run',v=>v.rows.run=v.rows.run.filter((r:any)=>r.id!==f.gateRun.id)],
 ];
 for(const [name,mutate] of cases){const v=structuredClone(original);mutate(v);assert.throws(()=>stageProjectHandoff(f.b,Buffer.from(JSON.stringify(v)),f.ah.identity),Error,name);assert.equal(f.bh.describe(f.p).phase,'unknown',name);}
});

test('a source gate with no active Run is still refused while pending',async t=>{
 const f=await materialProject(t);for(const ledger of [f.s,f.target,f.third])ledger.putRole({...ledger.getRole('analyse')!,permission:'read'},USER);
 const proposal=f.s.propose({inputs:[],outputs:[output({title:'pending P',project_ids:[f.p]}),output({key:'out-2',title:'global resident',project_ids:null,loading:'resident'})],why:WHY,evidence:EVIDENCE},{source:'worker',by:f.run.id,client:'run:'+f.run.id,writers:['codex'],taskId:f.task.id,runId:f.run.id},USER);
 attachLegacyGate(f.a,proposal.id,['codex']);
 f.ready();assert.throws(()=>exportProjectHandoff(f.a,f.p),new RegExp(proposal.id));assert.equal(f.ah.describe(f.p,{service_id:f.ah.identity.id,generation:1}).phase,'owned');
});

test('Console amendment retains its abandoned zero-Run Worker gate predecessor without inventing a verdict',async t=>{
 const f=await materialProject(t,true);for(const ledger of [f.s,f.target,f.third])ledger.putRole({...ledger.getRole('analyse')!,permission:'read'},USER);
 const previous=f.s.propose({inputs:[],outputs:[output({title:'worker before amendment',project_ids:[f.p]}),output({key:'out-2',title:'global resident',project_ids:null,loading:'resident'})],why:WHY,evidence:EVIDENCE},{source:'worker',by:f.run.id,client:'run:'+f.run.id,writers:['codex'],taskId:f.task.id,runId:f.run.id},USER);
 const gate=attachLegacyGate(f.a,previous.id,['codex']);
 const amended=f.s.amendProposal(previous.id,{outputs:[output({title:'Owner amendment',project_ids:[f.p]})]},OWNER);
 assert.equal(f.s.getProposal(amended).source,'console');assert.equal(f.s.getProposal(amended).gate_task_id,null);
 assert.equal(f.s.getTask(gate).state,'abandoned');const before=f.s.getProposal(previous.id);assert.equal(before.gate,null);
 const history=f.s.revisionsOf(f.kid);f.ready();const bytes=exportProjectHandoff(f.a,f.p);const staged=stageProjectHandoff(f.b,bytes,f.ah.identity);importProjectHandoff(f.b,bytes,freezeProjectHandoff(f.a,bytes,staged.id));
 const target=openLedger(join(f.b,'ledger.db'),{projectHome:f.bh});try{assert.deepEqual(target.getProposal(previous.id),before);assert.equal(target.getTask(gate).state,'abandoned');assert.deepEqual(target.revisionsOf(f.kid),history);assert.equal(history[0].project_ids,null);assert.deepEqual(target.getEntry(f.kid)?.project_ids,[f.p]);}finally{target.close();}
});


test('all ended gate Runs including a failed reportless attempt travel as original history',async t=>{
 const f=await prepared(t,'worker',true),before=f.s.listRuns(f.gate.id);assert.equal(before.length,2);f.ready();const bytes=exportProjectHandoff(f.a,f.p),staged=stageProjectHandoff(f.b,bytes,f.ah.identity);importProjectHandoff(f.b,bytes,freezeProjectHandoff(f.a,bytes,staged.id));
 const target=openLedger(join(f.b,'ledger.db'),{projectHome:f.bh});try{assert.deepEqual(target.listRuns(f.gate.id).map(row=>({...row})),before.map(row=>({...row,capture_result_json:null})));assert.ok(before.every(row=>row.capture_result_json!==null),'source disposal stays only on the source');}finally{target.close();}
});

test('Router source requires its persistent knowledge.propose call lineage and keeps that lineage',async t=>{
 const f=await prepared(t,'router');f.ready();const bytes=exportProjectHandoff(f.a,f.p),v=JSON.parse(bytes.toString()),proposal=v.rows.knowledge_proposal.find((r:any)=>r.id===f.proposal.id);
 const causal=v.rows.change.find((r:any)=>r.action==='knowledge.propose'&&JSON.parse(r.detail_json).proposal_id===proposal.id);assert.equal(causal.tool_call_id,'learning-call');
 for(const mutate of [(v:any)=>v.rows.change=v.rows.change.filter((r:any)=>r.id!==causal.id),(v:any)=>v.rows.router_call[0].project_id='Q']){const bad=structuredClone(v);mutate(bad);assert.throws(()=>stageProjectHandoff(f.b,Buffer.from(JSON.stringify(bad)),f.ah.identity));assert.equal(f.bh.describe(f.p).phase,'unknown');}
 const staged=stageProjectHandoff(f.b,bytes,f.ah.identity);importProjectHandoff(f.b,bytes,freezeProjectHandoff(f.a,bytes,staged.id));
 const target=openLedger(join(f.b,'ledger.db'),{projectHome:f.bh});try{assert.deepEqual(target.getProposal(f.proposal.id),f.proposal);assert.ok(target.routerCall(f.p,'learning-call')?.committed.some(c=>c.action==='knowledge.propose'));}finally{target.close();}
});


test('stage rejects Console provenance carrying an existing Worker gate even when frozen source agrees', async t => {
 const f = await prepared(t);
 f.ready();
 const wire = JSON.parse(exportProjectHandoff(f.a, f.p).toString());
 const proposal = wire.rows.knowledge_proposal.find((row: any) => row.id === f.proposal.id);
 assert.equal(proposal.gate_task_id, f.gate.id);
 proposal.source = 'console';
 const run = wire.rows.run.find((row: any) => row.id === f.gateRun.id);
 const snapshot = JSON.parse(run.snapshot_json);
 const material = snapshot.knowledge_task.files.find((file: any) => file.path === 'knowledge-task/proposal.json');
 const frozen = JSON.parse(material.text);
 frozen.source = 'console';
 material.text = JSON.stringify(frozen);
 run.snapshot_json = JSON.stringify(snapshot);
 assert.throws(() => stageProjectHandoff(f.b, Buffer.from(JSON.stringify(wire)), f.ah.identity), /Console.*gate/, 'Console proposals must not authorize a gate');
 assert.equal(f.bh.describe(f.p).phase, 'unknown');
});
