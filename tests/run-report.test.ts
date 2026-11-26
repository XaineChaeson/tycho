// A final reply is a business delivery, not a retained diagnostic tail: settling,
// retrying or observing an old round must never replace it or notify twice.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { openLedger } from '../service/ledger.ts';
import { DONE, fixture, USER } from './helpers.ts';

const receipt = { ...DONE, artifacts: [{ kind: 'report', ref: '最后一条消息' }] };

test('adopted final reply is stored once with settlement and survives reopening without a node or diagnostics', (t) => {
  const f = fixture(t), { run, task } = f.runningRun();
  f.ledger.settleRun(run.id, 0, receipt, { finalReply: '完整分析原文\n' });
  const report = f.ledger.runReport(run.id)!;
  assert.equal(report.text, '完整分析原文\n');
  assert.equal(report.complete, true);
  assert.equal(report.source, 'settlement');
  assert.equal(report.run_id, run.id); assert.equal(report.task_id, task.id);
  const ledger = openLedger(join(f.dir, 'ledger.db'));
  try { assert.deepEqual(ledger.runReport(run.id), report); } finally { ledger.close(); }
});

test('a repeated settlement does not duplicate body, become late or send another result', (t) => {
  const f = fixture(t), { run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, receipt, { finalReply: '第一份原文' });
  const before = f.dump();
  f.ledger.settleRun(run.id, 0, receipt, { finalReply: '不应该覆盖的第二份原文' });
  assert.deepEqual(f.dump(), before);
  assert.equal(f.ledger.runReport(run.id)!.text, '第一份原文');
});

test('a lost round and its late reply never become the adopted final report, nor repeat large body in late_results', (t) => {
  const f = fixture(t), { run } = f.runningRun();
  f.ledger.settleRun(run.id, null, null, { kind: 'lost', lost: { basis: 'seen' } });
  f.ledger.settleRun(run.id, 0, receipt, { finalReply: 'LATE_BODY_MUST_NOT_BE_ADOPTED' });
  assert.equal(f.ledger.runReport(run.id), undefined);
  assert.doesNotMatch(f.ledger.getRun(run.id).error_json ?? '', /LATE_BODY/);
});

test('the business report is UTF-8 bounded, explicitly incomplete and masks authentication without hiding legitimate hashes', (t) => {
  const f = fixture(t), { run } = f.runningRun();
  const hash = 'a'.repeat(64);
  f.ledger.settleRun(run.id, 0, receipt, { finalReply: `Authorization: Bearer PRIVATE_CREDENTIAL\nsha256=${hash}\n` + '汉'.repeat(50_000) });
  const report = f.ledger.runReport(run.id)!;
  assert.ok(Buffer.byteLength(report.text) <= 128 * 1024);
  assert.equal(report.complete, false);
  assert.ok(report.original_bytes > report.bytes);
  assert.doesNotMatch(report.text, /PRIVATE_CREDENTIAL|�/);
  assert.match(report.text, new RegExp(hash));
});

test('a recovered report is a guarded idempotent observation, requiring the original completed receipt and project', (t) => {
  const f = fixture(t), { run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, receipt);
  const beforeTask = f.ledger.getTask(run.task_id), beforeRun = f.ledger.getRun(run.id);
  assert.throws(() => f.ledger.recordRecoveredRunReport(run.id, { ...receipt, summary: 'wrong' }, '不一致'), /回执/);
  const report = f.ledger.recordRecoveredRunReport(run.id, receipt, '历史原输出本次恢复')!;
  assert.equal(report.source, 'recovered');
  assert.deepEqual(f.ledger.getTask(run.task_id), beforeTask);
  assert.deepEqual(f.ledger.getRun(run.id), beforeRun);
  const after = f.dump();
  assert.deepEqual(f.ledger.recordRecoveredRunReport(run.id, receipt, '不会替换'), report);
  assert.deepEqual(f.dump(), after);
  assert.throws(() => f.ledger.runReport(run.id, 'another-project'), /项目/);
});


test('a first settlement rejected for an old task revision cannot be restored as adopted despite completed exit kind', t => {
  const f = fixture(t), { run, task } = f.runningRun();
  f.force('UPDATE task SET revision = revision + 1 WHERE id=?', task.id);
  const outcome = f.ledger.settleRun(run.id, 0, receipt);
  assert.deepEqual(outcome, { late: true, reason: 'revision' });
  assert.equal(f.ledger.getRun(run.id).exit_kind, 'completed');
  const before = f.dump();
  assert.throws(() => f.ledger.recordRecoveredRunReport(run.id, receipt, '被拒绝的旧修订原文'), /采用/);
  assert.deepEqual(f.dump(), before);
});


test('ordinary change projections expose report metadata only while the report owner retains the exact body', t => {
  const f=fixture(t),{run,task}=f.runningRun();
  f.ledger.settleRun(run.id,0,receipt,{finalReply:'ONLY_REPORT_READER_BODY'});
  const change=f.ledger.listChanges({taskId:task.id}).find(each=>each.action==='run.report')!;
  assert.doesNotMatch(change.detail_json!,/ONLY_REPORT_READER_BODY/);
  assert.equal(JSON.parse(change.detail_json!).sha256,f.ledger.runReport(run.id)!.sha256);
  assert.equal(f.ledger.runReport(run.id)!.text,'ONLY_REPORT_READER_BODY');
});


