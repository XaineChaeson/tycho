import './guard.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture,USER,RUNNER_TUNED,memoryLogins} from './helpers.ts';
import {createRunner} from '../runner/runner.ts';
import {claudeAdapter} from '../adapters/claude.ts';
import {fakeRemote} from './fake-remote.ts';
test('public Runner flushes a sealed capture without final newline and history load stays isolated',async t=>{
 const f=fixture(t),{run}=f.runningRun(),spec=JSON.parse(run.snapshot_json).output_capture;
 f.ledger.settleRun(run.id,0,{status:'done',summary:'done'});
 const host=fakeRemote().connect(),bytes=Buffer.from(JSON.stringify({type:'result',is_error:false,result:'last event',session_id:'s'}));
 host.readCapture=async req=>({state:'range',source:spec.source,base:0,start:req.offset,end:bytes.length,committed_end:bytes.length,base64:bytes.subarray(req.offset,req.offset+req.bytes).toString('base64'),sealed:true});
 const runner=createRunner({...RUNNER_TUNED,ledger:f.ledger,adapters:{claude:claudeAdapter},logins:memoryLogins({[f.login.login.id]:f.login.login}),machines:{get:f.ledger.getMachine,list:f.ledger.listMachines},connect:()=>host});
 const before=f.dump();const events=await runner.loadEvents(f.run(run.id));assert.equal(events.length,1);assert.equal(events[0]!.kind,'turn.end');assert.deepEqual(f.dump(),before);assert.deepEqual(runner.events(run.id),[],'history fetch does not populate the live cache');
});
