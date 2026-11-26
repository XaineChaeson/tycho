import './guard.ts';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAcceptor, reviewArtifactSnapshot } from '../service/accept.ts';
import { readRunReport } from '../service/reports.ts';
import { createTools } from '../service/tools.ts';
import { prepareSnapshot } from '../runner/snapshot.ts';
import { snapshotSourceOf } from '../shared/sources.ts';
import { ADAPTERS } from '../adapters/all.ts';
import { FINAL_MESSAGE_REF } from '../shared/report.ts';
import { DONE, fixture, USER, RUN_LIMIT_MS, memoryLogins } from './helpers.ts';

const receipt = { ...DONE, artifacts: [{ kind: 'report', ref: FINAL_MESSAGE_REF }] };

test('a repository-backed read-only report uses the public review registration and delivers its bound formal body, not an unreported commit', async t => {
  const f=fixture(t);
  f.ledger.putRole({...f.ledger.getRole('analyse')!,default_tier:'execute'},USER);
  f.ledger.setProjectSources(f.projectId,[{kind:'repo',url:'https://example.test/project.git',branch:'main'}],USER);
  const source=f.ledger.projectSourceViews(f.projectId).sources[0]!;
  const task=f.newTask({roleId:'analyse'});
  f.ledger.queueTask(task.id,USER);
  const run=f.ledger.createRun(task.id,{...f.login,snapshot:{...f.login.snapshot,tier:'execute',access:{permission:'read',layer:'tools',args:[]},source:snapshotSourceOf(source)}},USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id,0,receipt,{finalReply:'正式的分析交付物',codeCheck:{result:'same'}});
  const accept=createAcceptor({ledger:f.ledger,dataDir:f.dir,runner:{fetchArtifacts:async()=>({files:[],problem:null})}});
  const registered=await accept.register(task.id);
  assert.equal(registered.reviewed,null);
  const review=f.ledger.createTask({projectId:f.projectId,title:'审阅分析',goal:'核对报告',roleId:'review',reviewOf:{taskId:task.id,...registered}},USER);
  const binding=JSON.parse(review.review_of_json!);
  const report=f.ledger.runReport(run.id)!;
  assert.deepEqual(binding.report,{id:report.id,sha256:report.sha256,bytes:report.bytes,complete:true});
  assert.equal(binding.reviewed,undefined);
  assert.deepEqual(f.ledger.currentProduct(task.id).report,binding.report);
  assert.ok(!JSON.stringify(f.ledger.currentProduct(task.id)).includes(report.text));
  const copy=reviewArtifactSnapshot(f.dir,f.ledger.artifactsOfRun(run.id),binding,report);
  assert.equal(copy.find(file=>file.path==='review-files/final-message.md')?.text,report.text);
  const snapshot=prepareSnapshot(review,f.login.login,ADAPTERS,{timeoutMs:RUN_LIMIT_MS,permission:'read',source:snapshotSourceOf(source)});
  assert.equal(snapshot.review_artifacts?.report?.id,report.id);
  assert.match(snapshot.brief,/正式报告：见本文件同目录 `review-files\/manifest\.md`/);
  assert.ok(!JSON.stringify(snapshot).includes(report.text));
  assert.equal(reviewArtifactSnapshot(f.dir,f.ledger.artifactsOfRun(run.id),{...binding,report:undefined},report).some(file=>file.path.endsWith('final-message.md')),false,'code review does not receive author narrative');
  assert.equal(reviewArtifactSnapshot(f.dir,f.ledger.artifactsOfRun(run.id),binding,{...report,run_id:'other'}).some(file=>file.path.endsWith('final-message.md')),false);
});

test('public review registration is best-effort for unavailable and truncated final-report deliveries', async t => {
  for(const text of [undefined,'汉'.repeat(50_000)]) {
    const f=fixture(t);f.ledger.putRole({...f.ledger.getRole('analyse')!,default_tier:'execute'},USER);const task=f.newTask({roleId:'analyse'});f.ledger.queueTask(task.id,USER);
    const run=f.ledger.createRun(task.id,{...f.login,snapshot:{...f.login.snapshot,tier:'execute',access:{permission:'read',layer:'tools',args:[]}}},USER);f.ledger.markRunRunning(run.id);
    f.ledger.settleRun(run.id,0,receipt,{...(text===undefined?{}:{finalReply:text}),codeCheck:{result:'same'}});
    const accept=createAcceptor({ledger:f.ledger,dataDir:f.dir,runner:{fetchArtifacts:async()=>({files:[],problem:null})}});
    const registered=await accept.register(task.id);
    assert.equal(registered.runId,run.id);
    assert.ok(f.ledger.artifactsOfRun(run.id)?.registration);
    if (text === undefined) {
      await assert.rejects(readRunReport({ run: f.ledger.getRun(run.id), ref: FINAL_MESSAGE_REF, dataDir: f.dir, held: f.ledger.artifactsOfRun(run.id), finalMessage: f.ledger.runReport(run.id) }), /未保存/);
    } else {
      const read = await readRunReport({ run: f.ledger.getRun(run.id), ref: FINAL_MESSAGE_REF, dataDir: f.dir, held: f.ledger.artifactsOfRun(run.id), finalMessage: f.ledger.runReport(run.id) });
      assert.equal(read.complete, false);
    }
  }
});

