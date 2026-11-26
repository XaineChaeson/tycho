// Output admission belongs to new work, not executor connectivity; pinned waits stay visible.
import './guard.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import type {Login} from '../runner/snapshot.ts';
import {createDispatcher} from '../service/dispatcher.ts';
import {claudeAdapter} from '../adapters/claude.ts';
import {waitLine} from '../shared/labels.ts';
import {fixture,memoryLogins,DISPATCH_TUNED,USER,claudeTier,OUTPUT_AVAILABLE,signedInEverywhere,tuned,memoryMachines,testMachine,RUNNER_TUNED,LOGIN} from './helpers.ts';
import {stage,signIn} from './stage.ts';
import {createRunner} from '../runner/runner.ts';
import {Unreachable} from '../runner/host.ts';
import {fakeRemote} from './fake-remote.ts';
const account={id:'t1',name:'t1',executor:'claude',tiers:{execute:claudeTier('/tiers/execute.json')}};

test('public dispatcher exposes pinned online output wait and resumes when capacity returns',async t=>{
 const f=fixture(t);let ready=false;const launched:string[]=[];
 const logins=memoryLogins({t1:{...account}},f.ledger),machine=f.ledger.getMachine('h1')!;
 f.ledger.setProjectSources(f.projectId,[{kind:'folder',machine_uid:machine.uid,path:'/qa/pinned'}],USER);
 const task=f.ledger.createTask({projectId:f.projectId,title:'任务',goal:'目标',acceptance:'测试通过',roleId:'implement',loginId:'t1'},USER);f.ledger.queueTask(task.id,USER);
 const dispatcher=createDispatcher({...DISPATCH_TUNED,runTimeoutMs:tuned('run.timeoutMs'),ledger:f.ledger,logins,machines:{get:f.ledger.getMachine,list:f.ledger.listMachines},executors:{claude:claudeAdapter},outputReady:()=>ready,connected:()=>true,
 runner:{findMachine:async(_login,candidates)=>candidates[0],lostCandidates:()=>[],presume:async()=> 'unknown',sweep:async()=>{},launch:async run=>{launched.push(run.id);},watch:async()=>{}},log:()=>{}});
 t.after(()=>dispatcher.stop());await dispatcher.tick();assert.equal(f.task(task.id).state,'queued');assert.equal(launched.length,0);
 const wait=dispatcher.waitOf(f.task(task.id));t.diagnostic(JSON.stringify({wait}));assert.deepEqual(wait?.output_waiting,['h1']);assert.match(waitLine(wait!)??'',/输出/);
 ready=true;await dispatcher.tick();assert.equal(launched.length,1);assert.equal(f.task(task.id).state,'running');t.diagnostic(JSON.stringify({pinned_task_id:task.id,capacity_restored:true,created_run_id:launched[0],machine_id:f.run(launched[0]!).machine_id,capture_source:JSON.parse(f.run(launched[0]!).snapshot_json).output_capture.source}));
});

test('normal service task GET shows the pinned output wait while connected',async t=>{
 let ready=false;const s=stage(t,{t1:{...account}},['h1']);const service=await s.start({reportedOutput:()=>({...OUTPUT_AVAILABLE,capacity:{...OUTPUT_AVAILABLE.capacity,available_runs:ready?1:0}})});
 const machine=service.ledger.getMachine('h1')!,controller=new AbortController();const poll=service.nodes.poll('h1',{facts:{node_id:machine.nodeId!,name:'h1',hostname:'h1',platform:'test'},runs:[]},controller.signal);
 try{
  assert.equal(service.nodes.connected('h1'),true);const project=s.project(service);service.ledger.setProjectSources(project,[{kind:'folder',machine_uid:machine.uid,path:'/qa/pinned'}],USER);const task=s.queued(service);const c=await signIn(service),response=await c.get('/api/tasks/'+task.id),body=await response.json() as any;
  assert.equal(response.status,200);assert.equal(body.task.state,'queued');assert.deepEqual(service.ledger.listRuns(task.id),[]);t.diagnostic(JSON.stringify({waiting:body.task.waiting}));assert.deepEqual(body.task.waiting?.output_waiting,['h1']);assert.match(waitLine(body.task.waiting)??'',/输出/);
  ready=true;const launched=await s.launched(service,task);const after=await (await c.get('/api/tasks/'+task.id)).json() as any;assert.equal(after.task.state,'running');t.diagnostic(JSON.stringify({pinned_http_task_id:task.id,capacity_restored:true,created_run_id:launched.id,machine_id:launched.machine_id,task_state:after.task.state}));
 }finally{controller.abort();await poll;}
});

