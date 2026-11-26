// Guards the42→43 semantic barrier and transactional capture disposal; no raw-tail compatibility default.
import './guard.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {Db,SCHEMA_VERSION} from '../service/db.ts';
import {fixture,USER,holdMachine,testMachine} from './helpers.ts';
test('schema42 real-generated history migrates to43 with no capture authority invented',t=>{
 const f=fixture(t),path=join(f.dir,'v42.db'),old=new DatabaseSync(path);
 old.exec(readFileSync(new URL('./fixtures/ledger/schema-v42.sql',import.meta.url),'utf8'));
 old.prepare("INSERT INTO setting(id,created_at,key,value_json) VALUES('schema','2026-11-15','schema_version','42')").run();
 old.prepare("INSERT INTO project(id,created_at,name) VALUES('p','2026-11-15','old')").run();
 old.prepare("INSERT INTO task(id,created_at,project_id,title,goal,state,created_by) VALUES('t','2026-11-15','p','old task','goal','held','user')").run();
 old.prepare("INSERT INTO run(id,created_at,task_id,task_revision,host,state,marker,snapshot_json) VALUES('r','2026-11-15','t',1,'old','ended','run:r','{}')").run();
 old.prepare("INSERT INTO work_cleanup(id,created_at,project_id,project_name,run_id,task_id,releases_json) VALUES('cleanup42','2026-11-15','p','old','r','t','[]')").run();
 old.close();const db=new Db(path,false,{}, {log:()=>{}});
 try {
 assert.equal(SCHEMA_VERSION,47);assert.equal(db.get<{value_json:string}>("SELECT value_json FROM setting WHERE key='schema_version'")!.value_json,'47');
 const row=db.get<{capture_result_json:string|null;snapshot_json:string}>("SELECT * FROM run WHERE id='r'")!;
 assert.equal(row.capture_result_json,null);assert.equal(row.snapshot_json,'{}');assert.equal(db.get<{output_release_json:string|null}>("SELECT output_release_json FROM work_cleanup WHERE id='cleanup42'")!.output_release_json,null);
 } finally { db.close(); }
});
test('all new Runs persist capture mode and settlement disposal with the same commit',t=>{
 const f=fixture(t),{run}=f.runningRun();
 const spec=JSON.parse(run.snapshot_json).output_capture;assert.equal(spec.version,1);assert.match(spec.source,/^[a-f0-9]{64}$/);
 assert.equal(run.capture_result_json,null);
 const ref={version:1,source:spec.source,state:'ready',size:123,sha256:'a'.repeat(64)};
 f.ledger.settleRun(run.id,0,{status:'done',summary:'kept'},{sessionRef:'native-session',captureResult:{source:spec.source,ref,complete:true}} as any);
 const saved=f.run(run.id);assert.equal(saved.session_ref,'native-session');
 const proof=JSON.parse(saved.capture_result_json!);assert.equal(proof.source,spec.source);assert.equal(proof.disposition,'adopted');assert.equal(proof.ref.sha256,ref.sha256);
});
test('capture disposal rolls back together with failed original settlement transaction',t=>{
 let fail=true;const f=fixture(t,{testHooks:{afterSettleRunWrite:()=>{if(fail)throw new Error('capture commit interrupted');}}}),{run}=f.runningRun();
 const spec=JSON.parse(run.snapshot_json).output_capture;
 assert.throws(()=>f.ledger.settleRun(run.id,0,{status:'done',summary:'kept'},{captureResult:{source:spec.source,complete:true,ref:{version:1,source:spec.source,state:'ready',size:5,sha256:'a'.repeat(64)}}} as any),/capture commit interrupted/);
 assert.equal(f.run(run.id).capture_result_json,null);assert.equal(f.run(run.id).state,'running');fail=false;
});

