// Guards against: an Input delivered to two Runs, an Input marked attached but
// missing from what was actually sent, an Input's receipt left for the Router to take
// instead of a record only, and a timer firing twice or waking a Task that was already closed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputError } from '../service/errors.ts';
import { fixture, LOGIN, USER } from './helpers.ts';

test('createRun binds queued inputs and records them in the snapshot', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const inputId = f.ledger.addInput(task.id, '顺便改下日志', USER);
  const run = f.ledger.createRun(task.id, f.login, USER);
  const [input] = f.peek<{ state: string; run_id: string }>('SELECT * FROM input WHERE id = ?', inputId);
  assert.equal(input!.state, 'attached');
  assert.equal(input!.run_id, run.id);
  assert.deepEqual(JSON.parse(run.snapshot_json).inputs.map((i: { id: string }) => i.id), [inputId]);
  assert.equal(JSON.parse(run.snapshot_json).inputs[0].text, '顺便改下日志');
});

test('an attached input is not bound again by the next Run', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const inputId = f.ledger.addInput(task.id, '只说一次', USER);
  const first = f.ledger.createRun(task.id, f.login, USER);
  f.ledger.settleRun(first.id, 1, null);
  f.ledger.resumeTask(task.id, USER);
  const second = f.ledger.createRun(task.id, f.login, USER);
  const [input] = f.peek<{ run_id: string }>('SELECT * FROM input WHERE id = ?', inputId);
  assert.equal(input!.run_id, first.id);
  assert.deepEqual(JSON.parse(second.snapshot_json).inputs, []);
});

test('a voided input is not delivered; an attached one cannot be voided', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const dropped = f.ledger.addInput(task.id, '算了', USER);
  f.ledger.voidInput(dropped, USER);
  assert.throws(() => f.ledger.voidInput(dropped, USER), InputError);
  const kept = f.ledger.addInput(task.id, '要的', USER);
  const run = f.ledger.createRun(task.id, f.login, USER);
  assert.deepEqual(JSON.parse(run.snapshot_json).inputs.map((i: { id: string }) => i.id), [kept]);
  assert.throws(() => f.ledger.voidInput(kept, USER), InputError);
});

test('addInput refuses a closed Task', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  f.ledger.abandonTask(task.id, '不要了', USER);
  assert.throws(() => f.ledger.addInput(task.id, '还有', USER), InputError);
});

// The receipt is a record only: the next Run takes the input with its snapshot, so the Router is
// not woken for it (the row stays out of its queue as an event of no project's would).
test('addInput leaves an ignored internal message in the same transaction', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const inputId = f.ledger.addInput(task.id, '顺便改下日志', USER);
  const [message] = f.peek<{ channel: string; direction: string; state: string; actor: string; text: string }>(
    `SELECT * FROM message WHERE external_id = ?`,
    `input:${inputId}`,
  );
  assert.equal(message!.channel, 'internal');
  assert.equal(message!.direction, 'in');
  assert.equal(message!.state, 'ignored');
  assert.equal(f.ledger.takeNextTurn(f.projectId), undefined, '不投给负责人');
  assert.equal(message!.actor, 'user');
  const detail = JSON.parse(message!.text.slice(message!.text.indexOf('\n') + 1));
  assert.deepEqual(detail, { task_id: task.id, input_id: inputId, text: '顺便改下日志' });

  assert.throws(() => f.ledger.addInput(task.id, '回滚', { actor: 'user', messageId: 'no-such-message' }), /FOREIGN KEY/);
  assert.equal(f.count('message'), 1);
  assert.equal(f.count('input'), 1);
});

