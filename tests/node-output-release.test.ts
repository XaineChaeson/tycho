import './guard.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,USER,holdMachine,testMachine,memoryLogins} from './helpers.ts';
import {captureController} from '../node/capture.ts';
import {selectProcesses} from '../node/hostprocess.ts';
import {boxOf} from '../node/runbox.ts';
import {releasesFor} from '../service/node-output.ts';
for(const hasSnapshot of [false,true])test('public prepare then untouched rehost releases the old reservation: snapshot='+hasSnapshot,async t=>{
 const f=fixture(t),nodeDir=join(f.dir,'node');holdMachine(f.ledger,testMachine('h2'));
 const login={id:'move-account',name:'move-account',executor:'claude',tiers:f.login.login.tiers};memoryLogins({move:login},f.ledger);
 const task=f.ledger.createTask({projectId:f.projectId,title:'move',goal:'move',acceptance:'test',roleId:'implement',loginId:login.id},USER);f.ledger.queueTask(task.id,USER);const run=f.ledger.createRun(task.id,{...f.login,login},USER),spec=JSON.parse(run.snapshot_json).output_capture,dir=`tasks/${run.task_id}/runs/${run.id}`;
 const controller=captureController(nodeDir,run.node_id!,selectProcesses()),before=await controller.report();assert.equal((await controller.prepare(dir,spec)).state,'ready');
 if(hasSnapshot){const box=boxOf(nodeDir,dir);mkdirSync(join(box.runDir,'snapshot'),{recursive:true});writeFileSync(join(box.runDir,'snapshot','output.json'),JSON.stringify({executor:'claude',capture:spec}));}
 const moved=f.ledger.rehostRun(run.id,f.ledger.getMachine('h2')!);assert.notEqual(JSON.parse(moved.snapshot_json).output_capture.source,spec.source);
 if(hasSnapshot){f.ledger.settleRun(moved.id,null,null,{kind:'lost',lost:{basis:'not_started'}});f.ledger.setProjectArchived(f.projectId,true,USER);f.ledger.deleteProject(f.projectId,'试跑',USER);}
 const page=await controller.report(),releases=releasesFor(f.ledger,run.machine_id!,run.node_id!,page);assert.deepEqual(releases,[{kind:'capture',source:spec.source}]);
 for(const release of releases)await controller.release(release);
 const after=await controller.report();assert.equal(after.capacity.available_runs,before.capacity.available_runs,'never-started old source cannot occupy a slot forever');assert.equal(after.references.items.some(ref=>ref.source===spec.source),false);
 assert.equal(f.ledger.outputRelease(run.id,'0'.repeat(64),run.machine_id!,run.node_id!),false);
});
