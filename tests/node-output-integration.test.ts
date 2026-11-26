import {MIN_OUTPUT_RESULT_BYTES} from '../shared/node-output.ts';
// Public watch, storage and Host boundaries; no model or live service.
import './guard.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {machine,run,WATCH,until} from './node-watch-fixture.ts';
import {createOutputPool} from '../node/output-pool.ts';
import {machineScope,readExit} from '../node/runbox.ts';
import {DEFAULT_OUTPUT_POLICY} from '../node/capture.ts';
import {readCaptureResult} from '../runner/capture-result.ts';
import {createClient} from '../node/client.ts';
async function prepare(m:ReturnType<typeof machine>,id:string,source:string,result_bytes=1048576){
 const box=m.box('capture',id),spec={version:1 as const,source,raw_bytes:32768,result_bytes};
 mkdirSync(join(box.runDir,'snapshot'),{recursive:true});writeFileSync(join(box.runDir,'snapshot','output.json'),JSON.stringify({executor:'claude',capture:spec}));
 const pool=createOutputPool({root:join(machineScope(m.dataDir),'output'),nodeId:'test-capture'});
 const reserved=await pool.reserve({run_dir:box.relative,spec},DEFAULT_OUTPUT_POLICY,{bytes:0});assert.equal(reserved.state,'ready');return {box,spec,pool};
}
test('real watch seals the adapter result; ordinary file API remains physical',async t=>{
 const m=machine(t),{box,spec,pool}=await prepare(m,run.r1,'c'.repeat(64));
 assert.equal(await m.start('capture',run.r1,1,{args:['--source='+spec.source,'--node-id=test-capture']}),0);assert.equal(readExit(box),0);
 const got=await readCaptureResult(box.relative,spec,pool.readResult,()=>{},x=>x);assert.equal(got.reading?.finished,true);assert.match(got.reading!.text!,/节点上这一轮跑完了/);
 assert.equal(existsSync(join(box.runDir,'stdout.ndjson')),false);
 const client=createClient({dataDir:m.dataDir,origin:'http://127.0.0.1:1',token:'f'.repeat(64),facts:{node_id:'test-capture',name:'test',hostname:'test',platform:'test'},log:()=>{}});
 const raw=await client.execute({id:'physical',kind:'read_output',path:box.relative+'/stdout.ndjson',bytes:262144,offset:0});assert.equal((raw as {size:number}).size,0,'read_output cannot substitute a logical capture');
});
test('reader overflow releases parsing state while both real child pipes continue draining',async t=>{
 const m=machine(t),{box,spec,pool}=await prepare(m,run.r2,'d'.repeat(64),MIN_OUTPUT_RESULT_BYTES),worker=join(m.dataDir,'drain.mjs'),marker=join(m.dataDir,'fully-drained');
 writeFileSync(worker,`import {writeFileSync} from 'node:fs';const a=Buffer.alloc(2*1024*1024,120);await new Promise(r=>process.stdout.write(a,r));await new Promise(r=>process.stderr.write(a,r));writeFileSync(process.argv[2],'done');`);
 const code=await new Promise<number>((resolve,reject)=>{const child=spawn(process.execPath,[WATCH,'--data='+m.dataDir,'--run='+box.relative,'--round=1','--source='+spec.source,'--node-id=test-capture','--',process.execPath,worker,marker],{stdio:'ignore',env:process.env});child.once('error',reject);child.once('exit',code=>resolve(code??-1));});
 assert.equal(code,0);assert.equal(readExit(box),0);assert.equal(existsSync(marker),true,'child finished both backpressured writes');
 const result=await pool.readResult({run_dir:box.relative,source:spec.source,offset:0,bytes:256*1024});assert.equal(result.state,'incomplete');assert.ok(result.size<=spec.result_bytes);
 for(const stream of ['stdout','stderr'] as const){const range=await pool.readCapture({run_dir:box.relative,source:spec.source,stream,offset:0,bytes:256*1024});assert.equal(range.state,'range');if(range.state==='range'){assert.equal(range.end,2*1024*1024);assert.ok(range.gap);assert.ok(Buffer.from(range.base64,'base64').length<=spec.raw_bytes/2);}}
});
test('captured start cannot invent a missing reservation',async t=>{
 const m=machine(t),box=m.box('capture',run.r3),source='e'.repeat(64);mkdirSync(join(box.runDir,'snapshot'),{recursive:true});writeFileSync(join(box.runDir,'snapshot','output.json'),JSON.stringify({executor:'claude',capture:{version:1,source,raw_bytes:32768,result_bytes:1048576}}));
 assert.notEqual(await m.start('capture',run.r3,1,{args:['--source='+source,'--node-id=test-capture']}),0);assert.equal(existsSync(join(box.runDir,'stdout.ndjson')),false);
});

test('normal client polls never abandon a real active watch collector',async t=>{
 const m=machine(t),{box,spec,pool}=await prepare(m,run.r4,'f'.repeat(64)),touch=join(m.dataDir,'active'),finish=join(m.dataDir,'finish');
 const watching=m.start('capture',run.r4,1,{args:['--source='+spec.source,'--node-id=test-capture'],env:{TYCHO_FAKE_TOUCH:touch,TYCHO_FAKE_WAIT_FILE:finish}});
 await until(()=>existsSync(touch),'real Worker active');
 const stop=new AbortController(),states:string[]=[];
 const client=createClient({dataDir:m.dataDir,origin:'http://127.0.0.1:1',token:'f'.repeat(64),facts:{node_id:'test-capture',name:'test',hostname:'test',platform:'test'},executors:{questions:[]},lookupEnv:async()=>({env:process.env}),log:()=>{},fetch:(async(url,init)=>{
  assert.ok(String(url).endsWith('/api/node/poll'));
  const body=JSON.parse(String(init?.body));assert.equal(body.bounded_output,1);
  states.push((await pool.readResult({run_dir:box.relative,source:spec.source,offset:0,bytes:262144})).state);
  if(states.length===3)stop.abort();return new Response(JSON.stringify({protocol:7,command:null,look_every_ms:60000}));
 }) as typeof fetch});try{await client.run(stop.signal);
 assert.deepEqual(states,['pending','pending','pending'],'polls cannot seal a live collector as incomplete');}finally{writeFileSync(finish,'done');assert.equal(await watching,0);}
 assert.equal((await pool.readResult({run_dir:box.relative,source:spec.source,offset:0,bytes:262144})).state,'ready');
});
