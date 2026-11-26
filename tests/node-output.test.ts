import './guard.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, lstat, mkdir, writeFile, symlink, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createOutputPool } from '../node/output-pool.ts';
import { openOutputWriter } from '../node/output-store.ts';
import { MIN_OUTPUT_RESULT_BYTES, normalizeCaptureSpec, normalizeOutputPolicy } from '../shared/node-output.ts';
import type { OutputPolicy, OutputLease } from '../shared/node-output.ts';
const policy:OutputPolicy={store_bytes:32*1024*1024,raw_bytes:8192,result_bytes:2*1024*1024,retention_ms:10};
const sid=(n:number)=>n.toString(16).padStart(64,'0');
const run=(n:number)=>`tasks/T${n}/runs/R${n}`;
const ext={bytes:0};
const body=(source:string,extra='')=>Buffer.from(JSON.stringify({version:1,source,state:'ready',reading:{text:extra}}));
async function fixture(t:TestContext){const root=await mkdtemp(join(tmpdir(),'tycho-output-b-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const pool=createOutputPool({root,nodeId:'node-test'});return {root,pool};}
async function reserve(pool:ReturnType<typeof createOutputPool>,n=1,p=policy):Promise<OutputLease>{const result=await pool.reserve({run_dir:run(n),spec:{version:1,source:sid(n),raw_bytes:p.raw_bytes,result_bytes:p.result_bytes}},p,ext);assert.equal(result.state,'ready');if(result.state!=='ready')throw Error('reservation unavailable');return result.lease;}
async function disk(root:string):Promise<number>{let total=0;for(const name of await readdir(root)){const path=join(root,name),s=await lstat(path);total+=s.isDirectory()?await disk(path):s.size;}return total;}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('entry normalization rejects unknown capture and invalid limits',()=>{assert.throws(()=>normalizeCaptureSpec({version:2,source:sid(1),raw_bytes:1,result_bytes:1}));assert.throws(()=>normalizeOutputPolicy({...policy,raw_bytes:0}));assert.throws(()=>normalizeOutputPolicy({...policy,store_bytes:Infinity}));assert.deepEqual(normalizeOutputPolicy({...policy,ignored:3}),policy);});

test('durable/idempotent reservation, existing-only lease and conflict rejection',async t=>{const {root,pool}=await fixture(t);assert.equal(await pool.lease(sid(1),run(1)),undefined);const lease=await reserve(pool);const before=await pool.capacity(policy,ext);assert.deepEqual(await reserve(pool),lease);assert.equal((await pool.capacity(policy,ext)).reserved_bytes,before.reserved_bytes);const restarted=createOutputPool({root,nodeId:'node-test'});assert.deepEqual(await restarted.lease(sid(1),run(1)),lease);await assert.rejects(()=>pool.lease(sid(1),run(2)));await assert.rejects(()=>pool.reserve({run_dir:run(2),spec:{version:1,source:sid(1),raw_bytes:policy.raw_bytes,result_bytes:policy.result_bytes}},policy,ext));await assert.rejects(()=>openOutputWriter({...lease,nodeId:'foreign'}));await assert.rejects(()=>openOutputWriter({...lease,run_dir:run(2)}));assert.equal((await pool.readResult({source:sid(1),run_dir:run(2),offset:0,bytes:20})).state,'unavailable');assert.equal((await pool.readCapture({source:sid(1),run_dir:run(2),stream:'stdout',offset:0,bytes:20})).state,'unavailable');});

test('serialized concurrent admissions cannot overspend; external issue stops admission',async t=>{const {pool}=await fixture(t);const empty=await pool.capacity(policy,ext);const one=await reserve(pool);const after=await pool.capacity(policy,ext);const unit=after.reserved_bytes-empty.reserved_bytes;const tight={...policy,store_bytes:after.reserved_bytes+unit};const results=await Promise.all([2,3,4,5].map(n=>pool.reserve({run_dir:run(n),spec:{version:1,source:sid(n),raw_bytes:policy.raw_bytes,result_bytes:policy.result_bytes}},tight,ext)));assert.equal(results.filter(r=>r.state==='ready').length,1);const capacity=await pool.capacity(tight,ext);assert.ok(capacity.reserved_bytes<=tight.store_bytes);assert.ok(capacity.used_bytes<=capacity.reserved_bytes);assert.equal((await pool.capacity(policy,{bytes:0,issue:''})).available_runs,0);assert.equal((await pool.capacity({...policy,store_bytes:0},ext)).available_runs,0);assert.deepEqual(await pool.lease(one.source,one.run_dir),one);});

test('pending is not EOF, exact tail/gap and immutable paged result survive reopening',async t=>{const {root,pool}=await fixture(t);const lease=await reserve(pool),writer=await openOutputWriter(lease);assert.equal((await pool.readResult({run_dir:run(1),source:sid(1),offset:0,bytes:10})).state,'pending');const input=Buffer.from(('你好🙂xyz'.repeat(10000)));writer.feed('stdout',input);writer.feed('stderr',Buffer.from('err'));let sawPending=false;for(let i=0;i<200;i++){const range=await pool.readCapture({run_dir:run(1),source:sid(1),stream:'stdout',offset:input.length,bytes:50});if(range.state==='range'&&range.end===input.length){assert.equal(range.sealed,false);sawPending=true;break;}await tick();}
 assert.equal(sawPending,true);const bytes=body(sid(1),'k'.repeat(600000));const ref=await writer.finish(bytes,'ready');await assert.rejects(()=>writer.finish(bytes,'ready'));assert.throws(()=>writer.feed('stdout',Buffer.from('late')));const fresh=createOutputPool({root,nodeId:'node-test'});const range=await fresh.readCapture({run_dir:run(1),source:sid(1),stream:'stdout',offset:0,bytes:1e9});assert.equal(range.state,'range');if(range.state!=='range')throw Error('capture unavailable');assert.ok(range.base>0);assert.deepEqual(range.gap&&{from:range.gap.from,to:range.gap.to},{from:0,to:range.base});assert.equal(range.end,input.length);assert.equal(range.sealed,true);assert.deepEqual(Buffer.from(range.base64,'base64'),input.subarray(range.start,range.committed_end));assert.equal((await fresh.readCapture({run_dir:run(1),source:sid(1),stream:'stdout',offset:input.length+1,bytes:1})).state,'unavailable');
 let offset=0;const pages:Buffer[]=[];while(offset<ref.size){const page=await fresh.readResult({run_dir:run(1),source:sid(1),offset,bytes:1e9});assert.equal(page.state,'ready');assert.equal(page.sha256,ref.sha256);assert.equal(page.size,ref.size);const data=Buffer.from(page.base64,'base64');assert.ok(data.length<=256*1024);assert.ok(data.length>0);pages.push(data);offset+=data.length;}assert.deepEqual(Buffer.concat(pages),bytes);assert.equal(createHash('sha256').update(Buffer.concat(pages)).digest('hex'),ref.sha256);assert.ok(await disk(root)<(await fresh.capacity(policy,ext)).reserved_bytes);});

test('live concurrent capture reads never return mixed absolute bytes under eviction',async t=>{const {pool}=await fixture(t);const writer=await openOutputWriter(await reserve(pool));const chunks:Buffer[]=[];let complete=false;const reading=(async()=>{while(!complete){const r=await pool.readCapture({run_dir:run(1),source:sid(1),stream:'stdout',offset:0,bytes:2048});if(r.state==='range'){const bytes=Buffer.from(r.base64,'base64');for(let i=0;i<bytes.length;i++)assert.equal(bytes[i],(r.start+i)%251);}await tick();}})();for(let n=0;n<80;n++){const b=Buffer.alloc(3000);for(let i=0;i<b.length;i++)b[i]=(n*3000+i)%251;chunks.push(b);writer.feed('stdout',b);if(n%3===0)await tick();}await writer.finish(body(sid(1)),'ready');complete=true;await reading;const r=await pool.readCapture({run_dir:run(1),source:sid(1),stream:'stdout',offset:0,bytes:8192});assert.equal(r.state,'range');if(r.state==='range')assert.deepEqual(Buffer.from(r.base64,'base64'),Buffer.concat(chunks).subarray(r.start,r.committed_end));});

test('real ordinary child drains both overflowing pipes, including UTF8/no-newline',async t=>{const {root,pool}=await fixture(t);const writer=await openOutputWriter(await reserve(pool));const observed={stdout:0,stderr:0};const child=spawn(process.execPath,['-e',`const b=Buffer.from('界🙂'.repeat(10000));let n=0;function w(){if(n++===150)return;process.stdout.write(b);process.stderr.write(b);setImmediate(w)}w()`],{stdio:['ignore','pipe','pipe']});for(const stream of ['stdout','stderr'] as const)child[stream].on('data',(b:Buffer)=>{observed[stream]+=b.length;writer.feed(stream,b);});const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});assert.equal(code,0);await writer.finish(body(sid(1)),'ready');for(const stream of ['stdout','stderr'] as const){assert.ok(observed[stream]>1e6);const r=await pool.readCapture({run_dir:run(1),source:sid(1),stream,offset:0,bytes:8192});assert.equal(r.state,'range');if(r.state==='range'){assert.equal(r.end,observed[stream]);assert.ok(r.gap);assert.ok(Buffer.from(r.base64,'base64').length<=policy.raw_bytes/2);}}const c=await pool.capacity(policy,ext);assert.ok(await disk(root)<=c.reserved_bytes);assert.ok(c.used_bytes<=c.reserved_bytes);t.diagnostic(JSON.stringify({case:'ordinary-child',pid:child.pid,exit:code,observed,disk_bytes:await disk(root),capacity:c}));});

test('release waits for sealed result; reaping recovers storage without deleting undelivered result',async t=>{const {root}=await fixture(t);let now=100;const pool=createOutputPool({root,nodeId:'node-test',now:()=>now});const lease=await reserve(pool),writer=await openOutputWriter(lease);await pool.release(sid(1));assert.equal((await pool.references()).items[0].phase,'release_pending');const before=await pool.capacity(policy,ext);await pool.reap(policy);assert.equal((await pool.capacity(policy,ext)).reserved_bytes,before.reserved_bytes);await writer.finish(body(sid(1)),'ready');await pool.reap(policy);assert.equal((await pool.references()).items[0].phase,'released');assert.equal((await pool.readResult({run_dir:run(1),source:sid(1),offset:0,bytes:10})).state,'released');now+=11;await pool.reap(policy);assert.equal((await pool.references()).items.length,0);assert.equal(await pool.lease(sid(1),run(1)),undefined);
 const w2=await openOutputWriter(await reserve(pool,2));await w2.finish(body(sid(2)),'ready');now+=10000;await pool.reap({...policy,store_bytes:0});assert.equal((await pool.readResult({run_dir:run(2),source:sid(2),offset:0,bytes:50})).state,'ready');assert.equal((await pool.capacity({...policy,store_bytes:0},ext)).available_runs,0);});

test('many sequential Runs release and reclaim; pagination reaches later sources',async t=>{const {pool}=await fixture(t);for(let n=1;n<=12;n++){const w=await openOutputWriter(await reserve(pool,n));await w.finish(body(sid(n)),'ready');await pool.release(sid(n));}const page=await pool.references({limit:5});assert.equal(page.items.length,5);assert.ok(page.next);const next=await pool.references({after:page.next,limit:100});assert.equal(next.items.length,7);await pool.reap({...policy,retention_ms:0});assert.equal((await pool.references()).items.length,0);assert.ok((await pool.capacity(policy,ext)).used_bytes<1000);});

test('oversized or malformed result never claims partial ready',async t=>{const {pool}=await fixture(t);const small={...policy,result_bytes:MIN_OUTPUT_RESULT_BYTES};const writer=await openOutputWriter(await reserve(pool,1,small));const ref=await writer.finish(body(sid(1),'x'.repeat(MIN_OUTPUT_RESULT_BYTES*2)),'ready');assert.equal(ref.state,'incomplete');const r=await pool.readResult({run_dir:run(1),source:sid(1),offset:0,bytes:9999});assert.equal(r.state,'incomplete');assert.match(Buffer.from(r.base64,'base64').toString(),/超过/);const w2=await openOutputWriter(await reserve(pool,2));await assert.rejects(()=>w2.finish(body(sid(3)),'ready'));assert.equal((await pool.readResult({run_dir:run(2),source:sid(2),offset:0,bytes:20})).state,'pending');});

test('unknown directories, half manifests and internal symlinks fail closed without deleting foreign data',async t=>{const {root,pool}=await fixture(t);const lease=await reserve(pool);await writeFile(join(root,sid(1),'capture.json'),'{');assert.equal((await pool.capacity(policy,ext)).available_runs,0);assert.ok((await pool.capacity(policy,ext)).issue);await pool.abandon(sid(1),'C已核实采集者消失');assert.equal((await pool.readResult({run_dir:run(1),source:sid(1),offset:0,bytes:999})).state,'incomplete');assert.equal((await pool.readCapture({run_dir:run(1),source:sid(1),stream:'stdout',offset:0,bytes:10})).state,'unavailable');await mkdir(join(root,'unknown'));assert.equal((await pool.capacity(policy,ext)).available_runs,0);assert.ok((await lstat(join(root,'unknown'))).isDirectory());const second=await mkdtemp(join(tmpdir(),'tycho-output-target-'));t.after(()=>rm(second,{recursive:true,force:true}));const other=createOutputPool({root:second,nodeId:'node-test'});await reserve(other,2);const target=join(second,sid(2),'result.bin');let madeLink=false;try{await symlink('/etc/passwd',target);madeLink=true;}catch(err){if((err as NodeJS.ErrnoException).code!=='EPERM')throw err;}if(madeLink){assert.equal((await other.capacity(policy,ext)).available_runs,0);await assert.rejects(()=>other.release(sid(2)));assert.equal((await lstat(target)).isSymbolicLink(),true);}await assert.rejects(()=>pool.lease(lease.source,'../bad'));});

test('actual metadata sink error does not stop drain and cannot publish ready',async t=>{const {root,pool}=await fixture(t);const w=await openOutputWriter(await reserve(pool));const manifest=join(root,sid(1),'capture.json');await rename(manifest,manifest+'.saved');await mkdir(manifest);for(let i=0;i<100;i++)w.feed(i%2?'stdout':'stderr',Buffer.alloc(65536));await assert.rejects(()=>w.finish(body(sid(1)),'ready'));assert.equal((await pool.readResult({run_dir:run(1),source:sid(1),offset:0,bytes:20})).state,'unavailable');assert.ok(await disk(root)<10*1024*1024);});


test('released tombstones yield to admission pressure before retention expires',async t=>{
 const {pool}=await fixture(t);const initial=await pool.capacity(policy,ext);await reserve(pool);const allocated=await pool.capacity(policy,ext);
 const exact={...policy,store_bytes:allocated.reserved_bytes,retention_ms:7*86400*1000};
 for(let n=1;n<=20;n++){
  const lease=n===1?(await pool.lease(sid(1),run(1)))!:await reserve(pool,n,exact);
  const writer=await openOutputWriter(lease);await writer.finish(body(sid(n)),'ready');await pool.release(sid(n));
  const c=await pool.capacity(exact,ext);assert.equal(c.available_runs,1);assert.equal(c.reserved_bytes,initial.reserved_bytes);
 }
 assert.equal((await pool.references()).items.length,0);
});


test('result capacity rejects impossible envelopes before durable reservation',async t=>{
 const {root,pool}=await fixture(t);const tiny={...policy,result_bytes:1};
 assert.equal(MIN_OUTPUT_RESULT_BYTES,4096);for(const value of [0,1,4095]){assert.throws(()=>normalizeOutputPolicy({...tiny,result_bytes:value}));assert.throws(()=>normalizeCaptureSpec({version:1,source:sid(1),raw_bytes:policy.raw_bytes,result_bytes:value}));}
 // Before the repair this is admitted, then neither finish nor collector-dead abandonment can seal.
 const reserved=await pool.reserve({run_dir:run(1),spec:{version:1,source:sid(1),raw_bytes:tiny.raw_bytes,result_bytes:1}},tiny,ext).catch(()=>undefined);
 if(reserved?.state==='ready'){
  const writer=await openOutputWriter(reserved.lease);
  await assert.rejects(()=>writer.finish(body(sid(1)),'ready'));
  await pool.release(sid(1));
  await assert.rejects(()=>pool.abandon(sid(1),'已核实采集者死亡'));
  await pool.reap(tiny);
  const reopened=createOutputPool({root,nodeId:'node-test'});
  assert.equal((await reopened.references()).items[0]?.phase,'release_pending');
  t.diagnostic(JSON.stringify({reproduced:'result1-impossible-envelope',references:await reopened.references(),capacity:await reopened.capacity(tiny,ext)}));
 }
 assert.equal(reserved,undefined,'impossible result budget must fail before reservation');
});


test('minimum envelope preserves worst-case escaped Unicode abandonment through restart and release',async t=>{
 const {root,pool}=await fixture(t);const min={...policy,result_bytes:MIN_OUTPUT_RESULT_BYTES};
 const lease=await reserve(pool,1,min);await openOutputWriter(lease); // No pending writes; caller has proved the collector is gone.
 const why='\ud800'.repeat(512);
 await pool.abandon(sid(1),why);
 const restarted=createOutputPool({root,nodeId:'node-test'});
 const r=await restarted.readResult({run_dir:run(1),source:sid(1),offset:0,bytes:256*1024});assert.equal(r.state,'incomplete');
 const decoded=Buffer.from(r.base64,'base64');assert.ok(decoded.length<=MIN_OUTPUT_RESULT_BYTES);const parsed=JSON.parse(decoded.toString());assert.equal(parsed.reason,why.slice(0,512));assert.equal(parsed.reason.length,512);
 assert.equal(createHash('sha256').update(decoded).digest('hex'),r.sha256);
 await restarted.release(sid(1));await restarted.reap({...min,retention_ms:0});
 const final=createOutputPool({root,nodeId:'node-test'});assert.equal((await final.references()).items.length,0);assert.equal((await final.capacity(min,ext)).reserved_bytes,16384);
 const l2=await reserve(final,2,min);await openOutputWriter(l2);await final.release(sid(2));assert.equal((await final.references()).items[0]?.phase,'release_pending');
 const afterLoss=createOutputPool({root,nodeId:'node-test'});await afterLoss.abandon(sid(2),why);assert.equal((await afterLoss.references()).items[0]?.phase,'released');await afterLoss.reap({...min,retention_ms:0});assert.equal((await createOutputPool({root,nodeId:'node-test'}).references()).items.length,0);
 t.diagnostic(JSON.stringify({minimum:MIN_OUTPUT_RESULT_BYTES,reason_utf16:parsed.reason.length,envelope_bytes:decoded.length,state:r.state}));
});


for(const boundary of ['mkdir','lease','capture','published'] as const)test(`reservation publication survives SIGKILL at ${boundary}`,async t=>{
 const {root,pool}=await fixture(t);const producer=String.raw`
 import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import {basename} from 'node:path';
 const boundary=${JSON.stringify(boundary)},source=${JSON.stringify(sid(1))};
 const pause=async()=>{await new Promise(r=>process.stdout.write('BOUNDARY\n',r));await new Promise(()=>{});};
 const mkdir=fs.mkdir,rename=fs.rename;
 fs.mkdir=async function(path,...args){const result=await mkdir.call(this,path,...args);const name=basename(String(path));if(boundary==='mkdir'&&(name===source||name.startsWith('.reserve-'+source+'-')))await pause();return result;};
 fs.rename=async function(from,to){const dest=basename(String(to));if((boundary==='lease'&&dest==='lease.json')||(boundary==='capture'&&dest==='capture.json'))await pause();const result=await rename.call(this,from,to);if(boundary==='published'&&(dest===source||(dest==='capture.json'&&!String(to).includes('.reserve-'))))await pause();return result;};
 syncBuiltinESMExports();
 const {createOutputPool}=await import(${JSON.stringify(new URL('../node/output-pool.ts',import.meta.url).href)});
 const p=createOutputPool({root:${JSON.stringify(root)},nodeId:'node-test'});
 await p.reserve({run_dir:${JSON.stringify(run(1))},spec:{version:1,source,raw_bytes:8192,result_bytes:8192}},{store_bytes:33554432,raw_bytes:8192,result_bytes:8192,retention_ms:10},{bytes:0});
 `;
 const child=spawn(process.execPath,['--input-type=module','-e',producer],{stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');});
 let stdout='',stderr='';child.stderr.on('data',b=>stderr+=b.toString());
 await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('fault boundary not reached: '+stderr)),5000);child.stdout.on('data',b=>{stdout+=b.toString();if(stdout.includes('BOUNDARY')){clearTimeout(timeout);resolve();}});child.once('exit',(code)=>{clearTimeout(timeout);reject(new Error('producer exited before boundary '+code+' '+stderr));});child.once('error',reject);});
 const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited;
 if(boundary==='capture'){const newer=createOutputPool({root,nodeId:'node-new'}),seen=await newer.capacity(policy,ext);assert.equal(seen.issue,undefined);assert.equal(seen.other_node_reserved_bytes,0);await reserve(newer,2);await newer.release(sid(2));await newer.reap({...policy,retention_ms:0});t.diagnostic(JSON.stringify({old_stage_recovered_by_new_node:true,pid:child.pid,capacity:seen}));}
 const reopened=createOutputPool({root,nodeId:'node-test'});
 if(boundary==='mkdir'){const staging=(await readdir(root)).find(name=>name.startsWith('.reserve-'));assert.ok(staging);const unknown=join(root,staging!,'foreign.txt');await writeFile(unknown,'preserve');assert.ok((await reopened.capacity(policy,ext)).issue);assert.equal(await readFile(unknown,'utf8'),'preserve');await rm(unknown);const link=join(root,staging!,'lease.json.00000000-0000-4000-8000-000000000000.draft');let madeLink=false;try{await symlink(join(root,'owner.json'),link);madeLink=true;}catch(err){if((err as NodeJS.ErrnoException).code!=='EPERM')throw err;}if(madeLink){assert.ok((await reopened.capacity(policy,ext)).issue);assert.equal((await lstat(link)).isSymbolicLink(),true);await rm(link);}}
 const c=await reopened.capacity(policy,ext);
 t.diagnostic(JSON.stringify({boundary,pid:child.pid,signal:child.signalCode,capacity:c}));assert.equal(c.issue,undefined);
 const recovered=await reopened.lease(sid(1),run(1));assert.equal(!!recovered,boundary==='published');
 const p={...policy,result_bytes:8192};const admitted=await reopened.reserve({run_dir:run(1),spec:{version:1,source:sid(1),raw_bytes:8192,result_bytes:8192}},p,ext);assert.equal(admitted.state,'ready');
 assert.equal((await reopened.reserve({run_dir:run(2),spec:{version:1,source:sid(2),raw_bytes:8192,result_bytes:8192}},p,ext)).state,'ready');
});