test('project-scoped tools explicitly read the same report and only expose metadata from get_task', async t => {
  const f=fixture(t),{run,task}=f.runningRun();
  f.ledger.settleRun(run.id,0,receipt,{finalReply:'EXPLICIT_BODY_ONLY'});
  let calls=0;
  const tools=createTools({ledger:f.ledger,runner:{interrupt:async()=> 'ended',abandon:async()=>{},events:()=>[]},logins:memoryLogins({own:f.login.login}),machines:{list:f.ledger.listMachines},accept:createAcceptor({ledger:f.ledger,dataDir:f.dir}),readReport:(run,ref)=>{calls++;return readRunReport({run,ref,dataDir:f.dir,held:f.ledger.artifactsOfRun(run.id),finalMessage:f.ledger.runReport(run.id)});}});
  const call=(name:string,args:unknown,projectId=f.projectId)=>tools.call(name,args,{actor:'router'},{projectId});
  const metadata=await call('get_task',{task_id:task.id});
  assert.doesNotMatch(JSON.stringify(metadata),/EXPLICIT_BODY_ONLY/);
  assert.match(JSON.stringify(metadata),/report_files/);
  const own=await call('get_run_report',{run_id:run.id,ref:FINAL_MESSAGE_REF});
  assert.equal(own.isError,undefined);assert.match(JSON.stringify(own),/EXPLICIT_BODY_ONLY/);
  const other=f.ledger.createProject({name:'other',loginMode:'all'},USER);
  const denied=await call('get_run_report',{run_id:run.id,ref:FINAL_MESSAGE_REF},other);
  assert.equal(denied.isError,true);assert.equal(calls,1,'scope is checked before any report read/recovery');
});
// Review registration is best-effort and fetches artifacts/ even on read-only runs.
test('review registration proceeds best-effort for absent, unsupported and read-only file report refs', async t => {
  for (const refs of [[], ['本条最终消息中的核验报告'], ['artifacts/report.md']]) {
    const f = fixture(t);
    f.ledger.putRole({ ...f.ledger.getRole('analyse')!, default_tier: 'execute' }, USER);
    const task = f.newTask({ roleId: 'analyse' }); f.ledger.queueTask(task.id, USER);
    const run = f.ledger.createRun(task.id, { ...f.login, snapshot: { ...f.login.snapshot, tier: 'execute', access: { permission: 'read', layer: 'tools', args: [] } } }, USER);
    f.ledger.markRunRunning(run.id);
    f.ledger.settleRun(run.id, 0, receipt, { finalReply: '正文内容', codeCheck: { result: 'same' } });
    f.force('UPDATE run SET receipt_json=? WHERE id=?', JSON.stringify({ ...DONE, artifacts: refs.map(ref => ({ kind: 'report', ref })) }), run.id);
    let fetches = 0;
    const accept = createAcceptor({ ledger: f.ledger, dataDir: f.dir, runner: { fetchArtifacts: async () => { fetches++; return { files: [], problem: null }; } } });
    const registered = await accept.register(task.id);
    assert.equal(fetches, 1);
    assert.equal(registered.runId, run.id);
    assert.ok(f.ledger.artifactsOfRun(run.id)?.registration);
  }
});

test('a writable report reference without its actual file registers best-effort and owner acceptance retains its own semantics', async t => {
  const f = fixture(t);
  f.ledger.putRole({ ...f.ledger.getRole('verify')!, default_tier: 'execute' }, USER);
  const task = f.newTask({ roleId: 'verify' }); f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(task.id, f.login, USER); f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, { ...DONE, artifacts: [{ kind: 'report', ref: 'artifacts/report.md' }] });
  let fetches = 0;
  const accept = createAcceptor({ ledger: f.ledger, dataDir: f.dir, runner: { fetchArtifacts: async () => { fetches++; return { files: [], problem: null }; } } });
  const registered = await accept.register(task.id);
  assert.equal(fetches, 1);
  assert.equal(registered.runId, run.id);
  assert.ok(f.ledger.artifactsOfRun(run.id)?.registration);
  await accept.accept(task.id, '主人自行核实并验收', USER);
  assert.equal(f.ledger.getTask(task.id).state, 'done');
});

