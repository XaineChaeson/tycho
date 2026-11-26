// Guards against: carrying on with side effects after the ledger stopped
// accepting writes, reporting success for something not persisted, losing the
// error along with the database, leaving degraded mode before writes work, and
// a failed rollback leaving a dangling transaction later writes would join, or a failed
// reopen or probe being taken for a recovery.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCHEMA_VERSION } from '../service/db.ts';
import { DegradedError, InputError } from '../service/errors.ts';
import { DONE, fixture, LOGIN, USER } from './helpers.ts';

function degradedFixture(t: Parameters<typeof fixture>[0]) {
  const f = fixture(t);
  const task = f.queuedTask();
  const { run } = f.runningRun();
  f.ledger.close();
  const ledger = f.open({ readOnly: true });
  return { f, ledger, task, run };
}

test('a write failure enters degraded mode and is logged outside the database', (t) => {
  const { f, ledger, task } = degradedFixture(t);
  assert.throws(() => ledger.holdTask(task.id, '挂起', USER), DegradedError);
  assert.equal(f.task(task.id).state, 'queued');
  assert.equal(ledger.dispatchConditions().degraded, true);
  assert.equal(ledger.dispatchConditions().canDispatch, false);
  assert.match(readFileSync(join(f.dir, 'degraded.log'), 'utf8'), /readonly/);
});

test('degraded mode refuses dispatch, control operations and outbox sends', (t) => {
  const { f, ledger, task, run } = degradedFixture(t);
  assert.throws(() => ledger.setPause(true, USER), DegradedError);
  const refused = [
    () => ledger.createRun(task.id, f.login, USER),
    () => ledger.holdTask(task.id, '挂起', USER),
    () => ledger.abandonTask(task.id, '放弃', USER),
    () => ledger.resumeTask(task.id, USER),
    () => ledger.addInput(task.id, '插话', USER),
    () => ledger.scheduleWake(task.id, '2030-01-01T00:00:00Z', USER),
    () => ledger.answerApproval('x', ['a'], 'user', 'wecom'),
    () => ledger.settleRun(run.id, 0, DONE),
    () => ledger.fireDueWakes(),
    () => ledger.outbox.enqueue('wecom', 'note', {}),
    () => ledger.outbox.takeDue(),
  ];
  for (const op of refused) assert.throws(op, DegradedError);
});

test('recover probes a write, then normal service resumes', (t) => {
  const { f, ledger, task } = degradedFixture(t);
  assert.throws(() => ledger.holdTask(task.id, '挂起', USER), DegradedError);
  assert.equal(ledger.recover(), true);
  assert.equal(ledger.dispatchConditions().degraded, false);
  assert.equal(f.peek(`SELECT 1 FROM setting WHERE key = 'degraded.probe'`).length, 1);
  assert.equal(ledger.createRun(task.id, f.login, USER).state, 'launching');
  assert.match(readFileSync(join(f.dir, 'degraded.log'), 'utf8'), /解除降级/);
});

test('a failed rollback degrades, retires the connection and logs both errors', (t) => {
  let failRollback = false;
  const f = fixture(t, {
    testHooks: {
      beforeRollback() {
        if (failRollback) throw new Error('rollback boom');
      },
    },
  });
  const task = f.newTask();
  failRollback = true;
  // queueTask has written the Task when the unknown message id fails its change row.
  assert.throws(() => f.ledger.queueTask(task.id, { actor: 'user', messageId: 'no-such-message' }), DegradedError);
  failRollback = false;

  const log = readFileSync(join(f.dir, 'degraded.log'), 'utf8');
  assert.match(log, /rollback boom/);
  assert.match(log, /FOREIGN KEY/);
  assert.deepEqual(f.ledger.dispatchConditions(), { paused: null, degraded: true, recovering: false, canDispatch: false });

  // Nothing joins the dangling transaction and reports success.
  assert.throws(() => f.ledger.queueTask(task.id, USER), DegradedError);
  assert.throws(() => f.ledger.holdTask(task.id, '挂起', USER), DegradedError);
  assert.equal(f.task(task.id).state, 'draft');
  // The abandoned transaction no longer holds the write lock.
  f.force(`UPDATE task SET priority = 7 WHERE id = ?`, task.id);

  assert.equal(f.ledger.recover(), true);
  f.ledger.queueTask(task.id, USER);
  assert.equal(f.task(task.id).state, 'queued');
  assert.equal(f.ledger.dispatchConditions().paused, false);
});

test('recover on a healthy ledger is a no-op', (t) => {
  const f = fixture(t);
  assert.equal(f.ledger.recover(), true);
  assert.equal(f.peek(`SELECT 1 FROM setting WHERE key = 'degraded.probe'`).length, 0);
});

test('a caller mistake does not degrade the service', (t) => {
  const f = fixture(t);
  assert.throws(() => f.ledger.holdTask('nope', '挂起', USER), InputError);
  assert.throws(() => f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: 't', goal: 'g' }, { actor: 'u', messageId: 'x' }));
  assert.equal(f.ledger.dispatchConditions().degraded, false);
});

test('a reopen that fails leaves the service degraded, and a later one can still succeed', (t) => {
  const { f, ledger, task } = degradedFixture(t);
  assert.throws(() => ledger.holdTask(task.id, '挂起', USER), DegradedError);
  f.force(`UPDATE setting SET value_json = '999' WHERE key = 'schema_version'`);
  assert.equal(ledger.recover(), false);
  assert.equal(ledger.dispatchConditions().degraded, true);
  assert.throws(() => ledger.holdTask(task.id, '挂起', USER), DegradedError);
  assert.match(readFileSync(join(f.dir, 'degraded.log'), 'utf8'), /探测写入失败.*schema/);

  f.force(`UPDATE setting SET value_json = ? WHERE key = 'schema_version'`, String(SCHEMA_VERSION));
  assert.equal(ledger.recover(), true);
  ledger.holdTask(task.id, '挂起', USER);
  assert.equal(f.task(task.id).state, 'held');
});

test('a probe that cannot write leaves the service degraded', (t) => {
  let failing = false;
  const f = fixture(t, {
    testHooks: {
      beforeCommit() {
        if (failing) throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
      },
    },
  });
  const task = f.queuedTask();
  failing = true;
  assert.throws(() => f.ledger.holdTask(task.id, '挂起', USER), DegradedError);
  assert.equal(f.ledger.recover(), false);
  assert.equal(f.ledger.dispatchConditions().degraded, true);
  assert.equal(f.peek(`SELECT 1 FROM setting WHERE key = 'degraded.probe'`).length, 0);
  assert.match(readFileSync(join(f.dir, 'degraded.log'), 'utf8'), /探测写入失败/);
  failing = false;
  assert.equal(f.ledger.recover(), true);
});