test('fenced release reclaims a never-started reservation after restart',async t=>{
 const {root,pool}=await fixture(t);await reserve(pool);await pool.release(sid(1));const reopened=createOutputPool({root,nodeId:'node-test'});
 assert.equal((await reopened.references()).items[0]?.phase,'released');assert.ok((await reopened.capacity(policy,ext)).reserved_bytes<1024*1024);
});

for(const resumedNode of ['node-test','node-new'])test(`fenced release recovers SIGKILL before released marker as ${resumedNode}`,async t=>{
 const {root,pool}=await fixture(t);await reserve(pool);
 const script=String.raw`
 import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import {basename} from 'node:path';
 const pause=async(where)=>{setInterval(()=>{},1000);await new Promise(r=>process.stdout.write(JSON.stringify({boundary:where})+'\n',r));await new Promise(()=>{});};
 const link=fs.link;fs.link=async function(from,to){const result=await link.call(this,from,to);if(basename(String(to))==='writer.lock')await pause('release-fence-linked');return result;};syncBuiltinESMExports();
 const {createOutputPool}=await import(${JSON.stringify(new URL('../node/output-pool.ts',import.meta.url).href)});const p=createOutputPool({root:${JSON.stringify(root)},nodeId:'node-test'});
 await p.release(${JSON.stringify(sid(1))});await pause('release-returned-without-fence');
 `;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');});let out='',err='';child.stderr.on('data',b=>err+=b.toString());
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('release boundary timeout '+err)),5000);child.stdout.on('data',b=>{out+=b.toString();if(out.includes('\n')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error('release exited '+code+' '+err));});child.once('error',reject);});
 const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited;
 const reopened=createOutputPool({root,nodeId:resumedNode});await reopened.capacity(policy,ext);t.diagnostic(JSON.stringify({pid:child.pid,signal:child.signalCode,...JSON.parse(out.trim())}));if(resumedNode==='node-test')assert.equal((await reopened.references()).items[0]?.phase,'released');else assert.deepEqual((await reopened.references()).items,[]);
 await reopened.reap({...policy,retention_ms:0});assert.equal((await createOutputPool({root,nodeId:'node-test'}).references()).items.length,0);
});

