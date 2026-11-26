import {Unverifiable} from '../runner/host.ts';
// Public Runner and actual typed missing response, not a legacy output substitute.
import './guard.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRunner} from '../runner/runner.ts';
import type {RemoteHost} from '../runner/host.ts';
import {claudeAdapter} from '../adapters/claude.ts';
import {fixture,RUNNER_TUNED,memoryLogins} from './helpers.ts';
for(const mode of ['lost','never-started','formal-missing','lost-refused','formal-refused','lost-unavailable','formal-unavailable','lost-defect'] as const)test('a typed missing capture preserves the public '+mode+' verdict',async t=>{
 const f=fixture(t),{run,task}=f.runningRun();let reads=0;
 const host:RemoteHost={place:async()=>[],start:async()=>({code:0,stdout:'',stderr:''}),stop:async()=>{},list:async()=>[],artifacts:async()=>[],dropRun:async()=>{},connected:()=>true,
 state:async()=>({started:true,launcher_alive:false,pid_alive:false,marked:false,exit:mode.startsWith('lost')?null:mode==='never-started'?127:0,unknown:null,...(mode==='never-started'?{not_started:'synthetic executable missing'}:{})}),
 readRange:async()=>assert.fail('captured Run cannot fall back to raw'),
 readCapture:async req=>({state:'unavailable',source:req.source,reason:'capture was never prepared'}),
 readResult:async req=>{reads++;if(mode.endsWith('defect'))throw new Error('unexpected test programming defect');if(mode.endsWith('unavailable'))return {state:'unavailable',source:req.source,size:0,sha256:null,offset:req.offset,base64:'',reason:'source could not be verified'};if(mode.endsWith('refused'))throw new Unverifiable('node does not recognize read_result');return {state:'missing',source:req.source,size:0,sha256:null,offset:req.offset,base64:''};}};
 const runner=createRunner({...RUNNER_TUNED,ledger:f.ledger,adapters:{claude:claudeAdapter},logins:memoryLogins({own:f.login.login}),machines:{get:f.ledger.getMachine,list:f.ledger.listMachines},connect:()=>host});
 if(mode==='formal-refused'){assert.equal(await runner.verify(run),'unknown');assert.equal(f.run(run.id).state,'unknown');assert.equal(f.run(run.id).receipt_json,null);assert.notEqual(f.task(task.id).state,'ready');return;}
 if(mode==='lost-defect'){await assert.rejects(runner.verify(run),/unexpected test programming defect/);assert.equal(f.run(run.id).receipt_json,null);return;}
 await runner.verify(run);assert.ok(reads>0,'the real missing wire response was consumed');
 assert.equal(f.run(run.id).exit_kind,mode.startsWith('lost')?'lost':mode==='never-started'?'failed':'interrupted');
 assert.equal(f.task(task.id).state,mode.startsWith('lost')?'queued':'held');
 if(mode.startsWith('lost'))assert.doesNotMatch(f.task(task.id).reason??'',/不自动重做|手动|核现场|文件交付|调限/);else if(mode.startsWith('formal'))assert.match(f.task(task.id).reason??'',/核现场.*文件交付.*调限/);
 assert.equal(JSON.parse(f.run(run.id).capture_result_json!).disposition,'not_adopted');
});

for (const scenario of ['corrupted-normal', 'corrupted-stopping', 'rotated-credential'] as const) {
  test(`settleLocked settles cleanly instead of looping on InputError (${scenario})`, async (t) => {
    const f = fixture(t);
    const task = f.queuedTask();
    const capture = {
      version: 1 as const,
      source: 'b'.repeat(64),
      result_bytes: 64 * 1024,
      diag_bytes: 64 * 1024,
      diag_tail_bytes: 16 * 1024,
    };
    const run = f.ledger.createRun(task.id, {
      ...f.login,
      expectedRevision: f.task(task.id).revision,
      snapshot: {
        brief: 'b',
        timeout_ms: 60_000,
        output_capture: capture,
        ...(scenario === 'rotated-credential' ? { credential_ref: 'old-ref-1' } : {}),
      },
    }, { actor: 'user' });
    f.ledger.markRunRunning(run.id);
    if (scenario === 'corrupted-stopping') f.ledger.markRunStopping(run.id, { actor: 'user' });

    const corruptedBytes = Buffer.from('{not valid json', 'utf8');
    const host: RemoteHost = {
      place: async () => [],
      start: async () => ({ code: 0, stdout: '', stderr: '' }),
      stop: async () => {},
      list: async () => [],
      artifacts: async () => [],
      dropRun: async () => {},
      connected: () => true,
      state: async () => ({ started: true, launcher_alive: false, pid_alive: false, marked: false, exit: 0, unknown: null }),
      readRange: async () => assert.fail('captured Run cannot fall back to raw'),
      readCapture: async (req) => ({ state: 'unavailable', source: req.source, reason: 'none' }),
      readResult: async (req) => ({
        state: 'ready',
        source: req.source,
        size: corruptedBytes.length,
        sha256: '0'.repeat(64),
        offset: req.offset,
        base64: corruptedBytes.toString('base64'),
      }),
    };
    const runner = createRunner({
      ...RUNNER_TUNED,
      ledger: f.ledger,
      adapters: { claude: claudeAdapter },
      logins: memoryLogins({ own: f.login.login }),
      machines: { get: f.ledger.getMachine, list: f.ledger.listMachines },
      connect: () => host,
      credential: () => ({ ref: 'new-ref-2', value: 'rotated-secret-value' }),
    });

    const verdict = await runner.verify(f.run(run.id));
    assert.equal(verdict, 'ended');
    assert.equal(f.run(run.id).state, 'ended');
    assert.equal(f.run(run.id).exit_kind, 'interrupted');
    assert.equal(f.task(task.id).state, 'held');
    assert.equal(JSON.parse(f.run(run.id).capture_result_json!).disposition, 'not_adopted');
    if (scenario === 'rotated-credential') {
      assert.match(f.task(task.id).reason ?? '', /凭据代次已变化/);
    } else if (scenario === 'corrupted-normal') {
      assert.match(f.task(task.id).reason ?? '', /摘要不符/);
    }
  });
}
