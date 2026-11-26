// Guards against: Tasks leaving draft without acceptance criteria, cross-project
// parents, revisions that do not move when the work's definition moves, a Task
// waiting on two conditions at once, the work being redefined under a live
// executor, redispatch or abandonment while an executor may still be alive, and
// dispatch resumed after a restore before the count is confirmed, or the count
// confirmed and the pause changed while an inventory is still running.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DegradedError, InputError } from '../service/errors.ts';
import { DONE, fixture, LOGIN, USER } from './helpers.ts';

test('acceptance is optional when leaving draft or updating', (t) => {
  const f = fixture(t);
  const task = f.newTask({ acceptance: '  ' });
  f.ledger.queueTask(task.id, USER);
  assert.equal(f.task(task.id).state, 'queued');
  f.ledger.holdTask(task.id, '等等', USER);
  assert.equal(f.task(task.id).state, 'held');
  f.ledger.resumeTask(task.id, USER);
  assert.equal(f.task(task.id).state, 'queued');
  f.ledger.updateTask(task.id, { acceptance: '测试通过' }, USER);
  assert.equal(f.task(task.id).acceptance, '测试通过');
  f.ledger.updateTask(task.id, { acceptance: '' }, USER);
  assert.equal(f.task(task.id).acceptance, '');
});

test('parent must be in the same project', (t) => {
  const f = fixture(t);
  const parent = f.newTask();
  const other = f.ledger.createProject({ name: '别的项目' }, USER);
  assert.throws(
    () => f.ledger.createTask({ roleId: 'implement', projectId: other, parentId: parent.id, title: 't', goal: 'g' }, USER),
    InputError,
  );
  const child = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, parentId: parent.id, title: 't', goal: 'g' }, USER);
  assert.equal(child.parent_id, parent.id);
});

test('revision moves only with goal, scope or acceptance', (t) => {
  const f = fixture(t);
  const task = f.newTask();
  assert.equal(task.revision, 1);
  assert.equal(f.ledger.updateTask(task.id, { title: '新标题', priority: 5 }, USER).revision, 1);
  assert.equal(f.ledger.updateTask(task.id, { goal: '目标' }, USER).revision, 1);
  assert.equal(f.ledger.updateTask(task.id, { goal: '新目标' }, USER).revision, 2);
  assert.equal(f.ledger.updateTask(task.id, { scope: '新范围' }, USER).revision, 3);
  assert.equal(f.ledger.updateTask(task.id, { acceptance: '新验收' }, USER).revision, 4);
});

test('goal, scope and acceptance cannot change under a live Run', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const run = f.ledger.createRun(task.id, f.login, USER);
  const refused = () => {
    for (const patch of [{ goal: '新目标' }, { scope: '新范围' }, { acceptance: '新验收' }]) {
      assert.throws(() => f.ledger.updateTask(task.id, patch, USER), /先中断/);
    }
    assert.equal(f.task(task.id).revision, 1);
  };
  refused(); // launching
  f.ledger.markRunRunning(run.id);
  refused();
  f.ledger.markRunUnknown(run.id);
  refused();
  f.ledger.markRunStopping(run.id, USER);
  refused();

  f.ledger.settleRun(run.id, null, null);
  assert.equal(f.ledger.updateTask(task.id, { goal: '新目标' }, USER).revision, 2);
});

test('a stopping Task refuses revision even with no live Run', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  f.force(`UPDATE task SET state = 'stopping' WHERE id = ?`, task.id);
  assert.throws(() => f.ledger.updateTask(task.id, { goal: '新目标' }, USER), /先中断/);
});

test('title and priority can change while a Run is live', (t) => {
  const f = fixture(t);
  const { task } = f.runningRun();
  const after = f.ledger.updateTask(task.id, { title: '新标题', priority: 5, goal: task.goal }, USER);
  assert.equal(after.title, '新标题');
  assert.equal(after.priority, 5);
  assert.equal(after.revision, 1);
});

test('held needs a reason and returns only through resume', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  assert.throws(() => f.ledger.holdTask(task.id, ' ', USER), InputError);
  f.ledger.holdTask(task.id, '等上游', USER);
  assert.equal(f.task(task.id).reason, '等上游');
  assert.throws(() => f.ledger.createRun(task.id, f.login, USER), InputError);
  f.ledger.resumeTask(task.id, USER);
  assert.equal(f.task(task.id).state, 'queued');
  assert.equal(f.task(task.id).reason, null);
});

test('switching waiting condition clears the old one', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const approval = f.ledger.openApproval(task.id, [{ question: '选哪个？' }], USER);
  f.ledger.scheduleWake(task.id, '2030-01-01T09:00:00+08:00', USER);
  assert.equal(f.peek<{ state: string }>('SELECT state FROM approval WHERE id = ?', approval)[0]!.state, 'closed');
  assert.equal(f.task(task.id).state, 'waiting_timer');
  assert.equal(f.task(task.id).wake_at, '2030-01-01T01:00:00.000Z');

  f.ledger.openApproval(task.id, [{ question: '再问' }], USER);
  assert.equal(f.task(task.id).wake_at, null);
  assert.equal(f.task(task.id).state, 'waiting_person');

  f.ledger.holdTask(task.id, '先放着', USER);
  assert.equal(f.peek(`SELECT 1 FROM approval WHERE task_id = ? AND state = 'open'`, task.id).length, 0);
});

