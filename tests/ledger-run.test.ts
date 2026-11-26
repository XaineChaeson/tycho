// Guards against: two live Runs on one Task, a snapshot prepared for an older
// revision being sent, a result being applied twice or from a stale Run, a stale
// revision advancing a Task or stranding it, a success receipt or a lost contact
// overriding a stop request, redispatch while the executor is unknown, and a
// settlement the Router never hears about, or a historical failure losing its reason on resume.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputError } from '../service/errors.ts';
import { DONE, fixture, LOGIN, USER } from './helpers.ts';

test('a Run without a receipt retains its settlement reason after the Task resumes', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, null, { reason: '需处理账号或更换账号' });
  f.ledger.resumeTask(task.id, USER);
  assert.equal(f.task(task.id).reason, null);
  assert.equal(JSON.parse(f.run(run.id).error_json!).reason, '需处理账号或更换账号');
  f.ledger.settleRun(run.id, 1, null, { reason: '迟到的失败' });
  assert.equal(JSON.parse(f.run(run.id).error_json!).reason, '需处理账号或更换账号');
});

test('createRun writes launching, revision and snapshot, and moves the Task', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const run = f.ledger.createRun(task.id, f.login, USER);
  assert.equal(run.state, 'launching');
  assert.equal(run.task_revision, 1);
  assert.equal(run.marker, `tycho-run:${run.id}`);
  assert.equal(JSON.parse(run.snapshot_json).brief, 'b');
  assert.equal(f.task(task.id).state, 'running');
});

test('createRun refuses a snapshot prepared for an older revision', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  f.ledger.addInput(task.id, '插话', USER);
  const prepared = f.task(task.id).revision;
  f.ledger.updateTask(task.id, { goal: '新目标' }, USER);

  assert.throws(() => f.ledger.createRun(task.id, { ...f.login, expectedRevision: prepared }, USER), InputError);
  assert.equal(f.count('run'), 0);
  assert.equal(f.task(task.id).state, 'queued');
  assert.equal(f.peek(`SELECT 1 FROM input WHERE state = 'queued'`).length, 1);

  const run = f.ledger.createRun(task.id, { ...f.login, expectedRevision: prepared + 1 }, USER);
  assert.equal(run.task_revision, prepared + 1);
});

test('createRun needs a queued Task', (t) => {
  const f = fixture(t);
  const task = f.newTask();
  assert.throws(() => f.ledger.createRun(task.id, f.login, USER), InputError);
  assert.equal(f.count('run'), 0);
});

test('second createRun on a running Task is refused by state', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  f.ledger.createRun(task.id, f.login, USER);
  assert.throws(() => f.ledger.createRun(task.id, f.login, USER), InputError);
  assert.equal(f.count('run'), 1);
});

test('the unique index still refuses a second live Run if the Task state is wrong', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  f.ledger.createRun(task.id, f.login, USER);
  f.ledger.addInput(task.id, '插话', USER);
  f.force(`UPDATE task SET state = 'queued' WHERE id = ?`, task.id);
  assert.throws(() => f.ledger.createRun(task.id, f.login, USER), /UNIQUE/);
  assert.equal(f.count('run'), 1);
  assert.equal(f.task(task.id).state, 'queued');
  assert.equal(f.peek(`SELECT 1 FROM input WHERE state = 'queued'`).length, 1);
});

test('a new Run is allowed once the previous one ended', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 1, null);
  f.ledger.resumeTask(task.id, USER);
  assert.equal(f.ledger.createRun(task.id, f.login, USER).state, 'launching');
});

