// Guards against: a crash between writing a Run's result and moving its Task
// leaving the ledger half-settled. After reopening, the Run must still be
// unsettled and the Task unchanged, so the Runner can settle it again. Also the event
// for the Router being lost while the state change it reports survives, which would
// leave the Router never hearing of it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { DONE, fixture, USER } from './helpers.ts';

test('an exception between the Run write and the Task write rolls both back', (t) => {
  const f = fixture(t, {
    testHooks: {
      afterSettleRunWrite() {
        throw new Error('injected crash');
      },
    },
  });
  const { task, run } = f.runningRun();
  const changes = f.count('change');
  const messages = f.count('message');
  assert.throws(() => f.ledger.settleRun(run.id, 0, DONE), /injected crash/);
  f.ledger.close();

  const after = f.run(run.id);
  assert.equal(after.state, 'running');
  assert.equal(after.exit_code, null);
  assert.equal(after.receipt_json, null);
  assert.equal(f.task(task.id).state, 'running');
  assert.equal(f.count('change'), changes);
  assert.equal(f.count('message'), messages);

  const reopened = f.open();
  assert.deepEqual(reopened.settleRun(run.id, 0, DONE), { late: false, task_state: 'ready' });
});

test('a process killed in the same place loses the half-written transaction', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.close();

  const ledgerUrl = new URL('../service/ledger.ts', import.meta.url).href;
  const script = `
    import { openLedger } from ${JSON.stringify(ledgerUrl)};
    const ledger = openLedger(${JSON.stringify(resolve(f.path))}, {
      testHooks: { afterSettleRunWrite: () => process.kill(process.pid, 'SIGKILL') },
    });
    ledger.settleRun(${JSON.stringify(run.id)}, 0, { status: 'done', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8' });
  // A child that failed to load would also exit non-zero, without reaching the hook.
  assert.equal(child.stderr, '');
  assert.notEqual(child.status, 0);

  const reopened = f.open();
  assert.equal(f.run(run.id).state, 'running');
  assert.equal(f.task(task.id).state, 'running');
  assert.deepEqual(reopened.settleRun(run.id, 0, DONE), { late: false, task_state: 'ready' });
});

test('a settlement whose internal message cannot be written rolls back as a whole', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  // Takes the (channel, external_id) the settlement is about to use.
  f.ledger.receiveMessage({ channel: 'internal', externalId: `run:${run.id}`, actor: 'runner', text: '占位' });
  const before = f.dump();
  assert.throws(() => f.ledger.settleRun(run.id, 0, DONE), /UNIQUE/);
  assert.deepEqual(f.dump(), before);
  assert.equal(f.run(run.id).state, 'running');
  assert.equal(f.task(task.id).state, 'running');
});

test('an insertion whose internal message cannot be written leaves no Input behind', (t) => {
  let collide = false;
  const f = fixture(t, {
    testHooks: {
      beforeCommit(actions) {
        if (collide && actions.includes('input.add')) throw new Error('internal message failed');
      },
    },
  });
  const task = f.queuedTask();
  collide = true;
  assert.throws(() => f.ledger.addInput(task.id, '插话', USER), /internal message failed/);
  assert.equal(f.count('input'), 0);
  assert.equal(f.peek(`SELECT 1 FROM message WHERE channel = 'internal'`).length, 0);
});
