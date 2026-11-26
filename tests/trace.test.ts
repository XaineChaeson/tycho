// Prevents later edits, inputs or later Runs from being mistaken for what authorized a dispatch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { traceRun } from '../service/trace.ts';
import { DONE, fixture, LOGIN, USER, RUN_LIMIT_MS } from './helpers.ts';

test('message-created work points to its queue change and original message', (t) => {
  const f = fixture(t);
  f.ledger.setWhitelist({ console: ['user'] }, USER);
  const message = f.ledger.receiveMessage({ channel: 'console', externalId: 'request', actor: 'user', text: '开始这项工作' });
  const ctx = { actor: 'router', messageId: message.id };
  const task = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: '工作', goal: '完成', acceptance: '通过' }, ctx);
  f.ledger.queueTask(task.id, ctx);
  const input = f.ledger.addInput(task.id, '额外要求', USER);
  const run = f.ledger.createRun(task.id, { ...f.login, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: '原始目标', session_ref: 'previous-session' } }, USER);
  f.ledger.addInput(task.id, '下一轮的要求', USER);
  const trace = traceRun(f.ledger, run.id);
  assert.equal(trace.trigger.kind, 'message');
  assert.equal(trace.trigger.change?.action, 'task.queue');
  assert.equal(trace.trigger.message?.id, message.id);
  assert.equal(trace.trigger.message?.text, '开始这项工作');
  assert.deepEqual(trace.inputs.map(({ id }) => id), [input]);
  assert.equal(trace.session_ref, 'previous-session');
  assert.equal(trace.task_revision, 1);
  assert.deepEqual(trace.dispatchConditions, { paused: false, degraded: false, recovering: false, canDispatch: true });
  assert.equal(trace.changes.at(-1)?.action, 'run.create');
  assert.deepEqual(trace.changes.filter(({ action }) => action === 'run.create').map(({ run_id }) => run_id), [run.id]);
});

test('answered Approval points to the accepted answer even after a later task edit', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const approval = f.ledger.openApproval(task.id, [{ question: '继续吗？' }], USER);
  f.ledger.answerApproval(approval, ['继续'], 'user', 'console');
  f.ledger.updateTask(task.id, { title: '改标题' }, USER);
  const run = f.ledger.createRun(task.id, f.login, USER);
  const trace = traceRun(f.ledger, run.id);
  assert.equal(trace.trigger.kind, 'approval');
  assert.equal(trace.trigger.change?.action, 'approval.answer');
  assert.equal(JSON.parse(trace.trigger.change!.detail_json!).approval_id, approval);
  assert.match(trace.inputs[0]!.text, /继续/);
});

test('due reservation points to the wake change instead of the message that scheduled it', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  f.ledger.scheduleWake(task.id, '2026-01-01T00:00:00Z', USER);
  f.ledger.fireDueWakes(new Date('2026-01-01T01:00:00Z'));
  const run = f.ledger.createRun(task.id, f.login, USER);
  const trace = traceRun(f.ledger, run.id);
  assert.equal(trace.trigger.kind, 'timer');
  assert.equal(trace.trigger.change?.action, 'task.wake');
  assert.equal(trace.trigger.change?.actor, 'timer');
});

test('manual resume selects the right change for each historical Run', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const first = f.ledger.createRun(task.id, f.login, USER);
  f.ledger.markRunRunning(first.id);
  f.ledger.settleRun(first.id, 1, null);
  f.ledger.resumeTask(task.id, { actor: 'console' });
  const second = f.ledger.createRun(task.id, f.login, USER);
  assert.equal(traceRun(f.ledger, first.id).trigger.change?.action, 'task.queue');
  const trace = traceRun(f.ledger, second.id);
  assert.equal(trace.trigger.kind, 'resume');
  assert.equal(trace.trigger.change?.action, 'task.resume');
  assert.equal(trace.trigger.change?.actor, 'console');
});

test('old records with missing dispatch evidence remain explicitly unknown', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const run = f.ledger.createRun(task.id, f.login, USER);
  f.force("UPDATE change SET detail_json = '{}' WHERE action = 'run.create' AND run_id = ?", run.id);
  f.force("DELETE FROM change WHERE task_id = ? AND action = 'task.queue'", task.id);
  const trace = traceRun(f.ledger, run.id);
  assert.equal(trace.dispatchConditions, null);
  assert.equal(trace.trigger.kind, 'unknown');
  assert.equal(trace.trigger.tool_call, null);
  assert.throws(() => traceRun(f.ledger, 'missing'), /Run 不存在/);
});

test('settlement reports its own result notice through the Outbox', (t) => {
  const f = fixture(t);
  const task = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, title: '验证任务', goal: '验证', acceptance: '交报告' }, USER);
  f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(task.id, { ...f.login, snapshot: { ...f.login.snapshot, tier: 'operate' } }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, DONE);
  const delivery = () => traceRun(f.ledger, run.id).settlement;
  assert.equal(delivery()?.task_state, 'ready');
  assert.equal(delivery()?.delivery, 'pending');
  const notice = f.ledger.outbox.takeDue().find(({ kind }) => kind === 'work_ready');
  assert.ok(notice);
  f.ledger.outbox.markSent(notice.id);
  assert.equal(delivery()?.delivery, 'sent');
  f.ledger.reworkTask(task.id, '再测一次', f.ledger.getTask(task.id).revision, USER);
  assert.equal(delivery()?.task_state, 'ready', 'the settled round keeps its own state');
});
