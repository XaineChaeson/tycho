import {createOutputPool} from '../node/output-pool.ts';
import {DEFAULT_OUTPUT_POLICY} from '../node/capture.ts';
import {writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {machineScope} from '../node/runbox.ts';
import './guard.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createClient} from '../node/client.ts';
import {tempDir} from './cli-helpers.ts';
test('public client with a newly registered node identity still polls within the same storage root',async t=>{
 const dataDir=tempDir(t);let firstPolls=0,secondPolls=0;const observed:string[]=[];const reports:Array<{capacity:{available_runs:number;reserved_bytes:number}}> = [];
 for(const [index,node_id] of ['a'.repeat(32),'b'.repeat(32)].entries()){
  const stop=new AbortController();
  const client=createClient({dataDir,origin:'http://127.0.0.1:1',token:'f'.repeat(64),facts:{node_id,name:'same-machine',hostname:'same-machine',platform:'test'},executors:{questions:[]},lookupEnv:async()=>({env:process.env}),log:line=>{observed.push(line);if(line.includes('输出')||line.includes('归属'))stop.abort();},fetch:(async(_url,init)=>{reports.push(JSON.parse(String(init?.body)).output);if(index===0)firstPolls++;else secondPolls++;stop.abort();return new Response(JSON.stringify({protocol:7,command:null,look_every_ms:60000}));}) as typeof fetch});
  await client.run(stop.signal);
  if(index===0){const pool=createOutputPool({root:join(machineScope(dataDir),'output'),nodeId:node_id});assert.equal((await pool.reserve({run_dir:'tasks/old/runs/old',spec:{version:1,source:'d'.repeat(64),raw_bytes:32768,result_bytes:16384}},DEFAULT_OUTPUT_POLICY,{bytes:0})).state,'ready');}
 }
 assert.equal(firstPolls,1);assert.equal(secondPolls,1,JSON.stringify(observed));assert.ok(reports[1]!.capacity.available_runs>0,'new identity still admits new work');assert.ok(reports[1]!.capacity.reserved_bytes>reports[0]!.capacity.reserved_bytes,'old identity reservation remains charged');const pool=createOutputPool({root:join(machineScope(dataDir),'output'),nodeId:'b'.repeat(32)});const old=await pool.readResult({run_dir:'tasks/old/runs/old',source:'d'.repeat(64),offset:0,bytes:262144});assert.ok(['missing','unavailable'].includes(old.state),'new identity cannot read old result');
});

test('an unknown output-root file blocks admission without blocking normal Node heartbeat',async t=>{
 const dataDir=tempDir(t),node_id='c'.repeat(32);let polls=0;
 async function pollOnce(){const stop=new AbortController();const client=createClient({dataDir,origin:'http://127.0.0.1:1',token:'f'.repeat(64),facts:{node_id,name:'test',hostname:'test',platform:'test'},executors:{questions:[]},lookupEnv:async()=>({env:process.env}),log:()=>{},fetch:(async(_url,init)=>{polls++;const body=JSON.parse(String(init?.body));if(polls===2){assert.equal(body.output.capacity.available_runs,0);assert.match(body.output.capacity.issue,/无法核实/);}stop.abort();return new Response(JSON.stringify({protocol:7,command:null,look_every_ms:60000}));}) as typeof fetch});await client.run(stop.signal);}
 await pollOnce();const unknown=join(machineScope(dataDir),'output','unknown-owner-file');writeFileSync(unknown,'not ours');await pollOnce();assert.equal(polls,2);assert.equal(existsSync(unknown),true);
});