test('fenced release leaves a real active writer intact until its ordinary finish',async t=>{
 const {root,pool}=await fixture(t);await reserve(pool);
 const script=String.raw`
 const {createOutputPool}=await import(${JSON.stringify(new URL('../node/output-pool.ts',import.meta.url).href)});const {openOutputWriter}=await import(${JSON.stringify(new URL('../node/output-store.ts',import.meta.url).href)});
 const p=createOutputPool({root:${JSON.stringify(root)},nodeId:'node-test'}),lease=await p.lease(${JSON.stringify(sid(1))},${JSON.stringify(run(1))}),w=await openOutputWriter(lease);
 const clock=setInterval(()=>w.feed('stdout',Buffer.from('active\n')),5);process.stdout.write('ACTIVE\n');await new Promise(resolve=>process.stdin.once('data',resolve));clearInterval(clock);
 await w.finish(Buffer.from(JSON.stringify({version:1,source:${JSON.stringify(sid(1))},state:'ready',reading:{text:'finished'}})),'ready');process.stdin.destroy();process.stdout.write('DONE\n');
 `;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe']});t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');});let out='',err='';child.stderr.on('data',b=>err+=b.toString());
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('active writer timeout '+err)),5000);child.stdout.on('data',b=>{out+=b.toString();if(out.includes('ACTIVE')){clearTimeout(timer);resolve();}});child.once('error',reject);});
 await pool.release(sid(1));assert.equal((await pool.references()).items[0]?.phase,'release_pending');assert.doesNotThrow(()=>process.kill(child.pid!,0));
 const exit=new Promise<number|null>(resolve=>child.once('close',resolve));child.stdin.end('finish\n');assert.equal(await exit,0);assert.match(out,/DONE/);await pool.capacity(policy,ext);assert.equal((await pool.references()).items[0]?.phase,'released');t.diagnostic(JSON.stringify({active_writer_pid:child.pid,exit:child.exitCode}));
});