const SETTLE_TABLE = [
  { name: '0 + done', exit: 0, receipt: DONE, state: 'ready', kind: 'completed' },
  { name: '0 + waiting ask', exit: 0, receipt: { status: 'waiting', ask: [{ question: '选？' }] }, state: 'waiting_person', kind: 'completed' },
  { name: '0 + waiting later', exit: 0, receipt: { status: 'waiting', later: { at: '2030-01-01T00:00:00Z', about: '查' } }, state: 'waiting_timer', kind: 'completed' },
  { name: '0 + waiting both', exit: 0, receipt: { status: 'waiting', ask: [{ question: '选？' }], later: { at: '2030-01-01T00:00:00Z' } }, state: 'held', kind: 'completed', reason: '等待要求冲突' },
  { name: '0 + waiting neither', exit: 0, receipt: { status: 'waiting', ask: [] }, state: 'held', kind: 'completed', reason: '等待要求冲突' },
  { name: '0 + waiting bad time', exit: 0, receipt: { status: 'waiting', later: { at: '明天' } }, state: 'held', kind: 'completed', reason: '等待要求冲突' },
  { name: '0 + failed', exit: 0, receipt: { status: 'failed', summary: '上游挂了' }, state: 'held', kind: 'failed', reason: '上游挂了' },
  { name: '0 + no receipt', exit: 0, receipt: null, state: 'held', kind: 'failed', reason: '回执无法解析' },
  { name: '0 + junk receipt', exit: 0, receipt: { status: '好的' }, state: 'held', kind: 'failed', reason: '回执无法解析' },
  { name: 'nonzero + done', exit: 2, receipt: DONE, state: 'held', kind: 'failed' },
];

for (const row of SETTLE_TABLE) {
  test(`settle table: ${row.name}`, (t) => {
    const f = fixture(t);
    const { task, run } = f.runningRun();
    const result = f.ledger.settleRun(run.id, row.exit, row.receipt);
    assert.deepEqual(result, { late: false, task_state: row.state });
    const after = f.task(task.id);
    assert.equal(after.state, row.state);
    if (row.reason) assert.equal(after.reason, row.reason);
    const ended = f.run(run.id);
    assert.equal(ended.state, 'ended');
    assert.equal(ended.exit_kind, row.kind);
    assert.equal(ended.exit_code, row.exit);
    assert.ok(ended.ended_at);
    assert.equal(ended.receipt_json, row.receipt === null ? null : JSON.stringify(row.receipt));
  });
}

test('the Runner can state why when the exit alone is not enough', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, null, { reason: '需处理账号或更换账号' });
  assert.equal(f.task(task.id).reason, '需处理账号或更换账号');
});

test('settle with waiting ask creates the Approval and its notification together', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, { status: 'waiting', ask: [{ question: '选？' }] });
  const [approval] = f.peek<{ id: string; run_id: string; task_revision: number; state: string }>(
    'SELECT * FROM approval WHERE task_id = ?',
    task.id,
  );
  assert.equal(approval!.run_id, run.id);
  assert.equal(approval!.state, 'open');
  const [note] = f.peek<{ kind: string; payload_json: string }>('SELECT * FROM outbox');
  assert.equal(note!.kind, 'approval');
  assert.equal(JSON.parse(note!.payload_json).approval_id, approval!.id);
});

test('settle with waiting later sets wake_at', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, { status: 'waiting', later: { at: '2030-01-01T08:00:00+08:00', about: '查' } });
  assert.equal(f.task(task.id).wake_at, '2030-01-01T00:00:00.000Z');
});

test('interrupted Run holds the Task and keeps any receipt', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, null, DONE, { kind: 'interrupted', reason: '超时' });
  assert.equal(f.task(task.id).state, 'held');
  assert.equal(f.task(task.id).reason, '超时');
  assert.equal(f.run(run.id).exit_kind, 'interrupted');
  assert.equal(f.run(run.id).receipt_json, JSON.stringify(DONE));
});

test('a lost Run sends its Task back to the queue by itself, with no one asked', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  const result = f.ledger.settleRun(run.id, null, null, { kind: 'lost' });
  assert.deepEqual(result, { late: false, task_state: 'queued' });
  assert.equal(f.run(run.id).exit_kind, 'lost');
  assert.equal(f.task(task.id).state, 'queued');
  assert.equal(f.count('outbox'), 0, '丢失后自动接续不推企微');
  assert.equal(f.ledger.createRun(task.id, f.login, USER).task_id, task.id);
});

test('stop intent is not overwritten by a success receipt', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.markRunStopping(run.id, USER);
  assert.equal(f.task(task.id).state, 'stopping');
  const result = f.ledger.settleRun(run.id, 0, DONE);
  assert.deepEqual(result, { late: false, task_state: 'held' });
  assert.equal(f.run(run.id).exit_kind, 'interrupted');
  assert.equal(f.run(run.id).receipt_json, JSON.stringify(DONE));
});