test('normal service connection check succeeds with executor facts even when output capacity is zero',async t=>{
 const s=stage(t,{t1:{...account}},['h1']);const service=await s.start({reportedOutput:()=>({...OUTPUT_AVAILABLE,capacity:{...OUTPUT_AVAILABLE.capacity,available_runs:0}})});
 const machine=service.ledger.getMachine('h1')!,controller=new AbortController(),report=signedInEverywhere()()!;
 const poll=service.nodes.poll('h1',{facts:{node_id:machine.nodeId!,name:'h1',hostname:'h1',platform:'test'},runs:[],executors:report},controller.signal);
 try{
  const checking=service.runner.check(service.accounts.get('t1')!);const first=await Promise.race([checking.then(answer=>({kind:'answer' as const,answer})),poll.then(command=>({kind:'command' as const,command}))]);
  if(first.kind==='answer'){t.diagnostic(JSON.stringify({check:first.answer}));assert.notEqual(first.answer,null,'capacity must not remove an otherwise checkable executor');}
  else{assert.ok(first.command);service.nodes.report('h1',first.command.id,true,report);}
  const answer=await checking;assert.equal(answer?.machine_id,'h1');assert.equal(answer?.reachable,true);assert.equal(answer?.logged_in,null,'an account check does not claim the machine login authenticates its token');assert.equal(answer?.version,report.executors.find(each=>each.executor==='claude')!.version);t.diagnostic(JSON.stringify({check:answer}));assert.equal(service.ledger.listActiveRuns().length,0);
 }finally{controller.abort();await poll;}
});


test('rehost admission remains independent of executor capability and does not exceed capacity',async t=>{
 const f=fixture(t),remote=fakeRemote(),placed:string[]=[];
 const machines=memoryMachines({h1:testMachine('h1'),h2:testMachine('h2')},f.ledger);
 const logins=memoryLogins({t1:{...account}},f.ledger),login=logins.get('t1')!,machine=f.ledger.getMachine('h1')!;
 const task=f.ledger.createTask({projectId:f.projectId,title:'任务',goal:'目标',acceptance:'测试通过',roleId:'implement',loginId:'t1'},USER);f.ledger.queueTask(task.id,USER);
 const ref=f.ledger.accountCredentialRef('t1')!;
 const run=f.ledger.createRun(task.id,{login,machine,expectedRevision:task.revision,snapshot:{...LOGIN.snapshot,executor:'claude',credential_ref:ref}},USER);
 const runner=createRunner({...RUNNER_TUNED,ledger:f.ledger,adapters:{claude:claudeAdapter},logins,machines,outputReady:()=>false,fits:()=>true,credential:()=>({ref,value:'qa-fixture-token'}),connect:machine=>{
  const host=remote.connect(machine);return {...host,place:async(...args)=>{placed.push(machine.id);if(machine.id==='h1')throw new Unreachable('QA initial transfer failed');return host.place(...args);}};
 }});
 await runner.launch(run);assert.deepEqual(placed,['h1'],'the initial attempt happened, but a full alternate machine was not prepared');assert.equal(f.run(run.id).machine_id,'h1');assert.equal(remote.called('start.sh',run.id),0);assert.equal(f.run(run.id).exit_kind,'lost');t.diagnostic(JSON.stringify({rehost_control:{prepares:placed,alternate_capacity:false,starts:remote.called('start.sh',run.id),final_machine:f.run(run.id).machine_id}}));
});