test('a file-report receipt never creates an inaccessible final-message report or history reference from the author final explanation', t => {
  const f=fixture(t),{run}=f.runningRun();
  const fileReceipt={...DONE,artifacts:[{kind:'report',ref:'report.md'}]};
  f.ledger.settleRun(run.id,0,fileReceipt,{finalReply:'不可冒充最后消息报告的独有词'});
  assert.equal(f.ledger.runReport(run.id),undefined);
  assert.deepEqual(f.ledger.searchHistoryEvidence(f.projectId,{query:'不可冒充最后消息报告的独有词'}).items,[]);
  assert.throws(()=>f.ledger.recordRecoveredRunReport(run.id,fileReceipt,'不可恢复成另一种报告'),/没有声明/);
});


for(const status of ['done','failed']) test('report body and '+status+' settlement share one rollback boundary',t=>{
  let fail=false;
  const f=fixture(t,{testHooks:{beforeCommit(actions){if(fail && actions.includes('run.report')) throw new Error('report transaction crash');}}});
  const {run}=f.runningRun();const before=f.dump();fail=true;
  assert.throws(()=>f.ledger.settleRun(run.id,0,{...receipt,status},{finalReply:'不得残留正文'}),/report transaction crash/);
  assert.deepEqual(f.dump(),before);
});

test('a corrupted or foreign first report record cannot be replaced by a recovery observation',t=>{
  const f=fixture(t),{run}=f.runningRun();f.ledger.settleRun(run.id,0,receipt,{finalReply:'first'});
  f.force("UPDATE change SET detail_json=? WHERE action='run.report' AND run_id=?",JSON.stringify({version:1,text:'corrupt'}),run.id);
  const before=f.dump();assert.throws(()=>f.ledger.recordRecoveredRunReport(run.id,receipt,'replacement'),/损坏/);assert.deepEqual(f.dump(),before);
});


test('permanent project deletion removes its report body instead of leaving an unowned audit orphan',t=>{
  const f=fixture(t),{run}=f.runningRun();f.ledger.settleRun(run.id,0,receipt,{finalReply:'DELETE_PROJECT_BODY_CANARY'});
  f.ledger.setProjectArchived(f.projectId,true,USER);f.ledger.deleteProject(f.projectId,'试跑',USER);
  assert.equal(f.peek("SELECT 1 FROM change WHERE detail_json LIKE '%DELETE_PROJECT_BODY_CANARY%'").length,0);
});

// Failed labels alone do not make a report adopted or recoverable.
for(const mode of ['lost','interrupted','quota','auth','never','nonzero','no-exit','malformed'] as const)test('failed report does not bypass the '+mode+' verdict',t=>{
 const f=fixture(t);f.ledger.putRole({...f.ledger.getRole('analyse')!,default_tier:'execute'},USER);const task=f.newTask({roleId:'analyse'});f.ledger.queueTask(task.id,USER);
 const run=f.ledger.createRun(task.id,{...f.login,snapshot:{...f.login.snapshot,tier:'execute',access:{permission:'read',layer:'tools',args:[]}}},USER);f.ledger.markRunRunning(run.id);
 const answer={...receipt,status:mode==='malformed'?'invalid':'failed'};
 f.ledger.settleRun(run.id,mode==='nonzero'?1:mode==='no-exit'?null:0,answer,{finalReply:'not an adopted report',codeCheck:{result:'same'},...(mode==='lost'||mode==='interrupted'||mode==='quota'||mode==='auth'?{kind:mode}:{}),...(mode==='never'?{workerNotStarted:'executable did not run'}:{})});
 assert.equal(f.ledger.runReport(run.id),undefined);const before=f.dump();assert.throws(()=>f.ledger.recordRecoveredRunReport(run.id,answer,'not a recovered report'),/没有采用/);assert.deepEqual(f.dump(),before);
});
test('advisory code-changed metadata does not discard an adopted failed report',t=>{
 const f=fixture(t);f.ledger.putRole({...f.ledger.getRole('analyse')!,default_tier:'execute'},USER);const task=f.newTask({roleId:'analyse'});f.ledger.queueTask(task.id,USER);
 const run=f.ledger.createRun(task.id,{...f.login,snapshot:{...f.login.snapshot,tier:'execute',access:{permission:'read',layer:'tools',args:[]}}},USER);f.ledger.markRunRunning(run.id);
 f.ledger.settleRun(run.id,0,{...receipt,status:'failed'},{finalReply:'diagnostic failed report',codeCheck:{result:'changed',changes:['synthetic modified file']}});
 assert.equal(f.ledger.runReport(run.id)?.text,'diagnostic failed report');
 assert.equal(JSON.parse(f.ledger.getRun(run.id).error_json!).code_check.result,'changed');
});
test('an adopted failed receipt recovers only its own report, idempotently without changing the failed Task',t=>{
 const f=fixture(t),{run,task}=f.runningRun(),answer={...receipt,status:'failed',summary:'the failed verdict'};f.ledger.settleRun(run.id,0,answer);
 const before=f.ledger.getTask(task.id);assert.throws(()=>f.ledger.recordRecoveredRunReport(run.id,{...answer,summary:'different receipt'},'wrong'),/回执/);
 const report=f.ledger.recordRecoveredRunReport(run.id,answer,'exact failed report');assert.equal(report.text,'exact failed report');assert.equal(report.source,'recovered');assert.deepEqual(f.ledger.getTask(task.id),before);assert.equal(before.state,'held');
 assert.deepEqual(f.ledger.recordRecoveredRunReport(run.id,answer,'late replacement'),report);
});