test('a stopping Run whose process vanished settles interrupted, not lost', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.markRunStopping(run.id, USER);
  f.ledger.settleRun(run.id, null, null, { kind: 'lost' });
  assert.equal(f.run(run.id).exit_kind, 'interrupted');
  assert.equal(f.task(task.id).state, 'held');
});

test('stop intent survives losing contact with the host', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.markRunStopping(run.id, USER);
  f.ledger.markRunUnknown(run.id);
  assert.equal(f.task(task.id).state, 'needs_verification');
  f.ledger.markRunRunning(run.id);
  assert.equal(f.run(run.id).state, 'stopping');
  assert.equal(f.task(task.id).state, 'stopping');
  f.ledger.settleRun(run.id, 0, DONE);
  assert.equal(f.task(task.id).state, 'held');
});

test('stop intent persisted through unknown decides the settlement directly', (t) => {
  for (const [exit, receipt, opts] of [
    [null, null, { kind: 'lost' }],
    [0, DONE, {}],
    [1, null, {}],
  ] as const) {
    const f = fixture(t);
    const { task, run } = f.runningRun();
    f.ledger.markRunStopping(run.id, USER);
    f.ledger.markRunUnknown(run.id);

    assert.deepEqual(f.ledger.settleRun(run.id, exit, receipt, opts), { late: false, task_state: 'held' });
    assert.equal(f.run(run.id).state, 'ended');
    assert.equal(f.run(run.id).exit_kind, 'interrupted');
    assert.equal(f.task(task.id).state, 'held');
  }
});

test('unknown without stop intent can still be settled as lost', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.markRunUnknown(run.id);
  f.ledger.settleRun(run.id, null, null, { kind: 'lost' });
  assert.equal(f.run(run.id).exit_kind, 'lost');
  assert.equal(f.task(task.id).state, 'queued');
});

test('unknown Run blocks resume, redispatch and abandon until the executor is accounted for', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.markRunUnknown(run.id);
  assert.equal(f.task(task.id).state, 'needs_verification');
  assert.equal(f.run(run.id).state, 'unknown');
  assert.throws(() => f.ledger.resumeTask(task.id, USER), InputError);
  assert.throws(() => f.ledger.abandonTask(task.id, '算了', USER), InputError);
  assert.throws(() => f.ledger.createRun(task.id, f.login, USER), InputError);

  f.ledger.markRunRunning(run.id);
  assert.equal(f.run(run.id).state, 'running');
  assert.equal(f.task(task.id).state, 'running');
  assert.deepEqual(f.ledger.settleRun(run.id, 0, DONE), { late: false, task_state: 'ready' });
});

test('unknown from launching can return to running, keeping the first start time', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const run = f.ledger.createRun(task.id, f.login, USER);
  f.ledger.markRunUnknown(run.id);
  f.ledger.markRunRunning(run.id, { sessionRef: 's1' });
  assert.equal(f.run(run.id).state, 'running');
  assert.equal(f.run(run.id).session_ref, 's1');
  const started = f.run(run.id).started_at;
  assert.ok(started);
  f.ledger.markRunUnknown(run.id);
  f.ledger.markRunRunning(run.id);
  assert.equal(f.run(run.id).started_at, started);
  assert.equal(f.run(run.id).session_ref, 's1');
});

test('Run state transitions refuse an ended Run', (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  assert.throws(() => f.ledger.markRunRunning(run.id), InputError);
  assert.throws(() => f.ledger.markRunUnknown(run.id), InputError);
  assert.throws(() => f.ledger.markRunStopping(run.id, USER), InputError);
});

// The three settlement checks of §3, one case each.

test('settle check 1: a Run already ended keeps its first result', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  const taskBefore = f.task(task.id);
  const second = { status: 'failed', summary: '迟到的结果' };

  assert.deepEqual(f.ledger.settleRun(run.id, 1, second), { late: true, reason: 'run_ended' });
  assert.deepEqual(f.task(task.id), taskBefore);
  const after = f.run(run.id);
  assert.equal(after.exit_code, 0);
  assert.equal(after.receipt_json, JSON.stringify(DONE));
  const late = JSON.parse(after.error_json!).late_results;
  assert.equal(late.length, 1);
  assert.deepEqual(late[0].receipt, second);
});