function alternatives(t:TestContext,options:{own?:boolean;fullSecond?:boolean;pinned?:boolean;installed?:boolean;connected?:boolean;ready?:(id:string)=>boolean}={}){
 const f=fixture(t),machines=memoryMachines({h1:testMachine('h1'),h2:testMachine('h2')},f.ledger),launched:string[]=[];
 const records:Record<string,Login>=options.own?{a:{...account,id:'a',name:'a',machine:'h1'},b:{...account,id:'b',name:'b',machine:'h2',maxRuns:1}}:{t1:{...account}};
 const logins=memoryLogins(records,f.ledger),project=f.ledger.createProject({name:'候选路径',logins:logins.list().map(login=>login.id)},USER);
 if(options.pinned)f.ledger.setProjectSources(project,[{kind:'folder',machine_uid:f.ledger.getMachine('h1')!.uid,path:'/qa/h1'}],USER);
 if(options.fullSecond){
  const login=logins.list().find(login=>login.machine==='h2')!,busy=f.ledger.createTask({projectId:project,title:'占用第二登录',goal:'目标',acceptance:'验收',roleId:'implement',loginId:login.id},USER);f.ledger.queueTask(busy.id,USER);
  const run=f.ledger.createRun(busy.id,{login,machine:f.ledger.getMachine('h2')!,snapshot:LOGIN.snapshot,expectedRevision:busy.revision},USER);f.ledger.markRunRunning(run.id);
 }
 const report=signedInEverywhere()(),status=report.executors.find(each=>each.executor==='claude')!;
 const dispatcher=createDispatcher({...DISPATCH_TUNED,runTimeoutMs:tuned('run.timeoutMs'),ledger:f.ledger,logins,machines,executors:{claude:claudeAdapter},
  connected:()=>options.connected!==false,outputReady:options.ready??(id=>id==='h1'),reported:()=>({...status,installed:options.installed!==false,asked_at:report.at}),
  runner:{findMachine:async(_login,candidates)=>options.connected===false?undefined:candidates[0],lostCandidates:()=>[],presume:async()=> 'unknown',sweep:async()=>{},launch:async run=>{launched.push(run.id);},watch:async()=>{}},log:()=>{}});
 t.after(()=>dispatcher.stop());const task=f.ledger.createTask({projectId:project,title:'候选任务',goal:'目标',acceptance:'验收',roleId:'implement'},USER);f.ledger.queueTask(task.id,USER);return {f,dispatcher,task,launched};
}

for(const options of [{},{pinned:true},{own:true,fullSecond:true}])test(`a usable output path is not polluted by an unusable alternative ${JSON.stringify(options)}`,async t=>{
 const w=alternatives(t,options),wait=w.dispatcher.waitOf(w.f.task(w.task.id));t.diagnostic(JSON.stringify({reverse_options:options,wait}));assert.equal(wait,null);
 await w.dispatcher.tick();assert.equal(w.launched.length,1);assert.equal(w.f.run(w.launched[0]!).machine_id,'h1');
});

test('unknown executor availability is not mislabeled as output capacity',async t=>{
 const w=alternatives(t,{installed:false}),wait=w.dispatcher.waitOf(w.f.task(w.task.id));t.diagnostic(JSON.stringify({unusable_executor_wait:wait}));assert.equal(wait?.output_waiting,undefined);
 await w.dispatcher.tick();assert.equal(w.launched.length,0);assert.equal(w.dispatcher.waitOf(w.f.task(w.task.id))?.output_waiting,undefined);
});

test('no connected machine preserves the machine wait instead of adding output blame',async t=>{
 const w=alternatives(t,{connected:false,ready:()=>false});await w.dispatcher.tick();const wait=w.dispatcher.waitOf(w.f.task(w.task.id));t.diagnostic(JSON.stringify({offline_wait:wait}));assert.equal(wait?.output_waiting,undefined);assert.ok(wait?.no_machine.length);assert.equal(w.launched.length,0);
});