test('a real writable file report still registers and delivers its exact bound text to review', async t => {
  const f = fixture(t);
  f.ledger.putRole({ ...f.ledger.getRole('verify')!, default_tier: 'execute' }, USER);
  const task = f.newTask({ roleId: 'verify' }); f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(task.id, f.login, USER); f.ledger.markRunRunning(run.id);
  const ref = 'artifacts/report.md';
  f.ledger.settleRun(run.id, 0, { ...DONE, artifacts: [{ kind: 'report', ref }] });
  const body = Buffer.from('实际的文件报告正文');
  const file = { name: 'report.md', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  const accept = createAcceptor({ ledger: f.ledger, dataDir: f.dir, runner: { fetchArtifacts: async (_run, into) => {
    writeFileSync(join(into, file.name), body); return { files: [file], problem: null };
  } } });
  const registered = await accept.register(task.id);
  const review = f.ledger.createTask({ projectId: f.projectId, title: '审阅文件报告', goal: '核对报告', roleId: 'review', reviewOf: { taskId: task.id, ...registered } }, USER);
  const binding = JSON.parse(review.review_of_json!);
  assert.deepEqual(binding.files, [file]);
  assert.equal(reviewArtifactSnapshot(f.dir, f.ledger.artifactsOfRun(run.id), binding).find(file => file.path === 'review-files/files/report.md')?.text, body.toString());
  assert.equal((await readRunReport({ run: f.ledger.getRun(run.id), ref, dataDir: f.dir, held: f.ledger.artifactsOfRun(run.id) })).text, body.toString());
});

// Console preview and automatic snapshot budgets do not limit real file report delivery.
test('large and non-UTF8 real file reports still bind independent review while preview reports its limits', async t => {
  for (const body of [Buffer.from([0xff]), Buffer.alloc(128 * 1024 + 1)]) {
    const f = fixture(t);
    f.ledger.putRole({ ...f.ledger.getRole('verify')!, default_tier: 'execute' }, USER);
    const task = f.newTask({ roleId: 'verify' }); f.ledger.queueTask(task.id, USER);
    const run = f.ledger.createRun(task.id, f.login, USER); f.ledger.markRunRunning(run.id);
    f.ledger.settleRun(run.id, 0, { ...DONE, artifacts: [{ kind: 'report', ref: 'report.md' }] });
    const file = { name: 'report.md', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
    const accept = createAcceptor({ ledger: f.ledger, dataDir: f.dir, runner: { fetchArtifacts: async (_run, into) => {
      writeFileSync(join(into, 'report.md'), body);
      return { files: [file], problem: null };
    } } });
    const registered = await accept.register(task.id);
    const review = f.ledger.createTask({ projectId: f.projectId, title: '审阅真实文件', goal: '核对报告', roleId: 'review', reviewOf: { taskId: task.id, ...registered } }, USER);
    assert.deepEqual(JSON.parse(review.review_of_json!).files, [file]);
    await assert.rejects(readRunReport({ run: f.ledger.getRun(run.id), ref: 'report.md', dataDir: f.dir, held: f.ledger.artifactsOfRun(run.id) }), /UTF-8|上限/);
    assert.equal(f.ledger.artifactsOfRun(run.id)?.problem, null);
  }
});

// Failed business verdicts may still deliver the report the Owner needs to diagnose them.
for(const captured of [true,false]) test('Owner reads an adopted failed report through normal HTTP, with '+(captured?'capture evidence':'only the direct finalReply')+', while Task stays held',async t=>{
 const {consoleApp}=await import('./console-helpers.ts');
 const f=fixture(t);f.ledger.putRole({...f.ledger.getRole('analyse')!,default_tier:'execute'},USER);
 const task=f.newTask({roleId:'analyse'});f.ledger.queueTask(task.id,USER);
 const run=f.ledger.createRun(task.id,{...f.login,snapshot:{...f.login.snapshot,tier:'execute',access:{permission:'read',layer:'tools',args:[]}}},USER);f.ledger.markRunRunning(run.id);
 const spec=JSON.parse(run.snapshot_json).output_capture,body='实际失败原因与核验结果，仍是主人要读的报告';
 const answer={status:'failed',summary:'核验失败，原因见报告',artifacts:[{kind:'report',ref:FINAL_MESSAGE_REF}]};
 f.ledger.settleRun(run.id,0,answer,{finalReply:body,codeCheck:{result:'same'},...(captured?{captureResult:{source:spec.source,complete:true,ref:{version:1 as const,source:spec.source,state:'ready' as const,size:123,sha256:'b'.repeat(64)}}}:{})});
 const before=f.ledger.getTask(task.id),app=await consoleApp(t,{f});
 const detail=await app.get('/api/tasks/'+task.id);assert.equal(detail.status,200);const metadata=await detail.text();
 const response=await app.get('/api/runs/'+run.id+'/report?ref='+encodeURIComponent(FINAL_MESSAGE_REF));const raw=await response.text();
 console.log(JSON.stringify({probe:'failed Owner report',status:response.status,raw}));assert.equal(response.status,200,raw);
 const read=JSON.parse(raw);assert.equal(read.text,body);assert.equal(read.source,'settlement');assert.equal(read.complete,true);
 assert.equal(before.state,'held');assert.equal(before.reason,answer.summary);assert.deepEqual(f.ledger.getTask(task.id),before);
 assert.match(metadata,/"state":"saved"/);assert.equal(JSON.parse(f.run(run.id).capture_result_json!).disposition,captured?'adopted':'not_adopted');
 assert.equal(f.ledger.outputRelease(run.id,spec.source,run.machine_id!,run.node_id!),true);
});