// updateTask refuses a revision under a live Run, so these force the mismatch.
const reviseUnderRun = (f: ReturnType<typeof fixture>, taskId: string) =>
  f.force(`UPDATE task SET revision = revision + 1 WHERE id = ?`, taskId);

test('settle check 2: a receipt for an old revision holds the Task instead of advancing it', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  reviseUnderRun(f, task.id);

  assert.deepEqual(f.ledger.settleRun(run.id, 0, DONE), { late: true, reason: 'revision' });
  assert.equal(f.task(task.id).state, 'held');
  assert.equal(f.task(task.id).reason, '执行结果属于旧修订');
  const after = f.run(run.id);
  assert.equal(after.state, 'ended');
  assert.equal(after.exit_code, 0);
  assert.equal(after.receipt_json, JSON.stringify(DONE));
  assert.equal(f.count('approval'), 0);
});

test('settle check 2: a stale waiting receipt opens no question and sets no timer', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  reviseUnderRun(f, task.id);
  f.ledger.settleRun(run.id, 0, { status: 'waiting', ask: [{ question: '选？' }] });
  assert.equal(f.count('approval'), 0);
  assert.equal(f.count('outbox'), 0);
  assert.equal(f.task(task.id).wake_at, null);
});

test('a Task held by a stale result can go again on the new revision', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  reviseUnderRun(f, task.id);
  f.ledger.settleRun(run.id, 0, DONE);
  f.ledger.resumeTask(task.id, USER);
  assert.equal(f.ledger.createRun(task.id, { ...f.login, expectedRevision: 2 }, USER).task_revision, 2);
});

test('a repeated settlement of an old revision leaves the Task where the first put it', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  reviseUnderRun(f, task.id);
  f.ledger.settleRun(run.id, 0, DONE);
  f.ledger.resumeTask(task.id, USER);
  assert.deepEqual(f.ledger.settleRun(run.id, 0, DONE), { late: true, reason: 'run_ended' });
  assert.equal(f.task(task.id).state, 'queued');
});

test('an unknown Task whose Run ends on an old revision is held, not left waiting for a Run that is gone', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.markRunUnknown(run.id);
  reviseUnderRun(f, task.id);
  assert.deepEqual(f.ledger.settleRun(run.id, null, null, { kind: 'lost' }), { late: true, reason: 'revision' });
  assert.equal(f.task(task.id).state, 'held');
  assert.equal(f.run(run.id).state, 'ended');
});

test('holdTask cannot be used on a Task with a live Run', (t) => {
  const f = fixture(t);
  const { task } = f.runningRun();
  assert.throws(() => f.ledger.holdTask(task.id, '先放着', USER), InputError);
  assert.equal(f.task(task.id).state, 'running');
});

test('settle check 3: a Task that is not waiting on the Run does not move', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  // No operation leaves a Task here with a live Run; the check is for the day one does.
  f.force(`UPDATE task SET state = 'held', reason = '别的原因' WHERE id = ?`, task.id);
  const taskBefore = f.task(task.id);

  assert.deepEqual(f.ledger.settleRun(run.id, 0, DONE), { late: true, reason: 'task_state' });
  assert.deepEqual(f.task(task.id), taskBefore);
  assert.equal(f.run(run.id).state, 'ended');
  assert.equal(f.run(run.id).receipt_json, JSON.stringify(DONE));
});

test('a Task waiting on a Run out of contact takes the result of that Run when it comes', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.markRunUnknown(run.id);
  assert.deepEqual(f.ledger.settleRun(run.id, 0, DONE), { late: false, task_state: 'ready' });
  assert.equal(f.task(task.id).state, 'ready');
});

interface InternalMessage {
  channel: string;
  external_id: string;
  direction: string;
  actor: string;
  state: string;
  text: string;
}