test('fenced release preserves a foreign ownership lock',async t=>{
 const {root,pool}=await fixture(t);const lease=await reserve(pool);const target=join(root,sid(1),'writer.lock');const foreign=JSON.stringify({version:1,role:'release',source:lease.source,nodeId:'foreign',run_dir:lease.run_dir});await writeFile(target,foreign);
 await assert.rejects(()=>pool.release(sid(1)));assert.equal(await readFile(target,'utf8'),foreign);assert.equal((await pool.references()).items[0]?.phase,'release_pending');
});


test('fenced release rejects an old writer paused before its fence draft',async t=>{
 const {root,pool}=await fixture(t);await reserve(pool);
 const script=String.raw`
 import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import {basename} from 'node:path';
 const write=fs.writeFile;fs.writeFile=async function(path,data,...rest){if(basename(String(path)).startsWith('writer.lock.')&&String(data).includes('"role":"writer"')){process.stdout.write('PAUSED\n');await new Promise(resolve=>process.stdin.once('data',resolve));}return write.call(this,path,data,...rest);};syncBuiltinESMExports();
 const {createOutputPool}=await import(${JSON.stringify(new URL('../node/output-pool.ts',import.meta.url).href)});const {openOutputWriter}=await import(${JSON.stringify(new URL('../node/output-store.ts',import.meta.url).href)});const p=createOutputPool({root:${JSON.stringify(root)},nodeId:'node-test'});const lease=await p.lease(${JSON.stringify(sid(1))},${JSON.stringify(run(1))});
 try{await openOutputWriter(lease);process.stdout.write('UNEXPECTED-START\n');}catch{process.stdout.write('REJECTED\n');}process.stdin.destroy();
 `;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe']});t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');});let out='';
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('writer pause timeout')),5000);child.stdout.on('data',b=>{out+=b.toString();if(out.includes('PAUSED')){clearTimeout(timer);resolve();}});child.once('error',reject);});
 await pool.release(sid(1));assert.equal((await pool.references()).items[0]?.phase,'released');const exit=new Promise<number|null>(resolve=>child.once('close',resolve));child.stdin.end('resume\n');assert.equal(await exit,0);assert.match(out,/REJECTED/);assert.doesNotMatch(out,/UNEXPECTED-START/);await pool.reap(policy);
});