test('normal project deletion retains the exact Node output release proof while offline',t=>{
 const f=fixture(t),{run}=f.runningRun(),spec=JSON.parse(run.snapshot_json).output_capture;
 f.ledger.settleRun(run.id,0,{status:'done',summary:'kept'},{captureResult:{source:spec.source,complete:true,ref:{version:1,source:spec.source,state:'ready',size:64,sha256:'c'.repeat(64)}}});
 assert.equal(f.ledger.outputRelease(run.id,spec.source,run.machine_id!,run.node_id!),true);
 f.ledger.setProjectArchived(f.projectId,true,USER);f.ledger.deleteProject(f.projectId,'试跑',USER);
 assert.equal(f.ledger.outputRelease(run.id,spec.source,run.machine_id!,run.node_id!),true,'explicit deletion custody survives missing Run');
 assert.equal(f.ledger.outputRelease(run.id,spec.source,run.machine_id!,'another-node'),false);
 assert.equal(f.ledger.outputRelease(run.id,'f'.repeat(64),run.machine_id!,run.node_id!),false);
});

test('same machine name and node id re-registered cannot inherit old output release rights',t=>{
 const f=fixture(t),{run}=f.runningRun(),spec=JSON.parse(run.snapshot_json).output_capture;
 f.ledger.settleRun(run.id,0,{status:'done',summary:'kept'},{captureResult:{source:spec.source,complete:true,ref:{version:1,source:spec.source,state:'ready',size:64,sha256:'e'.repeat(64)}}});
 assert.equal(f.ledger.outputRelease(run.id,spec.source,run.machine_id!,run.node_id!),true);
 f.ledger.deleteMachine(run.machine_id!,USER,{confirmed:true});holdMachine(f.ledger,testMachine(run.machine_id!,run.host,run.node_id!));
 assert.equal(f.ledger.outputRelease(run.id,spec.source,run.machine_id!,run.node_id!),false);
});

// A receipt is adopted only when it supplies the settlement, not merely because bytes sealed.
for (const mode of ['lost','no-exit','completed','failed-receipt'] as const) test('capture custody follows the actual '+mode+' settlement',t=>{
 const f=fixture(t),{run,task}=f.runningRun(),spec=JSON.parse(run.snapshot_json).output_capture;
 const receipt={status:mode==='failed-receipt'?'failed' as const:'done' as const,summary:'native result supplied this verdict',artifacts:[{kind:'commit' as const,ref:'c0ffee'},{kind:'report' as const,ref:'最后一条消息'}]};
 const captureResult={source:spec.source,complete:true,ref:{version:1 as const,source:spec.source,state:'ready' as const,size:123,sha256:'b'.repeat(64)}};
 f.ledger.settleRun(run.id,mode==='lost'||mode==='no-exit'?null:0,receipt,{captureResult,finalReply:'the formal reply',...(mode==='lost'?{kind:'lost' as const,lost:{basis:'seen' as const}}:{})});
 const saved=f.run(run.id),proof=JSON.parse(saved.capture_result_json!);
 assert.equal(saved.exit_kind,mode==='lost'?'lost':mode==='completed'?'completed':'failed');
 assert.equal(f.task(task.id).state,mode==='lost'?'queued':mode==='completed'?'ready':'held');
 if(mode==='lost'||mode==='no-exit'){
  assert.equal(f.ledger.runReport(run.id),undefined,'no formal report was adopted');
  assert.equal(proof.disposition,'not_adopted');assert.equal(proof.reason,JSON.parse(saved.error_json!).reason);
 }else{
  assert.equal(proof.disposition,'adopted','a real failed receipt is still an adopted result');
  if(mode==='completed')assert.equal(f.ledger.runReport(run.id)?.text,'the formal reply');
  else{assert.equal(f.ledger.runReport(run.id)?.text,'the formal reply');assert.equal(f.task(task.id).reason,receipt.summary);}
 }
 assert.equal(proof.complete,true);assert.equal(proof.ref.sha256,captureResult.ref.sha256);
 assert.equal(f.ledger.outputRelease(run.id,spec.source,run.machine_id!,run.node_id!),true);
 assert.equal(f.ledger.outputRelease(run.id,spec.source,run.machine_id!,'unrelated-node'),false);
 assert.equal(f.ledger.outputRelease(run.id,'f'.repeat(64),run.machine_id!,run.node_id!),false);
});