const internalMessages = (f: ReturnType<typeof fixture>) =>
  f.peek<InternalMessage>(`SELECT * FROM message WHERE channel = 'internal' ORDER BY rowid`);
const detailOf = (message: InternalMessage) => JSON.parse(message.text.slice(message.text.indexOf('\n') + 1));

test('a settlement leaves a received internal message for the Router', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  const [message, ...rest] = internalMessages(f);
  assert.deepEqual(rest, []);
  assert.equal(message!.external_id, `run:${run.id}`);
  assert.equal(message!.direction, 'in');
  assert.equal(message!.actor, 'runner');
  assert.equal(message!.state, 'received');
  const detail = detailOf(message!);
  assert.equal(detail.task_id, task.id);
  assert.equal(detail.run_id, run.id);
  assert.equal(detail.exit_kind, 'completed');
  assert.equal(detail.task_state, 'ready');
  assert.deepEqual(detail.receipt, DONE);
});

test('a late settlement also tells the Router, with why it was late', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  reviseUnderRun(f, task.id);
  f.ledger.settleRun(run.id, 0, DONE);
  const [message] = internalMessages(f);
  assert.equal(message!.external_id, `run:${run.id}`);
  assert.equal(detailOf(message!).late_reason, 'revision');
  assert.equal(detailOf(message!).task_state, 'held');
});

test('every repeated settlement gets its own internal message', (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  f.ledger.settleRun(run.id, 1, null);
  f.ledger.settleRun(run.id, 2, null);
  const messages = internalMessages(f);
  assert.deepEqual(
    messages.map((message) => message.external_id),
    [`run:${run.id}`, `run:${run.id}:late:1`, `run:${run.id}:late:2`],
  );
  assert.equal(messages.every((message) => message.state === 'received'), true);
  assert.equal(detailOf(messages[2]!).exit_code, 2);
  assert.equal(detailOf(messages[2]!).late_reason, 'run_ended');
});

test('settling an unknown Id is a caller error', (t) => {
  const f = fixture(t);
  assert.throws(() => f.ledger.settleRun('nope', 0, DONE), InputError);
});

test('getRun and listActiveRuns read without writing, and ended Runs drop out', (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  const before = f.dump();
  assert.equal(f.ledger.getRun(run.id).id, run.id);
  assert.deepEqual(f.ledger.listActiveRuns().map((each) => each.id), [run.id]);
  assert.equal(f.ledger.getTask(run.task_id).id, run.task_id);
  assert.deepEqual(f.dump(), before);

  f.ledger.settleRun(run.id, 0, DONE);
  assert.deepEqual(f.ledger.listActiveRuns(), []);
  assert.throws(() => f.ledger.getRun('nope'), InputError);
  assert.throws(() => f.ledger.getTask('nope'), InputError);
});

test('touchRun records progress without a change row and leaves ended Runs alone', (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  const changes = f.count('change');
  f.ledger.touchRun(run.id, '2026-11-04T10:00:00.000Z');
  assert.equal(f.run(run.id).last_progress_at, '2026-11-04T10:00:00.000Z');
  assert.equal(f.count('change'), changes);

  f.ledger.settleRun(run.id, 0, DONE);
  f.ledger.touchRun(run.id, '2026-11-04T11:00:00.000Z');
  assert.equal(f.run(run.id).last_progress_at, '2026-11-04T10:00:00.000Z');
});

test('settleRun keeps the session reference a later resume needs', (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE, { sessionRef: 's-1' });
  assert.equal(f.run(run.id).session_ref, 's-1');
});

test('a settlement without a session reference keeps the one already recorded', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const run = f.ledger.createRun(task.id, f.login, USER);
  f.ledger.markRunRunning(run.id, { sessionRef: 's-0' });
  f.ledger.settleRun(run.id, 0, DONE);
  assert.equal(f.run(run.id).session_ref, 's-0');
});

test('a settlement with residue records it on the Run and tells the router', (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE, { residue: true });
  assert.equal(JSON.parse(f.run(run.id).error_json!).residue, true);
  const [note] = f.peek<{ text: string }>(`SELECT text FROM message WHERE channel = 'internal'`);
  assert.match(note!.text, /仍有后台进程，已清理/);
});