test('one managed root accounts old node reservations without granting old-source access',async t=>{
 const {root,pool:a}=await fixture(t);const la=await reserve(a);const wa=await openOutputWriter(la);await wa.finish(body(sid(1),'old protected'),'ready');const before=await a.capacity(policy,ext);
 const b=createOutputPool({root,nodeId:'node-new'});const tight={...policy,store_bytes:before.reserved_bytes};const count=await b.capacity(tight,ext);assert.equal(count.issue,undefined);assert.equal(count.reserved_bytes,before.reserved_bytes);assert.equal(count.other_node_reserved_bytes,before.reserved_bytes-16384);assert.equal(count.available_runs,0);assert.deepEqual((await b.references()).items,[]);
 await assert.rejects(()=>b.lease(sid(1),run(1)));await assert.rejects(()=>b.release(sid(1)));await assert.rejects(()=>b.abandon(sid(1),'foreign must not gain permission'));
 assert.equal((await b.readResult({source:sid(1),run_dir:run(1),offset:0,bytes:100})).state,'unavailable');assert.equal((await b.readCapture({source:sid(1),run_dir:run(1),stream:'stdout',offset:0,bytes:100})).state,'unavailable');
 assert.equal((await b.reserve({run_dir:run(2),spec:{version:1,source:sid(2),raw_bytes:policy.raw_bytes,result_bytes:policy.result_bytes}},tight,ext)).state,'capacity');
 await b.reap({...policy,retention_ms:0});assert.equal((await a.readResult({source:sid(1),run_dir:run(1),offset:0,bytes:100})).state,'ready');
 await reserve(b,2);assert.deepEqual((await b.references()).items.map(x=>x.source),[sid(2)]);assert.deepEqual((await a.references()).items.map(x=>x.source),[sid(1)]);assert.equal((await b.capacity(policy,ext)).reserved_bytes,2*before.reserved_bytes-16384);
});