test('a second open question replaces the first', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const first = f.ledger.openApproval(task.id, [{ question: '一' }], USER);
  f.ledger.openApproval(task.id, [{ question: '二' }], USER);
  assert.equal(f.ledger.answerApproval(first, ['是'], 'user', 'console').status, 'closed');
  assert.equal(f.peek(`SELECT 1 FROM approval WHERE task_id = ? AND state = 'open'`, task.id).length, 1);
});

test('revising a Task closes its pending question instead of leaving it answerable', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const approval = f.ledger.openApproval(task.id, [{ question: '选哪个？' }], USER);
  f.ledger.updateTask(task.id, { goal: '新目标' }, USER);
  assert.equal(f.task(task.id).state, 'held');
  assert.equal(f.ledger.answerApproval(approval, ['甲'], 'user', 'console').status, 'closed');
  assert.equal(f.task(task.id).state, 'held');
});

test('revising a ready Task sends it back rather than accepting old work', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  f.ledger.updateTask(task.id, { acceptance: '更严的验收' }, USER);
  assert.equal(f.task(task.id).state, 'held');
  assert.throws(() => f.ledger.acceptTask(task.id, '看过了', USER), InputError);
});

test('accept needs ready and closes the Task (basis is optional)', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  assert.throws(() => f.ledger.acceptTask(task.id, '提前', USER), InputError);
  f.ledger.settleRun(run.id, 0, DONE);
  f.ledger.acceptTask(task.id, 'CI 绿，已读 diff', USER, { withoutReview: true });
  assert.equal(f.task(task.id).state, 'done');
  assert.ok(f.task(task.id).closed_at);
  const [row] = f.peek<{ detail_json: string }>(`SELECT detail_json FROM change WHERE action = 'task.accept'`);
  assert.match(row!.detail_json, /CI 绿/);
  assert.throws(() => f.ledger.updateTask(task.id, { goal: '再改' }, USER), InputError);
});

test('abandon is refused while a Run is live, then clears every waiting condition (reason is optional)', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  assert.throws(() => f.ledger.abandonTask(task.id, '不要了', USER), InputError);
  f.ledger.markRunStopping(run.id, USER);
  assert.throws(() => f.ledger.abandonTask(task.id, '不要了', USER), InputError);
  f.ledger.settleRun(run.id, null, null);
  f.ledger.scheduleWake(task.id, '2030-01-01T00:00:00Z', USER);
  f.ledger.abandonTask(task.id, '', USER);
  const after = f.task(task.id);
  assert.equal(after.state, 'abandoned');
  assert.equal(after.reason, '已放弃');
  assert.equal(after.wake_at, null);
  assert.ok(after.closed_at);
  assert.throws(() => f.ledger.resumeTask(task.id, USER), InputError);
});

test('pause blocks createRun and persists across reopen', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  f.ledger.setPause(true, USER);
  assert.deepEqual(f.ledger.dispatchConditions(), { paused: true, degraded: false, recovering: false, canDispatch: false });
  assert.throws(() => f.ledger.createRun(task.id, f.login, USER), InputError);
  assert.equal(f.task(task.id).state, 'queued');

  const reopened = f.open();
  assert.equal(reopened.dispatchConditions().paused, true);
  reopened.setPause(false, USER);
  assert.equal(reopened.createRun(task.id, f.login, USER).state, 'launching');
});

test('after a restore dispatch cannot be resumed until the count is confirmed; pausing always can', (t) => {
  const f = fixture(t);
  f.ledger.sealRestore('D:/backups/1');
  assert.throws(
    () => f.ledger.setPause(false, USER),
    (err: Error) => err instanceof InputError && err.message === '先确认清点完成，再恢复派发',
  );
  assert.equal(f.ledger.dispatchConditions().paused, true);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'pause.set'`).length, 0, '被拒绝的不留记录');
  f.ledger.setPause(true, USER);
  f.ledger.confirmRestore(USER);
  f.ledger.setPause(false, USER);
  assert.equal(f.ledger.dispatchConditions().canDispatch, true);
});

test('during an inventory the count cannot be confirmed nor the pause changed, and the inventory still writes', (t) => {
  const barrier = { recovering: false };
  const f = fixture(t, { recovery: { recovering: () => barrier.recovering } });
  const { run } = f.runningRun();
  f.ledger.sealRestore('D:/backups/1');
  barrier.recovering = true;
  for (const attempt of [() => f.ledger.confirmRestore(USER), () => f.ledger.setPause(false, USER), () => f.ledger.setPause(true, USER)]) {
    assert.throws(attempt, (err: Error) => err instanceof DegradedError && err.message === '正在清点，稍后再试');
  }
  assert.ok(f.ledger.getRestore(), '清点期间标记被删');
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action IN ('pause.set', 'ledger.restore_confirm')`).length, 0);
  f.ledger.markRunUnknown(run.id);
  assert.equal(f.run(run.id).state, 'unknown', '清点自己的写入不受影响');
  barrier.recovering = false;
  f.ledger.confirmRestore(USER);
  assert.equal(f.ledger.getRestore(), null);
});