test('due wake queues the Task exactly once', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  f.ledger.scheduleWake(task.id, '2030-01-01T00:00:00Z', USER);
  assert.deepEqual(f.ledger.fireDueWakes(new Date('2029-12-31T23:59:59Z')), []);
  assert.equal(f.task(task.id).state, 'waiting_timer');

  const later = new Date('2030-01-01T00:00:00Z');
  assert.deepEqual(f.ledger.fireDueWakes(later), [task.id]);
  assert.equal(f.task(task.id).state, 'queued');
  assert.equal(f.task(task.id).wake_at, null);
  assert.deepEqual(f.ledger.fireDueWakes(later), []);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'task.wake'`).length, 1);
});

test('wake does not touch an abandoned Task', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  f.ledger.scheduleWake(task.id, '2030-01-01T00:00:00Z', USER);
  f.ledger.abandonTask(task.id, '不要了', USER);
  // Even if the timer column were left behind, state decides.
  f.force(`UPDATE task SET wake_at = '2030-01-01T00:00:00.000Z' WHERE id = ?`, task.id);
  assert.deepEqual(f.ledger.fireDueWakes(new Date('2031-01-01T00:00:00Z')), []);
  assert.equal(f.task(task.id).state, 'abandoned');
});

test('rescheduling replaces the wake', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  f.ledger.scheduleWake(task.id, '2030-01-01T00:00:00Z', USER);
  f.ledger.scheduleWake(task.id, '2030-06-01T00:00:00Z', USER);
  assert.deepEqual(f.ledger.fireDueWakes(new Date('2030-02-01T00:00:00Z')), []);
});

test('scheduleWake refuses a time without a zone', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  assert.throws(() => f.ledger.scheduleWake(task.id, '2030-01-01T00:00:00', USER), InputError);
  assert.throws(() => f.ledger.scheduleWake(task.id, '明天', USER), InputError);
});

test('continueTask on running task queues input and settleRun auto-continues into queued instead of ready', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();

  const res = f.ledger.continueTask(task.id, '把边界用例也补上', undefined, USER);
  assert.equal(res.queued, true);
  assert.equal(res.active, true);
  assert.equal(f.task(task.id).state, 'running');

  const [msg] = f.peek<{ state: string; text: string }>(`SELECT state, text FROM message WHERE external_id = ?`, `input:${res.id}`);
  assert.equal(msg?.state, 'ignored');
  assert.match(msg?.text ?? '', /本轮结束后自动续跑/);

  const settled = f.ledger.settleRun(run.id, 0, { status: 'done', summary: '第一轮完成' }, { sessionRef: 's-cont' });
  assert.deepEqual(settled, { late: false, task_state: 'queued' });
  assert.equal(f.task(task.id).state, 'queued');
  assert.equal(f.peek(`SELECT 1 FROM change WHERE task_id = ? AND action = 'task.auto_continue'`, task.id).length, 1);

  // Next run picks up the queued input
  const nextRun = f.ledger.createRun(task.id, f.login, USER);
  assert.deepEqual(JSON.parse(nextRun.snapshot_json).inputs, [{ id: res.id, text: '把边界用例也补上' }]);
});

test('listRecentResumableTasks returns recent done tasks with session_ref and excludes review/knowledge/non-session tasks', (t) => {
  const f = fixture(t);

  // 1. Eligible done task with session_ref
  const t1 = f.runningRun();
  f.ledger.settleRun(t1.run.id, 0, { status: 'done', summary: '第一项总结' }, { sessionRef: 'sess-1' });
  f.ledger.acceptTask(t1.task.id, 'ok', USER, { withoutReview: true });

  // 2. Done task WITHOUT session_ref -> excluded
  const tNoSession = f.runningRun();
  f.ledger.settleRun(tNoSession.run.id, 0, { status: 'done', summary: '无会话' });
  f.ledger.acceptTask(tNoSession.task.id, 'ok', USER, { withoutReview: true });

  // 3. Review task (done, with session_ref) -> excluded
  const tReview = f.runningRun();
  f.force('UPDATE task SET review_of_json = ? WHERE id = ?', JSON.stringify({ task_id: t1.task.id, run_id: t1.run.id, revision: 1, files: [], writers: ['claude'] }), tReview.task.id);
  f.ledger.settleRun(tReview.run.id, 0, { status: 'done', summary: '审阅通过', verdict: 'pass' }, { sessionRef: 'sess-rev' });
  f.force(`UPDATE task SET state = 'done', closed_at = '2030-01-01T00:00:00.000Z' WHERE id = ?`, tReview.task.id);

  // 4. Knowledge task (done, with session_ref) -> excluded
  const tKnow = f.runningRun();
  f.force('UPDATE task SET knowledge_json = ? WHERE id = ?', JSON.stringify({ kind: 'gate', proposal_id: 'p1' }), tKnow.task.id);
  f.force(`UPDATE run SET state = 'ended', exit_kind = 'completed', session_ref = 'sess-know' WHERE id = ?`, tKnow.run.id);
  f.force(`UPDATE task SET state = 'done', closed_at = '2030-01-02T00:00:00.000Z' WHERE id = ?`, tKnow.task.id);

  // 5. Ready (not done) task with session_ref -> excluded from listRecentResumableTasks, but isTaskResumable is true
  const tReady = f.runningRun();
  f.ledger.settleRun(tReady.run.id, 0, { status: 'done', summary: '待验收' }, { sessionRef: 'sess-ready' });
  assert.equal(f.ledger.isTaskResumable(tReady.task.id), true);
  assert.equal(f.ledger.isTaskResumable(tNoSession.task.id), false);

  const list = f.ledger.listRecentResumableTasks(f.projectId, 8);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    id: t1.task.id,
    title: t1.task.title,
    role_id: t1.task.role_id,
    executor: 'claude',
    machine_id: 'h1',
    closed_at: f.task(t1.task.id).closed_at,
    last_summary: '第一项总结',
    resumable: true,
  });
});
