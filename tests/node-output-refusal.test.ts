// A real Node command refusal must become visible uncertainty, never silent completion.
import './guard.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createNodes} from '../service/nodes.ts';
import {createNodeChannel} from '../runner/node-channel.ts';
import {createRunner} from '../runner/runner.ts';
import {ListingFailed,Unverifiable,Unreachable} from '../runner/host.ts';
import {claudeAdapter} from '../adapters/claude.ts';
import {unreachableSince,unverifiableReason} from '../service/ledger.ts';
import {consoleApp} from './console-helpers.ts';
import {fixture,memoryLogins,NODES_TUNED,RUNNER_TUNED} from './helpers.ts';

test('ordinary completed verify records actual wire read_result refusal as unknown',async t=>{
 const f=fixture(t),{task,run}=f.runningRun();
 const nodes=createNodes({...NODES_TUNED,ledger:f.ledger,pollHoldMs:()=>1,log:()=>{}});
 const channel=createNodeChannel({nodes}),machine=f.ledger.getMachine('h1')!;
 const facts={node_id:machine.nodeId!,name:'h1',hostname:'h1',platform:'test'};
 const runner=createRunner({...RUNNER_TUNED,ledger:f.ledger,adapters:{claude:claudeAdapter},logins:memoryLogins({own:f.login.login}),machines:{get:f.ledger.getMachine,list:f.ledger.listMachines},connect:()=>channel.for('h1')});
 const polled=nodes.poll('h1',{facts,runs:[]});
 const verifying=runner.verify(run).then(verdict=>({verdict}),error=>({error:String(error)}));
 const state=await polled;assert.equal(state?.kind,'state');
 nodes.report('h1',state!.id,true,{started:true,launcher_alive:false,pid_alive:false,marked:false,exit:0});
 const command=await nodes.poll('h1',{facts,runs:[],cursor:state!.id});assert.equal(command?.kind,'read_result');
 assert.equal(nodes.report('h1',command!.id,false,null,'QA result bytes unreadable'),true);
 const actual=await verifying;t.diagnostic(JSON.stringify(actual));assert.deepEqual(actual,{verdict:'unknown'});
 const saved=f.run(run.id);assert.equal(saved.state,'unknown');assert.equal(saved.exit_kind,null);assert.equal(saved.receipt_json,null);assert.equal(saved.capture_result_json,null);
 assert.equal(unreachableSince(saved),undefined);assert.match(unverifiableReason(saved)??'',/QA result bytes unreadable/);assert.match(f.task(task.id).reason??'',/QA result bytes unreadable/);assert.deepEqual(runner.lostCandidates(),[]);
 const owner=await consoleApp(t,{f,nodes}),response=await owner.get('/api/tasks/'+task.id),page=await response.json() as any;assert.equal(response.status,200);assert.match(page.task.reason,/QA result bytes unreadable/);assert.match(page.task.lost.unverifiable,/QA result bytes unreadable/);t.diagnostic(JSON.stringify({owner_reason:page.task.reason,owner_unverifiable:page.task.lost.unverifiable}));
});

test('ordinary programming exceptions from the transport remain errors',async t=>{
 const f=fixture(t),{run}=f.runningRun();
 const nodes=createNodes({...NODES_TUNED,ledger:f.ledger,log:()=>{}});t.mock.method(nodes,'send',async()=>{throw new TypeError('QA programming bug');});
 const channel=createNodeChannel({nodes});
 await assert.rejects(()=>channel.for('h1').readResult!({run_dir:`tasks/${run.task_id}/runs/${run.id}`,source:JSON.parse(run.snapshot_json).output_capture.source,offset:0,bytes:262144}),TypeError);
 assert.equal(f.run(run.id).state,'running');
});


for(const kind of ['read_capture','list'] as const)test(`${kind} actual wire refusal keeps its own error meaning`,async t=>{
 const f=fixture(t),{run}=f.runningRun(),machine=f.ledger.getMachine('h1')!;
 const nodes=createNodes({...NODES_TUNED,ledger:f.ledger,pollHoldMs:()=>1,log:()=>{}}),host=createNodeChannel({nodes}).for('h1');
 const poll=nodes.poll('h1',{facts:{node_id:machine.nodeId!,name:'h1',hostname:'h1',platform:'test'},runs:[]});
 const answer=kind==='read_capture'?host.readCapture!({run_dir:`tasks/${run.task_id}/runs/${run.id}`,source:JSON.parse(run.snapshot_json).output_capture.source,stream:'stdout',offset:0,bytes:262144}):host.list({aliveOnly:false});
 const rejected=assert.rejects(answer,kind==='read_capture'?Unverifiable:ListingFailed);
 const command=await poll;assert.equal(command?.kind,kind);nodes.report('h1',command!.id,false,null,'QA refused read');await rejected;
});

test('an actually disconnected hub still reports bounded reads as unreachable',async t=>{
 const f=fixture(t),nodes=createNodes({...NODES_TUNED,ledger:f.ledger,log:()=>{}}),host=createNodeChannel({nodes}).for('h1');
 await assert.rejects(()=>host.readResult!({run_dir:'tasks/t/runs/r',source:'a'.repeat(64),offset:0,bytes:262144}),Unreachable);
});