test('invalid stored node identity remains unknown rather than becoming cross-node data',async t=>{
 const {root,pool}=await fixture(t);await reserve(pool);const path=join(root,sid(1),'lease.json'),data=JSON.parse(await readFile(path,'utf8'));data.lease.nodeId='';await writeFile(path,JSON.stringify(data));const b=createOutputPool({root,nodeId:'node-new'});assert.ok((await b.capacity(policy,ext)).issue);assert.equal((await b.capacity(policy,ext)).available_runs,0);assert.equal(JSON.parse(await readFile(path,'utf8')).lease.nodeId,'');
});


for(const boundary of ['partial','linked'])test(`managed root initialization survives ${boundary} owner publication SIGKILL`,async t=>{
 const {root}=await fixture(t);
 const script=String.raw`
 import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import {basename} from 'node:path';const boundary=${JSON.stringify(boundary)};
 const pause=async(where)=>{setInterval(()=>{},1000);await new Promise(r=>process.stdout.write(JSON.stringify({boundary:where})+'\n',r));await new Promise(()=>{});};
 const write=fs.writeFile,link=fs.link;
 fs.writeFile=async function(path,data,...rest){const name=basename(String(path));if(boundary==='partial'&&(name==='owner.json'||name.startsWith('owner.json.'))){const fd=await fs.open(path,'wx',0o600);await fd.write(Buffer.from(String(data)).subarray(0,10));await fd.sync();await fd.close();await pause('partial-owner-bytes-written');}return write.call(this,path,data,...rest);};
 fs.link=async function(from,to){const result=await link.call(this,from,to);if(boundary==='linked'&&basename(String(to))==='owner.json')await pause('owner-link-published');return result;};syncBuiltinESMExports();
 const {createOutputPool}=await import(${JSON.stringify(new URL('../node/output-pool.ts',import.meta.url).href)});await createOutputPool({root:${JSON.stringify(root)},nodeId:'node-test'}).capacity(${JSON.stringify(policy)},{bytes:0});await pause('initialization-returned-without-link');
 `;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');});let out='',err='';child.stderr.on('data',b=>err+=b.toString());
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('owner boundary timeout '+err)),5000);child.stdout.on('data',b=>{out+=b.toString();if(out.includes('\n')){clearTimeout(timer);resolve();}});child.once('error',reject);});const exit=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exit;
 const restarted=createOutputPool({root,nodeId:'node-test'}),capacity=await restarted.capacity(policy,ext);t.diagnostic(JSON.stringify({pid:child.pid,signal:child.signalCode,...JSON.parse(out.trim()),capacity}));assert.equal(capacity.issue,undefined);assert.ok(capacity.available_runs>0);assert.deepEqual((await restarted.references()).items,[]);
});

test('managed root does not overwrite unknown owner or an unknown initialization draft',async t=>{
 const {root,pool}=await fixture(t);const owner=join(root,'owner.json');await writeFile(owner,'foreign owner');assert.ok((await pool.capacity(policy,ext)).issue);assert.equal(await readFile(owner,'utf8'),'foreign owner');
 const other=await mkdtemp(join(tmpdir(),'tycho-owner-unknown-'));t.after(()=>rm(other,{recursive:true,force:true}));const draft=join(other,'owner.json.00000000-0000-4000-8000-000000000000.draft');await writeFile(draft,'not our metadata');assert.ok((await createOutputPool({root:other,nodeId:'node-test'}).capacity(policy,ext)).issue);assert.equal(await readFile(draft,'utf8'),'not our metadata');
});
